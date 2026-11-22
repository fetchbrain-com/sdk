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
