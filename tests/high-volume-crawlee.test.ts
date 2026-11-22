/**
 * High-volume behaviour against REAL Crawlee, with a fake API that has real
 * memory (learn writes, recall reads) so run 1 -> run 2 behaves like production.
 *
 * Each case reproduces a defect measured end-to-end against the real API on
 * 2026-11-22:
 *  - a page that pushes N items was remembered as 1 (500 learned -> 100 recalled);
 *  - pushData waited for the learn round-trip (1000-page first run 52s vs ~1s);
 *  - lists over the 5000-entry pre-recall stash evicted payloads before their
 *    requests ran, forcing a second (double-billed) recall per evicted request;
 *  - addRequests pre-recalled the WHOLE list before enqueuing anything.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import { CheerioCrawler, Configuration } from "crawlee";
import { FetchBrain, pushData as standalonePushData } from "../src/enhance";

type Data = Record<string, unknown> | Record<string, unknown>[];

function memoryApi(opts: { learnDelayMs?: number } = {}) {
  const memory = new Map<string, Data>();
  const calls: { path: string; body: any; at: number }[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, at: Date.now() });
    if (path === "/v1/recall") {
      const known: { ref: string; data: Data }[] = [];
      const unknown: string[] = [];
      for (const it of body.items) {
        const d = memory.get(it.request.uniqueKey ?? it.request.url);
        if (d) known.push({ ref: it.ref, data: d });
        else unknown.push(it.ref);
      }
      return new Response(JSON.stringify({ known, unknown }), { status: 200 });
    }
    if (path === "/v1/learn") {
      if (opts.learnDelayMs) await new Promise((r) => setTimeout(r, opts.learnDelayMs));
      for (const e of body.entries) memory.set(e.request.uniqueKey ?? e.request.url, e.data);
      return new Response(JSON.stringify({ learned: body.entries.length, status: "success" }), { status: 201 });
    }
    return new Response("{}", { status: 200 });
  };
  return {
    memory,
    calls,
    impl,
    learns: () => calls.filter((c) => c.path === "/v1/learn").flatMap((c) => c.body.entries),
    recallCalls: () => calls.filter((c) => c.path === "/v1/recall"),
  };
}

let server: http.Server;
let base = "";
let hits = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++;
    const id = (req.url ?? "").split("/").pop();
    res.setHeader("content-type", "text/html");
    const lis = Array.from({ length: 5 }, (_, i) => `<li data-sku="${id}-${i}">x</li>`).join("");
    res.end(`<html><body><h1>${id}</h1><ul>${lis}</ul></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise((r) => server.close(() => r(undefined))));
afterEach(() => vi.restoreAllMocks());

function crawler(handler: (ctx: any) => Promise<void>, fb: Parameters<typeof FetchBrain.enhance>[1]) {
  const c = new CheerioCrawler(
    { maxConcurrency: 20, maxRequestRetries: 0, requestHandler: handler },
    new Configuration({ persistStorage: false, purgeOnStart: true }),
  );
  return FetchBrain.enhance(c, { apiKey: "fb_t", baseUrl: "http://fb", ...fb });
}

const listingHandler = async ({ $, request, pushData }: any) => {
  for (const el of $("li").toArray()) await pushData({ sku: $(el).attr("data-sku"), page: request.uniqueKey });
};

describe("multi-item pages", () => {
  it("a page that pushes 5 items is learned once, as all 5, and recalled as all 5", async () => {
    const api = memoryApi();
    vi.spyOn(globalThis, "fetch").mockImplementation(api.impl as any);
    const urls = Array.from({ length: 10 }, (_, i) => ({ url: `${base}/listing/${i}`, uniqueKey: `multi-${i}` }));

    const run1 = crawler(listingHandler, {});
    await run1.run(urls);
    expect(api.learns().length).toBe(10); // one entry per page, not per item
    expect((await run1.getData()).items.length).toBe(50);

    hits = 0;
    const run2 = crawler(listingHandler, {});
    await run2.run(urls);
    const items = (await run2.getData()).items;
    expect(hits).toBe(0); // every page skipped its fetch
    expect(items.length).toBe(50); // ...and every item came back
    expect(new Set(items.map((i: any) => i.sku)).size).toBe(50);
  });

  it("a single-item page is still learned as a plain object (wire-compatible)", async () => {
    const api = memoryApi();
    vi.spyOn(globalThis, "fetch").mockImplementation(api.impl as any);
    const c = crawler(async ({ $, pushData }: any) => pushData({ title: $("h1").text() }), {});
    await c.run([{ url: `${base}/p/1`, uniqueKey: "single-1" }]);
    expect(api.learns()[0].data).toEqual({ title: "1" });
  });

  it("items pushed through the standalone pushData export are learned with the page", async () => {
    const api = memoryApi();
    vi.spyOn(globalThis, "fetch").mockImplementation(api.impl as any);
    const ds = { pushData: vi.fn(async () => {}) };
    const c = crawler(async () => {
      await standalonePushData([{ n: 1 }, { n: 2 }], ds);
    }, {});
    await c.run([{ url: `${base}/p/std`, uniqueKey: "std-1" }]);
    expect(api.learns().map((e: any) => e.data)).toEqual([[{ n: 1 }, { n: 2 }]]);
  });

  it("a handler that fails after pushing data does not teach that partial page", async () => {
    const api = memoryApi();
    vi.spyOn(globalThis, "fetch").mockImplementation(api.impl as any);
    const c = crawler(async ({ pushData }: any) => {
      await pushData({ partial: true });
      throw new Error("parse failed halfway");
    }, {});
    await c.run([{ url: `${base}/p/fail`, uniqueKey: "fail-1" }]);
    expect(api.learns().length).toBe(0);
  });
});

describe("learning never slows the crawl", () => {
  it("pushData returns without waiting for a slow learn, and run() still delivers every learn", async () => {
    const api = memoryApi({ learnDelayMs: 1500 });
    vi.spyOn(globalThis, "fetch").mockImplementation(api.impl as any);
    const pushTimes: number[] = [];
    const c = crawler(async ({ $, pushData }: any) => {
      const t = Date.now();
      await pushData({ title: $("h1").text() });
      pushTimes.push(Date.now() - t);
    }, {});
    await c.run(Array.from({ length: 20 }, (_, i) => ({ url: `${base}/p/${i}`, uniqueKey: `slow-${i}` })));
    expect(Math.max(...pushTimes)).toBeLessThan(200);
    expect(api.learns().length).toBe(20);
  });
});

describe("large seed lists", () => {
  it("6000 known URLs: served from pre-recall with no second recall and no fetch", async () => {
    const api = memoryApi();
    vi.spyOn(globalThis, "fetch").mockImplementation(api.impl as any);
    const N = 6000;
    for (let i = 0; i < N; i++) api.memory.set(`big-${i}`, { i });
    hits = 0;
    const c = crawler(async () => {}, {});
    await c.run(Array.from({ length: N }, (_, i) => ({ url: `${base}/p/${i}`, uniqueKey: `big-${i}` })));
    const items = (await c.getData()).items;
    expect(hits).toBe(0);
    expect(items.length).toBe(N);
    // Exactly one recall per URL: 6000 / 100 per bulk call = 60 calls, no handler-time re-recalls.
    const recalled = api.recallCalls().reduce((n, c) => n + c.body.items.length, 0);
    expect(recalled).toBe(N);
  }, 120_000);

  it("crawling starts before the whole list has been pre-recalled", async () => {
    const api = memoryApi();
    vi.spyOn(globalThis, "fetch").mockImplementation(api.impl as any);
    const N = 5000;
    let recallCallsAtFirstHandler = -1;
    const c = crawler(async ({ pushData }: any) => {
      if (recallCallsAtFirstHandler < 0) recallCallsAtFirstHandler = api.recallCalls().length;
      await pushData({ ok: true });
    }, {});
    await c.run(Array.from({ length: N }, (_, i) => ({ url: `${base}/p/${i}`, uniqueKey: `lazy-${i}` })));
    expect(recallCallsAtFirstHandler).toBeGreaterThan(0);
    expect(recallCallsAtFirstHandler).toBeLessThan(N / 100);
  }, 120_000);
});
