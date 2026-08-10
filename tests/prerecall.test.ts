/**
 * Enqueue-time pre-recall (`preRecall`, default on) + `onRecalled` hook.
 *
 * Why this exists: in HttpCrawler/CheerioCrawler the HTTP fetch happens BEFORE the
 * request handler runs, so the handler-time recall in enhance() cannot save the fetch.
 * The pre-recall wrapper on `crawler.addRequests` recalls array batches in bulk, marks
 * known requests `skipNavigation`, and stashes a {known} marker in userData (the payload
 * stays in an in-process map, off the persisted queue record) so the handler does no
 * second recall.
 *
 * Like realistic-integration.test.ts, only global `fetch` is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchBrain } from "../src/enhance";
import { FetchBrainClient } from "../src/client";
import type { FetchBrainConfig, RecalledEvent } from "../src/types";

interface RecordedCall {
  path: string;
  body: any;
}

/** Minimal fake API: /v1/recall answers from a set of known URLs, /v1/learn accepts. */
function createFakeApi(knownUrls: Map<string, Record<string, unknown>>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(typeof input === "string" ? input : input.toString()).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, body });

    if (path === "/v1/recall") {
      if (body.items.length > 100) {
        return new Response(JSON.stringify({ error: "Maximum 100 items per request" }), { status: 400 });
      }
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
      return new Response(JSON.stringify({ learned: body.entries.length, status: "success" }), { status: 200 });
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

/** A fake Crawlee-ish crawler: enhance() wraps requestHandler, run, addRequests. */
function createFakeCrawler(handler: (ctx: any) => Promise<void>) {
  const enqueued: any[] = [];
  const addRequestsArgs: unknown[][] = [];
  const crawler: any = {
    requestHandler: handler,
    addRequests: vi.fn(async (reqs: any, options?: unknown) => {
      addRequestsArgs.push([reqs, options]);
      if (Array.isArray(reqs)) enqueued.push(...reqs);
    }),
    run: async () => {},
  };
  return { crawler, enqueued, addRequestsArgs };
}

function makeContext(request: any) {
  const pushed: any[] = [];
  const context: any = {
    request,
    pushData: vi.fn(async (d: any) => {
      pushed.push(d);
    }),
  };
  return { context, pushed };
}

const CONFIG: FetchBrainConfig = { apiKey: "fb_test_key" };

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(impl: typeof fetch) {
  vi.spyOn(globalThis, "fetch" as any).mockImplementation(impl as any);
}

describe("pre-recall on addRequests", () => {
  it("bulk-recalls the batch in ONE call; known → skipNavigation + marker, unknown → marker only", async () => {
    const api = createFakeApi(new Map([["https://site/p/1", { title: "one" }]]));
    stubFetch(api.fetchImpl as any);

    const { crawler, enqueued } = createFakeCrawler(async () => {});
    const enhanced: any = FetchBrain.enhance(crawler, CONFIG);

    await enhanced.addRequests([
      { url: "https://site/p/1", label: "PRODUCT", userData: { ean: "1" } },
      { url: "https://site/p/2", label: "PRODUCT" },
      "https://site/p/3", // plain string form
    ]);

    expect(api.recallCalls()).toHaveLength(1);
    expect(api.recallCalls()[0].body.items).toHaveLength(3);

    const [r1, r2, r3] = enqueued;
    expect(r1.skipNavigation).toBe(true);
    // Marker only — the payload must NOT be persisted in userData (queue-record size).
    expect(r1.userData.__fetchBrainResult).toEqual({ known: true });
    expect(r1.userData.ean).toBe("1"); // original userData preserved
    expect(r2.skipNavigation).toBeUndefined();
    expect(r2.userData.__fetchBrainResult).toEqual({ known: false });
    expect(r3.url).toBe("https://site/p/3"); // string normalized to object
    expect(r3.userData.__fetchBrainResult).toEqual({ known: false });
  });

  it("never mutates caller-owned inputs (a reused startRequests array stays clean)", async () => {
    const api = createFakeApi(new Map([["https://site/p/1", { title: "one" }]]));
    stubFetch(api.fetchImpl as any);

    const { crawler } = createFakeCrawler(async () => {});
    const enhanced: any = FetchBrain.enhance(crawler, CONFIG);

    const callerObj = { url: "https://site/p/1", label: "PRODUCT", userData: { ean: "1" } };
    const callerArray: unknown[] = [callerObj, "https://site/p/3"];
    await enhanced.addRequests(callerArray);

    expect(callerObj).toEqual({ url: "https://site/p/1", label: "PRODUCT", userData: { ean: "1" } });
    expect((callerObj as any).skipNavigation).toBeUndefined();
    expect(callerArray[1]).toBe("https://site/p/3"); // string entry untouched
  });

  it("non-array input (generators from Crawlee context helpers) passes through un-recalled", async () => {
    const api = createFakeApi(new Map());
    stubFetch(api.fetchImpl as any);

    const { crawler, addRequestsArgs } = createFakeCrawler(async () => {});
    const enhanced: any = FetchBrain.enhance(crawler, CONFIG);

    function* gen() {
      yield { url: "https://site/p/1" };
    }
    const g = gen();
    await enhanced.addRequests(g, { forefront: true });

    expect(api.recallCalls()).toHaveLength(0);
    expect(addRequestsArgs[0][0]).toBe(g); // exact object forwarded
    expect(addRequestsArgs[0][1]).toEqual({ forefront: true });
  });

  it("excludes skipLabels, own-skipNavigation, and POST-without-uniqueKey from the bulk recall", async () => {
    const api = createFakeApi(new Map());
    stubFetch(api.fetchImpl as any);

    const { crawler, enqueued } = createFakeCrawler(async () => {});
    const enhanced: any = FetchBrain.enhance(crawler, { ...CONFIG, skipLabels: ["SEARCH"] });

    await enhanced.addRequests([
      { url: "https://site/search", label: "SEARCH" },
      { url: "https://site/custom", skipNavigation: true },
      { url: "https://site/gql", method: "POST", payload: "{}" }, // identity computed later by Crawlee
      { url: "https://site/gql", method: "POST", uniqueKey: "k1" }, // explicit key → eligible
      { url: "https://site/p/9", label: "PRODUCT" },
    ]);

    expect(api.recallCalls()).toHaveLength(1);
    const items = api.recallCalls()[0].body.items;
    expect(items.map((i: any) => i.request.url)).toEqual(["https://site/gql", "https://site/p/9"]);
    expect(items[0].request.uniqueKey).toBe("k1");
    expect(enqueued[0].userData?.__fetchBrainResult).toBeUndefined();
    expect(enqueued[1].userData?.__fetchBrainResult).toBeUndefined();
    expect(enqueued[2].userData?.__fetchBrainResult).toBeUndefined();
  });

  it("known + alwaysRun label: stashes the marker but does NOT set skipNavigation", async () => {
    const api = createFakeApi(new Map([["https://site/p/1", { title: "one" }]]));
    stubFetch(api.fetchImpl as any);

    const { crawler, enqueued } = createFakeCrawler(async () => {});
    const enhanced: any = FetchBrain.enhance(crawler, { ...CONFIG, alwaysRun: ["PRODUCT"] });

    await enhanced.addRequests([{ url: "https://site/p/1", label: "PRODUCT" }]);

    expect(enqueued[0].skipNavigation).toBeUndefined();
    expect(enqueued[0].userData.__fetchBrainResult).toEqual({ known: true });
  });

  it("API failure: enqueues unchanged (no stash) and never throws", async () => {
    stubFetch((async () => new Response("oops", { status: 500 })) as any);

    const { crawler, enqueued } = createFakeCrawler(async () => {});
    const enhanced: any = FetchBrain.enhance(crawler, CONFIG);

    await expect(
      enhanced.addRequests([{ url: "https://site/p/1", label: "PRODUCT" }]),
    ).resolves.toBeUndefined();
    expect(enqueued[0].userData?.__fetchBrainResult).toBeUndefined();
    expect(enqueued[0].skipNavigation).toBeUndefined();
  });

  it("preRecall: false leaves addRequests alone", async () => {
    const api = createFakeApi(new Map());
    stubFetch(api.fetchImpl as any);

    const { crawler } = createFakeCrawler(async () => {});
    const enhanced: any = FetchBrain.enhance(crawler, { ...CONFIG, preRecall: false });

    await enhanced.addRequests([{ url: "https://site/p/1", label: "PRODUCT" }]);
    expect(api.recallCalls()).toHaveLength(0);
  });
});

describe("handler with pre-recalled results", () => {
  it("known (enqueue → execute): pushes recalled data from the in-process map, skips original handler, does NO second recall, fires onRecalled with clean userData", async () => {
    const api = createFakeApi(new Map([["https://site/p/1", { title: "one" }]]));
    stubFetch(api.fetchImpl as any);

    const originalHandler = vi.fn();
    const recalledEvents: RecalledEvent[] = [];
    const { crawler, enqueued } = createFakeCrawler(originalHandler);
    const enhanced: any = FetchBrain.enhance(crawler, {
      ...CONFIG,
      onRecalled: (e) => {
        recalledEvents.push(e);
      },
    });

    // Full flow: enqueue (populates the map) then execute the enqueued request.
    await enhanced.addRequests([
      { url: "https://site/p/1", label: "PRODUCT", userData: { ean: "1" } },
    ]);
    const { context, pushed } = makeContext(enqueued[0]);
    await enhanced.requestHandler(context);

    expect(pushed).toEqual([{ title: "one" }]);
    expect(originalHandler).not.toHaveBeenCalled();
    expect(api.recallCalls()).toHaveLength(1); // only the enqueue-time bulk call
    expect(recalledEvents).toHaveLength(1);
    expect(recalledEvents[0]).toMatchObject({
      url: "https://site/p/1",
      label: "PRODUCT",
      data: { title: "one" },
    });
    expect(recalledEvents[0].userData?.ean).toBe("1");
    // SDK bookkeeping must not leak into the hook's userData.
    expect(recalledEvents[0].userData?.__fetchBrainResult).toBeUndefined();
    expect(recalledEvents[0].userData?.fetchBrainData).toBeUndefined();
  });

  it("known marker but map lost (process restart): falls back to ONE handler-time recall", async () => {
    const api = createFakeApi(new Map([["https://site/p/1", { title: "one" }]]));
    stubFetch(api.fetchImpl as any);

    const originalHandler = vi.fn();
    const { crawler } = createFakeCrawler(originalHandler);
    const enhanced: any = FetchBrain.enhance(crawler, CONFIG);

    // Simulate a request resurrected from a persisted queue in a fresh process:
    // marker present, map empty.
    const { context, pushed } = makeContext({
      url: "https://site/p/1",
      label: "PRODUCT",
      userData: { __fetchBrainResult: { known: true } },
      skipNavigation: true,
    });
    await enhanced.requestHandler(context);

    expect(api.recallCalls()).toHaveLength(1);
    expect(pushed).toEqual([{ title: "one" }]);
    expect(originalHandler).not.toHaveBeenCalled();
  });

  it("skipNavigation request whose remembered data expired: dropped with a warning, handler never runs on a fetch-less request", async () => {
    const api = createFakeApi(new Map()); // brain no longer knows anything
    stubFetch(api.fetchImpl as any);

    const originalHandler = vi.fn();
    const { crawler } = createFakeCrawler(originalHandler);
    const enhanced: any = FetchBrain.enhance(crawler, CONFIG);

    const { context, pushed } = makeContext({
      url: "https://site/p/1",
      userData: { __fetchBrainResult: { known: true } },
      skipNavigation: true,
    });
    await expect(enhanced.requestHandler(context)).resolves.toBeUndefined();

    expect(originalHandler).not.toHaveBeenCalled(); // would crash: no response body exists
    expect(pushed).toEqual([]);
  });

  it("a throwing onRecalled hook never breaks the crawl", async () => {
    const api = createFakeApi(new Map([["https://site/p/1", { a: 1 }]]));
    stubFetch(api.fetchImpl as any);

    const { crawler, enqueued } = createFakeCrawler(vi.fn());
    const enhanced: any = FetchBrain.enhance(crawler, {
      ...CONFIG,
      onRecalled: () => {
        throw new Error("hook boom");
      },
    });

    await enhanced.addRequests([{ url: "https://site/p/1" }]);
    const { context, pushed } = makeContext(enqueued[0]);
    await expect(enhanced.requestHandler(context)).resolves.toBeUndefined();
    expect(pushed).toEqual([{ a: 1 }]);
  });

  it("unknown: runs original handler with no second recall, and learns on pushData", async () => {
    const api = createFakeApi(new Map());
    stubFetch(api.fetchImpl as any);

    const originalHandler = vi.fn(async (ctx: any) => {
      await ctx.pushData({ scraped: true });
    });
    const { crawler, enqueued } = createFakeCrawler(originalHandler);
    const enhanced: any = FetchBrain.enhance(crawler, CONFIG);

    await enhanced.addRequests([{ url: "https://site/p/2", label: "PRODUCT" }]);
    const { context, pushed } = makeContext(enqueued[0]);
    await enhanced.requestHandler(context);
    await enhanced.fetchBrain.flushLearnBatch();

    expect(originalHandler).toHaveBeenCalledOnce();
    expect(pushed).toEqual([{ scraped: true }]);
    expect(api.recallCalls()).toHaveLength(1); // enqueue-time only — marker trusted at handler time
    expect(api.learnCalls()).toHaveLength(1);
    expect(api.learnCalls()[0].body.entries[0].data).toEqual({ scraped: true });
    // The stash marker must not leak into the learned request identity/userData.
    expect(api.learnCalls()[0].body.entries[0].request.userData?.__fetchBrainResult).toBeUndefined();
  });

  it("no stash: falls back to handler-time recall (the pre-preRecall behavior)", async () => {
    const api = createFakeApi(new Map([["https://site/p/1", { title: "one" }]]));
    stubFetch(api.fetchImpl as any);

    const originalHandler = vi.fn();
    const { crawler } = createFakeCrawler(originalHandler);
    const enhanced: any = FetchBrain.enhance(crawler, CONFIG);

    const { context, pushed } = makeContext({ url: "https://site/p/1", userData: {} });
    await enhanced.requestHandler(context);

    expect(api.recallCalls()).toHaveLength(1);
    expect(pushed).toEqual([{ title: "one" }]);
    expect(originalHandler).not.toHaveBeenCalled();
  });
});

describe("recallBulk chunking", () => {
  it("splits >100 items across multiple /v1/recall calls and preserves order", async () => {
    const known = new Map<string, Record<string, unknown>>([["https://site/p/0", { i: 0 }], ["https://site/p/149", { i: 149 }]]);
    const api = createFakeApi(known);
    stubFetch(api.fetchImpl as any);

    const client = new FetchBrainClient(CONFIG);
    const requests = Array.from({ length: 150 }, (_, i) => ({ url: `https://site/p/${i}` }));
    const results = await client.recallBulk(requests);

    expect(api.recallCalls()).toHaveLength(2);
    expect(api.recallCalls()[0].body.items).toHaveLength(100);
    expect(api.recallCalls()[1].body.items).toHaveLength(50);
    expect(results).toHaveLength(150);
    expect(results[0]).toMatchObject({ known: true, data: { i: 0 } });
    expect(results[1].known).toBe(false);
    expect(results[149]).toMatchObject({ known: true, data: { i: 149 } });
  });
});
