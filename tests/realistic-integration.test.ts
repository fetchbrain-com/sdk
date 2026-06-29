/**
 * Realistic, wide-coverage integration test suite.
 *
 * Drives the REAL stack (enhance -> client -> batch -> fetch -> parse -> AIResult)
 * against a fidelity oracle (`createFakeApi`) that enforces the API's ACTUAL
 * request/response contract. This is the layer that was missing when the two
 * P0 contract bugs shipped invisibly:
 *   1. wrong request shape (`urls` / `entries` w/o `key` instead of `items` / `entries[{key}]`)
 *   2. learn status `"accepted"` instead of `"success"`.
 *
 * NO `vi.mock("../src/client")` here. We stub ONLY the global `fetch`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchBrainClient } from "../src/client";
import { FetchBrain } from "../src/enhance";
import type { FetchBrainConfig } from "../src/types";

// =============================================================================
// THE FIDELITY ORACLE: createFakeApi()
//
// A fetch-compatible function backed by an in-memory Map keyed by `key`.
// It mirrors apps/api/src/routes/{query,learn}.ts validation order + status
// codes EXACTLY, and records every request for assertions.
// =============================================================================

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

interface FakeApi {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** In-memory store keyed by `key`. */
  store: Map<string, { data: Record<string, unknown>; url: string }>;
  /** Every request seen, in order. */
  requests: RecordedRequest[];
  /** Convenience counters. */
  queryCalls: () => RecordedRequest[];
  learnCalls: () => RecordedRequest[];
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFakeApi(): FakeApi {
  const store = new Map<string, { data: Record<string, unknown>; url: string }>();
  const requests: RecordedRequest[] = [];

  const fetchImpl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url).pathname;
    const method = (init?.method || "GET").toUpperCase();

    // GET /v1/stats
    if (path === "/v1/stats" && method === "GET") {
      requests.push({ method, path, body: undefined });
      return jsonResponse(
        {
          queries: 42,
          recognized: 30,
          recognitionRate: 0.714,
          learned: 12,
          period: "day",
        },
        200,
      );
    }

    // Parse body (shared for query/learn). Invalid JSON -> 400.
    let body: any;
    try {
      body = JSON.parse((init?.body as string) ?? "");
    } catch {
      requests.push({ method, path, body: "<invalid-json>" });
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    requests.push({ method, path, body });

    // POST /v1/query  (mirrors apps/api/src/routes/query.ts)
    if (path === "/v1/query" && method === "POST") {
      if (!body.items || !Array.isArray(body.items)) {
        return jsonResponse({ error: "items must be an array" }, 400);
      }
      if (body.items.length === 0) {
        return jsonResponse({ error: "items array cannot be empty" }, 400);
      }
      if (body.items.length > 100) {
        return jsonResponse({ error: "Maximum 100 items per request" }, 400);
      }
      for (const item of body.items) {
        if (
          !item.key ||
          typeof item.key !== "string" ||
          item.key.trim() === ""
        ) {
          return jsonResponse(
            { error: "Each item must have a non-empty key string" },
            400,
          );
        }
      }

      const known: Array<{
        key: string;
        url: string;
        confidence: number;
        data: Record<string, unknown>;
      }> = [];
      const unknown: string[] = [];

      for (const item of body.items) {
        const stored = store.get(item.key);
        if (stored) {
          known.push({
            key: item.key,
            url: item.url ?? stored.url,
            confidence: 0.95,
            data: stored.data,
          });
        } else {
          unknown.push(item.key);
        }
      }

      return jsonResponse({ known, unknown }, 200);
    }

    // POST /v1/learn  (mirrors apps/api/src/routes/learn.ts)
    if (path === "/v1/learn" && method === "POST") {
      if (!body.entries || !Array.isArray(body.entries)) {
        return jsonResponse({ error: "entries must be an array" }, 400);
      }
      if (body.entries.length === 0) {
        return jsonResponse({ error: "entries array cannot be empty" }, 400);
      }
      if (body.entries.length > 50) {
        return jsonResponse({ error: "Maximum 50 entries per request" }, 400);
      }

      const validationErrors: string[] = [];
      let validCount = 0;

      for (const entry of body.entries) {
        const key = entry?.key;
        if (!key || typeof key !== "string" || key.trim() === "") {
          validationErrors.push(`Invalid entry: missing or empty key`);
          continue;
        }
        if (!entry.data || typeof entry.data !== "object") {
          validationErrors.push(`Invalid entry for ${key}: data must be an object`);
          continue;
        }
        if (JSON.stringify(entry.data).length > 100 * 1024) {
          validationErrors.push(`Invalid entry for ${key}: data too large`);
          continue;
        }
        store.set(key, { data: entry.data, url: entry.url ?? key });
        validCount++;
      }

      if (validCount === 0) {
        return jsonResponse({ error: "No valid entries to learn" }, 400);
      }

      const responseBody: {
        learned: number;
        status: "success" | "partial";
        errors?: string[];
      } = {
        learned: validCount,
        status: validationErrors.length > 0 ? "partial" : "success",
      };
      if (validationErrors.length > 0) {
        responseBody.errors = validationErrors;
      }

      return jsonResponse(responseBody, 201);
    }

    return jsonResponse({ error: "Not found" }, 404);
  };

  return {
    fetch: fetchImpl,
    store,
    requests,
    queryCalls: () => requests.filter((r) => r.path === "/v1/query"),
    learnCalls: () => requests.filter((r) => r.path === "/v1/learn"),
  };
}

// Helper: base config for the real client/enhance.
function baseConfig(overrides: Partial<FetchBrainConfig> = {}): FetchBrainConfig {
  return {
    apiKey: "fb_test_x",
    baseUrl: "https://fake.local",
    ...overrides,
  };
}

// Helper to call the fake API directly as raw fetch (for oracle-fidelity tests).
async function rawPost(
  api: FakeApi,
  path: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const res = await api.fetch(`https://fake.local${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// =============================================================================
// GROUP 1 — Oracle fidelity (prove the double enforces the real contract)
// =============================================================================
describe("Group 1 — oracle fidelity", () => {
  it("query with old shape {urls:[...]} (no items) -> 400", async () => {
    const api = createFakeApi();
    const { status, json } = await rawPost(api, "/v1/query", {
      urls: ["https://x/1"],
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/items must be an array/);
  });

  it("query with an item missing key -> 400", async () => {
    const api = createFakeApi();
    const { status, json } = await rawPost(api, "/v1/query", {
      items: [{ url: "https://x/1" }],
      intelligence: "high",
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/non-empty key string/);
  });

  it("learn with old shape {entries:[{url,data}]} (no key) -> 400", async () => {
    const api = createFakeApi();
    const { status, json } = await rawPost(api, "/v1/learn", {
      entries: [{ url: "https://x/1", data: { title: "A" } }],
    });
    expect(status).toBe(400);
    // No valid entries (all missing key) -> "No valid entries to learn".
    expect(json.error).toMatch(/No valid entries to learn/);
  });

  it("valid learn returns status:'success' and NO verification field (locks the 'accepted' bug)", async () => {
    const api = createFakeApi();
    const res = await api.fetch("https://fake.local/v1/learn", {
      method: "POST",
      body: JSON.stringify({
        entries: [{ key: "k1", url: "https://x/1", data: { title: "A" } }],
      }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.status).toBe("success");
    expect(json.status).not.toBe("accepted");
    expect("verification" in json).toBe(false);
    expect(json.learned).toBe(1);
  });
});

// =============================================================================
// GROUP 2 — Full-stack request+response conformance (REAL client -> double)
// =============================================================================
describe("Group 2 — full-stack request/response conformance", () => {
  let api: FakeApi;
  beforeEach(() => {
    api = createFakeApi();
    vi.stubGlobal("fetch", api.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("query on empty store resolves {known:false} and sends exact items body (no urls)", async () => {
    const c = new FetchBrainClient(
      baseConfig({ batch: { maxSize: 1, maxWait: 0 } }),
    );
    const result = await c.query("k1", "https://x/1");
    expect(result.known).toBe(false);

    const body = api.queryCalls()[0].body as any;
    expect(body).toEqual({
      items: [{ key: "k1", url: "https://x/1" }],
      intelligence: "high",
    });
    expect(body.urls).toBeUndefined();
  });

  it("learn sends exact entries body and parses to {learned:1,status:'success'}", async () => {
    const c = new FetchBrainClient(
      baseConfig({ batch: { maxSize: 1, maxWait: 0 } }),
    );
    const res = await c.learn("k1", { title: "A" }, "https://x/1");

    const body = api.learnCalls()[0].body as any;
    expect(body).toEqual({
      entries: [{ key: "k1", url: "https://x/1", data: { title: "A" } }],
    });
    expect(res).toMatchObject({ learned: 1, status: "success" });
  });

  it("query after learn resolves {known:true, data, confidence} (response parsing maps known[].data/confidence)", async () => {
    const c = new FetchBrainClient(
      baseConfig({ batch: { maxSize: 1, maxWait: 0 } }),
    );
    await c.learn("k1", { title: "A" }, "https://x/1");

    const result = await c.query("k1");
    expect(result.known).toBe(true);
    expect(result.data).toEqual({ title: "A" });
    expect(typeof result.confidence).toBe("number");
  });
});

// =============================================================================
// GROUP 3 — Key identity at scale (the core P0 fix, realistically)
// =============================================================================
describe("Group 3 — key identity at scale", () => {
  let api: FakeApi;
  beforeEach(() => {
    api = createFakeApi();
    vi.stubGlobal("fetch", api.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("50 distinct uniqueKeys all sharing one graphql url resolve to their own data, no cross-resolution", async () => {
    const c = new FetchBrainClient(
      baseConfig({ batch: { maxSize: 1, maxWait: 0 } }),
    );
    const sharedUrl = "https://api/graphql";
    const N = 50;

    // Learn each key_i -> {n:i}, all under the same url.
    for (let i = 0; i < N; i++) {
      await c.learn(`key_${i}`, { n: i }, sharedUrl);
    }

    // Query all 50 in bulk.
    const items = Array.from({ length: N }, (_, i) => ({
      key: `key_${i}`,
      url: sharedUrl,
    }));
    const results = await c.queryBulk(items);

    for (let i = 0; i < N; i++) {
      const r = results.get(`key_${i}`)!;
      expect(r.known).toBe(true);
      expect(r.data).toEqual({ n: i });
    }
  });

  it("different key + same url learned under another key -> {known:false} (no false hit)", async () => {
    const c = new FetchBrainClient(
      baseConfig({ batch: { maxSize: 1, maxWait: 0 } }),
    );
    await c.learn("op:A", { hit: "A" }, "https://api/graphql");

    const result = await c.query("op:B", "https://api/graphql");
    expect(result.known).toBe(false);
    expect(result.data).toBeUndefined();
  });
});

// =============================================================================
// GROUP 4 — Concurrency / batching correctness (real RequestBatcher)
// =============================================================================
describe("Group 4 — concurrency / batching correctness", () => {
  let api: FakeApi;
  beforeEach(() => {
    api = createFakeApi();
    vi.stubGlobal("fetch", api.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("100 concurrent queries coalesce into <100 POSTs and each resolves to its own answer", async () => {
    const c = new FetchBrainClient(
      baseConfig({ batch: { maxSize: 25, maxWait: 5 } }),
    );
    const N = 100;

    // Seed even keys so we get a known/unknown mix.
    for (let i = 0; i < N; i += 2) {
      await c.learn(`key_${i}`, { n: i }, `https://x/${i}`);
    }
    const learnPostsBefore = api.learnCalls().length;

    // Fire 100 concurrent queries.
    const promises = Array.from({ length: N }, (_, i) =>
      c.query(`key_${i}`).then((r) => ({ i, r })),
    );
    const settled = await Promise.all(promises);

    for (const { i, r } of settled) {
      if (i % 2 === 0) {
        expect(r.known).toBe(true);
        expect(r.data).toEqual({ n: i });
      } else {
        expect(r.known).toBe(false);
      }
    }

    // Coalescing: fewer POST /v1/query calls than queries.
    const queryPosts = api.queryCalls().length;
    expect(queryPosts).toBeLessThan(N);
    // Sanity: we did fire learn posts separately; not counted as query posts.
    expect(learnPostsBefore).toBeGreaterThan(0);
  });

  it("many learn calls + flushLearnBatch persist all entries with fewer POSTs than calls", async () => {
    const c = new FetchBrainClient(
      baseConfig({ batch: { maxSize: 10, maxWait: 1000 } }),
    );
    const N = 30;

    const promises = Array.from({ length: N }, (_, i) =>
      c.learn(`lk_${i}`, { n: i }, `https://x/${i}`),
    );
    await c.flushLearnBatch();
    await Promise.all(promises);

    // All entries ended up in the store.
    for (let i = 0; i < N; i++) {
      expect(api.store.has(`lk_${i}`)).toBe(true);
      expect(api.store.get(`lk_${i}`)!.data).toEqual({ n: i });
    }

    // Batched: fewer learn POSTs than learn calls.
    expect(api.learnCalls().length).toBeLessThan(N);
  });
});

// =============================================================================
// GROUP 5 — Graceful degradation (crawl never breaks)
// =============================================================================
describe("Group 5 — graceful degradation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("API 500 -> query resolves {known:false, fallback:true}, does not throw", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const c = new FetchBrainClient(
      baseConfig({ batch: { maxSize: 1, maxWait: 0 } }),
    );
    const result = await c.query("k1", "https://x/1");
    expect(result).toEqual({ known: false, fallback: true });
  });

  it("network error (fetch throws) -> query falls back, no throw", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    const c = new FetchBrainClient(
      baseConfig({ batch: { maxSize: 1, maxWait: 0 } }),
    );
    const result = await c.query("k1", "https://x/1");
    expect(result).toEqual({ known: false, fallback: true });
  });

  it("repeated failures trip the breaker; subsequent query short-circuits without calling fetch; recovers on half-open success", async () => {
    let mode: "fail" | "ok" = "fail";
    const fetchMock = vi.fn(async () => {
      if (mode === "fail") {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return new Response(JSON.stringify({ known: [], unknown: ["k"] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const c = new FetchBrainClient(
      baseConfig({
        batch: { maxSize: 1, maxWait: 0 },
        circuitBreaker: { failureThreshold: 2, resetTimeout: 50, successThreshold: 1 },
      }),
    );

    // Drive 2 failures to open the breaker.
    await c.query("k", "https://x/1");
    await c.query("k", "https://x/2");
    expect(c.getCircuitState().state).toBe("open");

    // Subsequent query short-circuits WITHOUT calling fetch.
    const callsAfterOpen = fetchMock.mock.calls.length;
    const fallback = await c.query("k", "https://x/3");
    expect(fallback).toEqual({ known: false, fallback: true });
    expect(fetchMock.mock.calls.length).toBe(callsAfterOpen);

    // Recover: let reset timeout pass, switch the API to ok, query serves again.
    mode = "ok";
    await new Promise((r) => setTimeout(r, 70));
    const recovered = await c.query("k", "https://x/4");
    expect(recovered.known).toBe(false); // 'k' is unknown in this mock
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterOpen);
    expect(c.getCircuitState().state).toBe("closed");
  });
});

// =============================================================================
// GROUP 6 — enhance() end-to-end through the real client + double
// =============================================================================
describe("Group 6 — enhance() end-to-end", () => {
  let api: FakeApi;
  beforeEach(() => {
    api = createFakeApi();
    vi.stubGlobal("fetch", api.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  function createMockCrawler(handler: (ctx: any) => void | Promise<void>) {
    return {
      requestHandler: handler,
      run: vi.fn().mockResolvedValue({ requestsFinished: 1 }),
      constructor: { name: "MockCrawler" },
    };
  }

  it("learns on first run (AI unknown), then recognizes on second run and skips the handler", async () => {
    const handler = vi.fn(async (ctx: any) => {
      await ctx.pushData({ title: "Scraped" });
    });
    const crawler = createMockCrawler(handler);
    const enhanced = FetchBrain.enhance(
      crawler,
      baseConfig({ batch: { maxSize: 1, maxWait: 0 } }),
    );

    // First run: AI does NOT know -> handler runs -> pushData -> learn POST.
    const pushed1: any[] = [];
    const ctx1 = {
      request: { url: "https://shop/p/1" },
      pushData: vi.fn(async (d: any) => {
        pushed1.push(d);
      }),
    };
    await enhanced.requestHandler(ctx1);
    await enhanced.fetchBrain.flushLearnBatch();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(api.learnCalls().length).toBeGreaterThan(0);
    // Learn POST used key = uniqueKey ?? url = url here.
    const learnBody = api.learnCalls()[0].body as any;
    expect(learnBody.entries[0].key).toBe("https://shop/p/1");
    expect(api.store.has("https://shop/p/1")).toBe(true);

    // Second run: same key now in store -> AI recognized -> handler NOT re-run.
    const pushed2: any[] = [];
    const ctx2 = {
      request: { url: "https://shop/p/1" },
      pushData: vi.fn(async (d: any) => {
        pushed2.push(d);
      }),
    };
    await enhanced.requestHandler(ctx2);

    expect(handler).toHaveBeenCalledTimes(1); // not re-run
    // Cached/recognized data pushed.
    expect(pushed2).toEqual([{ title: "Scraped" }]);
  });

  it("keys by uniqueKey: query/learn body uses key=uniqueKey, url=request.url", async () => {
    const handler = vi.fn(async (ctx: any) => {
      await ctx.pushData({ op: "search" });
    });
    const crawler = createMockCrawler(handler);
    const enhanced = FetchBrain.enhance(
      crawler,
      baseConfig({ batch: { maxSize: 1, maxWait: 0 } }),
    );

    const ctx = {
      request: { url: "https://api/graphql", uniqueKey: "op:search:1" },
      pushData: vi.fn(),
    };
    await enhanced.requestHandler(ctx);
    await enhanced.fetchBrain.flushLearnBatch();

    const queryBody = api.queryCalls()[0].body as any;
    expect(queryBody.items[0]).toEqual({
      key: "op:search:1",
      url: "https://api/graphql",
    });

    const learnBody = api.learnCalls()[0].body as any;
    expect(learnBody.entries[0].key).toBe("op:search:1");
    expect(learnBody.entries[0].url).toBe("https://api/graphql");
  });
});
