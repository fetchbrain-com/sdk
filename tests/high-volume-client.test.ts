/**
 * Client behaviour under the conditions measured against the real API
 * (2026-11-22): recall server time 205-490ms plus network RTT, account-level
 * 4xx responses (403 hard cap), oversized learn entries, and shutdown flushes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchBrainClient } from "../src/client";
import { LearnBatcher } from "../src/batch";

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function stubApi(handler: (path: string, body: any) => Promise<Response> | Response) {
  const calls: { path: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, body });
      return handler(path, body);
    }),
  );
  return calls;
}

const recallOk = (body: any) =>
  new Response(JSON.stringify({ known: [], unknown: body.items.map((i: any) => i.ref) }), { status: 200 });

describe("high-volume client behaviour", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("a recall answered in 900ms (measured real-world range) is not treated as an outage", async () => {
    // Honour the abort signal like real fetch does, so the client's timeout is exercised.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (url: string | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const t = setTimeout(() => resolve(recallOk(JSON.parse(String(init!.body)))), 900);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      ),
    );
    const c = new FetchBrainClient({ apiKey: "fb_t", baseUrl: "http://x", batch: { maxSize: 1, maxWait: 0 } });
    const r = await c.recall({ url: "https://p/slow" });
    expect(r.fallback).toBeUndefined();
    expect(r.known).toBe(false);
  });

  it("recall 4xx (403 hard cap) never opens the breaker, so learns still reach the API", async () => {
    const calls = stubApi((path) =>
      path === "/v1/recall"
        ? new Response(JSON.stringify({ error: "limit", code: "HARD_CAP_EXCEEDED" }), { status: 403 })
        : new Response(JSON.stringify({ learned: 1, status: "success" }), { status: 201 }),
    );
    const c = new FetchBrainClient({ apiKey: "fb_t", baseUrl: "http://x", batch: { maxSize: 1, maxWait: 0 } });
    for (let i = 0; i < 5; i++) expect((await c.recall({ url: `https://p/${i}` })).fallback).toBe(true);
    expect(c.getCircuitState()).toMatchObject({ state: "closed", failures: 0 });
    expect((await c.learn({ url: "https://p/new" }, { a: 1 })).status).toBe("success");
    expect(calls.filter((x) => x.path === "/v1/learn").length).toBe(1);
  });

  it("recall 5xx still opens the breaker", async () => {
    stubApi(() => new Response("{}", { status: 500 }));
    const c = new FetchBrainClient({ apiKey: "fb_t", baseUrl: "http://x", batch: { maxSize: 1, maxWait: 0 } });
    for (let i = 0; i < 3; i++) await c.recall({ url: `https://p/${i}` });
    expect(c.getCircuitState().state).toBe("open");
  });

  it("drops a learn entry over the API's 100KB cap instead of losing the whole batch", async () => {
    const calls = stubApi((_p, body) =>
      new Response(JSON.stringify({ learned: body.entries.length, status: "success" }), { status: 201 }),
    );
    const c = new FetchBrainClient({ apiKey: "fb_t", baseUrl: "http://x", batch: { maxSize: 3, maxWait: 5 } });
    const big = { blob: "x".repeat(101 * 1024) };
    await Promise.all([
      c.learn({ url: "https://p/a" }, { a: 1 }),
      c.learn({ url: "https://p/big" }, big),
      c.learn({ url: "https://p/b" }, { b: 1 }),
    ]);
    const sent = calls.filter((x) => x.path === "/v1/learn").flatMap((x) => x.body.entries);
    expect(sent.map((e: any) => e.request.url).sort()).toEqual(["https://p/a", "https://p/b"]);
  });
});

describe("batchers at shutdown and under concurrency", () => {
  it("forceFlush waits for flushes already in flight (no learns lost at shutdown)", async () => {
    const sent: number[] = [];
    let call = 0;
    const b = new LearnBatcher(
      async (entries) => {
        // The first (auto-triggered) batch is slow; the one forceFlush starts is fast.
        await new Promise((r) => setTimeout(r, call++ === 0 ? 120 : 1));
        sent.push(entries.length);
        return { learned: entries.length, status: "success" } as any;
      },
      { maxSize: 2, maxWait: 10_000 },
      silent as any,
    );
    for (let i = 0; i < 5; i++) void b.learn({ url: `https://p/${i}` }, { i });
    await b.forceFlush();
    expect(sent.reduce((a, n) => a + n, 0)).toBe(5);
    expect(b.getQueueSize()).toBe(0);
  });
});

describe("oversized pages and the learn backlog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses an oversized page on its own result, warns once, and never sends it", async () => {
    const calls = stubApi((_p, body) =>
      new Response(JSON.stringify({ learned: body.entries.length, status: "success" }), { status: 201 }),
    );
    const warn = vi.fn();
    const c = new FetchBrainClient({ apiKey: "fb_t", baseUrl: "http://x", batch: { maxSize: 3, maxWait: 5 } });
    (c as any).logger = { ...silent, warn };
    // A listing page: 100 records of ~1.5KB, 150KB together — each record fits alone.
    const listing = Array.from({ length: 100 }, (_, i) => ({ i, blob: "x".repeat(1500) }));

    const [small, big, big2] = await Promise.all([
      c.learn({ url: "https://p/a" }, { a: 1 }),
      c.learn({ url: "https://p/listing" }, listing),
      c.learn({ url: "https://p/listing2" }, listing),
    ]);

    expect(small.status).toBe("success");
    expect(big).toEqual({ status: "rejected", learned: 0, errors: ["too_large"] });
    expect(big2.status).toBe("rejected");
    expect(warn).toHaveBeenCalledTimes(1); // once, not per page
    expect(String(warn.mock.calls[0][0])).toMatch(/not learned/);
    const sent = calls.filter((x) => x.path === "/v1/learn").flatMap((x) => x.body.entries);
    expect(sent.map((e: any) => e.request.url)).toEqual(["https://p/a"]);
  });

  it("checks the size after extractForLearning, so trimming fields makes a page learnable", async () => {
    const calls = stubApi((_p, body) =>
      new Response(JSON.stringify({ learned: body.entries.length, status: "success" }), { status: 201 }),
    );
    const c = new FetchBrainClient({
      apiKey: "fb_t",
      baseUrl: "http://x",
      batch: { maxSize: 1, maxWait: 0 },
      extractForLearning: (d: any) => ({ i: d.i }),
    });
    const listing = Array.from({ length: 100 }, (_, i) => ({ i, blob: "x".repeat(1500) }));
    const res = await c.learn({ url: "https://p/listing" }, listing);
    expect(res.status).toBe("success");
    const sent = calls.filter((x) => x.path === "/v1/learn").flatMap((x) => x.body.entries);
    expect(sent[0].data).toHaveLength(100);
    expect(sent[0].data[0]).toEqual({ i: 0 });
  });
});

describe("LearnBatcher concurrency and backlog caps", () => {
  it(`never has more than ${3} learn requests in flight, and still drains everything`, async () => {
    const { MAX_CONCURRENT_LEARN_FLUSHES } = await import("../src/batch");
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const executor = vi.fn(async (entries: unknown[]) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => release.push(r));
      inFlight--;
      return { learned: entries.length, status: "success" as const };
    });
    const b = new LearnBatcher(executor, { maxSize: 10, maxWait: 1 }, silent as any);

    const all = Array.from({ length: 100 }, (_, i) => b.learn({ url: `https://p/${i}` }, { i }));
    await new Promise((r) => setTimeout(r, 20));
    expect(executor).toHaveBeenCalledTimes(MAX_CONCURRENT_LEARN_FLUSHES);

    // Release flushes as they arrive until the whole queue is sent.
    const done = b.forceFlush();
    while (executor.mock.calls.length < 10 || release.length > 0) {
      release.shift()?.();
      await new Promise((r) => setTimeout(r, 1));
    }
    await done;
    const results = await Promise.all(all);
    expect(results.every((r) => r.status === "success")).toBe(true);
    expect(executor).toHaveBeenCalledTimes(10);
    expect(peak).toBe(MAX_CONCURRENT_LEARN_FLUSHES);
  });

  it("drops learns past the backlog cap instead of holding them in memory", async () => {
    const { MAX_QUEUED_LEARNS } = await import("../src/batch");
    const executor = vi.fn(() => new Promise<never>(() => {})); // API never answers
    const b = new LearnBatcher(executor as any, { maxSize: 50, maxWait: 1 }, silent as any);

    for (let i = 0; i < 3 * 50 + MAX_QUEUED_LEARNS; i++) void b.learn({ url: `https://p/${i}` }, { i });
    await new Promise((r) => setTimeout(r, 5)); // 3 batches in flight, the rest queued
    expect(b.isBacklogFull()).toBe(true);
    expect(await b.learn({ url: "https://p/over" }, {})).toEqual({
      status: "rejected",
      learned: 0,
      errors: ["backlog_full"],
    });
    // waitForRoom is bounded: a stuck API costs at most the timeout.
    const t0 = Date.now();
    expect(await b.waitForRoom(30)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("waitForRoom resolves as soon as a settling flush makes room", async () => {
    const { MAX_QUEUED_LEARNS } = await import("../src/batch");
    const release: (() => void)[] = [];
    const executor = vi.fn(async (entries: unknown[]) => {
      await new Promise<void>((r) => release.push(r));
      return { learned: entries.length, status: "success" as const };
    });
    const b = new LearnBatcher(executor, { maxSize: 50, maxWait: 1 }, silent as any);
    for (let i = 0; i < 3 * 50 + MAX_QUEUED_LEARNS; i++) void b.learn({ url: `https://p/${i}` }, { i });
    await new Promise((r) => setTimeout(r, 5));
    expect(b.isBacklogFull()).toBe(true);

    const waiting = b.waitForRoom(5_000);
    release.shift()!(); // one batch settles → the next batch starts → 50 slots free
    expect(await waiting).toBe(true);
    expect(b.isBacklogFull()).toBe(false);
    release.splice(0).forEach((r) => r());
  });
});

describe("refusals that stop or pause calls", () => {
  afterEach(() => vi.unstubAllGlobals());
  const unknownAll = (body: any) =>
    new Response(JSON.stringify({ known: [], unknown: body.items.map((i: any) => i.ref) }), { status: 200 });

  it("401 (key invalid or revoked): warns once, then recalls and learns stop calling the API", async () => {
    const calls = stubApi(() => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    const warn = vi.fn();
    const c = new FetchBrainClient({ apiKey: "fb_t", baseUrl: "http://x", batch: { maxSize: 1, maxWait: 0 } });
    (c as any).logger = { ...silent, warn };

    expect(await c.recall({ url: "https://p/1" })).toEqual({ known: false, fallback: true });
    const afterFirst = calls.length;
    expect(await c.recall({ url: "https://p/2" })).toEqual({ known: false, fallback: true });
    expect((await c.recallBulk([{ url: "https://p/3" }]))[0]).toEqual({ known: false, fallback: true });
    expect((await c.learn({ url: "https://p/4" }, { a: 1 })).status).toBe("rejected");
    expect(calls.length).toBe(afterFirst); // nothing more sent
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/401/);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/fb_t/); // never print the key
    expect(c.getCircuitState().state).toBe("closed"); // a 4xx is not an outage
  });

  it("429 on recall: pauses recalls for Retry-After, then resumes", async () => {
    let limited = true;
    const calls = stubApi((_p, body) =>
      limited
        ? new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "Retry-After": "2" } })
        : unknownAll(body),
    );
    const c = new FetchBrainClient({ apiKey: "fb_t", baseUrl: "http://x", batch: { maxSize: 1, maxWait: 0 } });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);

    expect((await c.recall({ url: "https://p/1" })).fallback).toBe(true);
    const afterFirst = calls.length;
    limited = false;
    expect((await c.recall({ url: "https://p/2" })).fallback).toBe(true); // paused: no call
    expect(calls.length).toBe(afterFirst);

    clock.mockReturnValue(now + 2_100);
    expect(await c.recall({ url: "https://p/3" })).toEqual({ known: false });
    expect(calls.length).toBe(afterFirst + 1);
    clock.mockRestore();
  });
});
