/**
 * TRUE end-to-end tests against REAL Crawlee (devDependency) — no fake crawler.
 *
 * These prove the assumptions the preRecall feature stands on, against the actual
 * Crawlee implementation:
 *  - `run(requests)` funnels through the instance's `addRequests` (our wrapper);
 *  - `request.skipNavigation` makes HttpCrawler/CheerioCrawler skip the HTTP fetch
 *    but still run the (wrapped) requestHandler;
 *  - Request instances survive in-place annotation + un-poisoning (real
 *    userData setter with internal `__crawlee` state);
 *  - the unknown path still fetches, scrapes, and learns.
 *
 * Only the SDK's own API traffic (global fetch) is stubbed; crawl traffic uses
 * got-scraping against a real local HTTP server (or provably never happens:
 * known URLs point at a non-resolvable `.invalid` domain).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { CheerioCrawler, Configuration, Request } from "crawlee";
import { FetchBrain } from "../src/enhance";
import type { RecalledEvent } from "../src/types";

interface RecordedCall {
  path: string;
  body: any;
}

function createFakeApi(knownUrls: Map<string, Record<string, unknown>>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(typeof input === "string" ? input : input.toString()).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, body });

    if (path === "/v1/recall") {
      const known: { ref: string; data: Record<string, unknown> }[] = [];
      const unknown: string[] = [];
      for (const item of body.items) {
        const data = knownUrls.get(item.request.url);
        if (data) known.push({ ref: item.ref, data });
        else unknown.push(item.ref);
      }
      return new Response(JSON.stringify({ known, unknown }), { status: 200 });
    }
    if (path === "/v1/learn") {
      return new Response(JSON.stringify({ learned: body.entries.length, status: "success" }), {
        status: 200,
      });
    }
    if (path === "/v1/telemetry") {
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };
  return {
    calls,
    fetchImpl,
    recallCalls: () => calls.filter((c) => c.path === "/v1/recall"),
    learnCalls: () => calls.filter((c) => c.path === "/v1/learn"),
  };
}

function stubFetch(impl: typeof fetch) {
  vi.spyOn(globalThis, "fetch" as any).mockImplementation(impl as any);
}

/** Fresh isolated crawler storage per test — nothing written to disk. */
function makeCrawler(options: ConstructorParameters<typeof CheerioCrawler>[0]) {
  const config = new Configuration({ persistStorage: false, purgeOnStart: true });
  return new CheerioCrawler(options, config);
}

// Local HTTP server for paths that genuinely fetch.
let server: http.Server;
let serverUrl: string;
let serverHits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    serverHits.push(req.url ?? "");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<html><body><h1 id="t">live-${req.url}</h1></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  vi.restoreAllMocks();
  serverHits = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

const CONFIG = { apiKey: "fb_test_key" };

describe("real CheerioCrawler end to end", () => {
  it(
    "known requests: run(requests) pre-recalls via the wrapper, skips the fetch entirely, pushes recalled data, fires onRecalled",
    { timeout: 30_000 },
    async () => {
      // .invalid TLD can never resolve (RFC 2606) — if Crawlee attempted the fetch,
      // the request would fail and this test would catch it.
      const urls = [
        "https://fetchbrain-e2e.invalid/p/1",
        "https://fetchbrain-e2e.invalid/p/2",
      ];
      const api = createFakeApi(
        new Map(urls.map((u, i) => [u, { title: `product-${i}`, recalled: true }])),
      );
      stubFetch(api.fetchImpl as any);

      const handler = vi.fn();
      const events: RecalledEvent[] = [];
      const failed: string[] = [];
      const crawler = makeCrawler({
        requestHandler: handler,
        failedRequestHandler: ({ request }) => {
          failed.push(request.url);
        },
        maxRequestRetries: 1,
      });
      FetchBrain.enhance(crawler, { ...CONFIG, onRecalled: (e) => void events.push(e) });

      await crawler.run(urls.map((url) => ({ url, label: "PRODUCT", userData: { i: 1 } })));

      expect(failed).toEqual([]); // no DNS failures — the fetch never happened
      expect(handler).not.toHaveBeenCalled();
      expect(api.recallCalls()).toHaveLength(1); // ONE bulk call at enqueue, none at handler time
      const { items } = await crawler.getData();
      expect(items).toHaveLength(2);
      expect(items.map((d: any) => d.recalled)).toEqual([true, true]);
      expect(events).toHaveLength(2);
      expect(events[0].userData?.__fetchBrainResult).toBeUndefined();
    },
  );

  it(
    "known requests with retryOnBlocked: crawl still succeeds (no contentType crash)",
    { timeout: 30_000 },
    async () => {
      // Crawlee's isRequestBlocked reads `crawlingContext.contentType.type`, which is
      // only set when navigation happened — a skipNavigation request would crash it.
      // The SDK must not combine skipNavigation with retryOnBlocked crawlers.
      const url = `${serverUrl}/known-blocked`;
      const api = createFakeApi(new Map([[url, { title: "remembered" }]]));
      stubFetch(api.fetchImpl as any);

      const handler = vi.fn();
      const failed: string[] = [];
      const crawler = makeCrawler({
        requestHandler: handler,
        retryOnBlocked: true,
        failedRequestHandler: ({ request }) => {
          failed.push(request.url);
        },
        maxRequestRetries: 1,
      });
      FetchBrain.enhance(crawler, CONFIG);

      await crawler.run([url]);

      expect(failed).toEqual([]); // must not crash in isRequestBlocked
      expect(handler).not.toHaveBeenCalled(); // recalled data still auto-pushed
      const { items } = await crawler.getData();
      expect(items).toEqual([{ title: "remembered" }]);
    },
  );

  it(
    "unknown requests: really fetches from the server, runs the handler, learns the scrape",
    { timeout: 30_000 },
    async () => {
      const api = createFakeApi(new Map()); // brain knows nothing
      stubFetch(api.fetchImpl as any);

      const crawler = makeCrawler({
        requestHandler: async ({ $, pushData }) => {
          await pushData({ heading: $("#t").text() });
        },
        maxRequestRetries: 0,
      });
      const enhanced = FetchBrain.enhance(crawler, CONFIG);

      await crawler.run([`${serverUrl}/fresh-page`]);
      await enhanced.fetchBrain.flushLearnBatch();

      expect(serverHits).toEqual(["/fresh-page"]); // the fetch genuinely happened
      const { items } = await crawler.getData();
      expect(items).toEqual([{ heading: "live-/fresh-page" }]);
      expect(api.learnCalls()).toHaveLength(1);
      expect(api.learnCalls()[0].body.entries[0].data).toEqual({ heading: "live-/fresh-page" });
      expect(api.recallCalls()).toHaveLength(1); // enqueue-time only; marker trusted in handler
    },
  );

  it(
    "a real Request instance annotated in run 1 is un-poisoned and re-scraped in run 2 after memory expired",
    { timeout: 30_000 },
    async () => {
      const url = `${serverUrl}/reused-instance`;

      // Run 1: brain knows — instance annotated in place, fetch skipped.
      const api1 = createFakeApi(new Map([[url, { title: "old-memory" }]]));
      stubFetch(api1.fetchImpl as any);
      const instance = new Request({ url });
      const crawler1 = makeCrawler({ requestHandler: vi.fn() });
      FetchBrain.enhance(crawler1, CONFIG);
      await crawler1.run([instance]);
      expect(instance.skipNavigation).toBe(true);
      expect(serverHits).toEqual([]);

      // Run 2 (new crawler, memory expired): the same instance must fetch normally.
      vi.restoreAllMocks();
      const api2 = createFakeApi(new Map());
      stubFetch(api2.fetchImpl as any);
      const failed: string[] = [];
      const crawler2 = makeCrawler({
        requestHandler: async ({ $, pushData }) => {
          await pushData({ heading: $("#t").text() });
        },
        failedRequestHandler: ({ request }) => {
          failed.push(request.url);
        },
        maxRequestRetries: 0,
      });
      FetchBrain.enhance(crawler2, CONFIG);
      await crawler2.run([instance]);

      expect(failed).toEqual([]); // NOT dropped forever
      expect(serverHits).toEqual(["/reused-instance"]); // really re-fetched
      const { items } = await crawler2.getData();
      expect(items).toEqual([{ heading: "live-/reused-instance" }]);
      // Internal Crawlee state survived our userData round-trips.
      expect((instance.userData as any).__crawlee).toBeDefined();
    },
  );
});
