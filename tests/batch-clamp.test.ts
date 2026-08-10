/**
 * The batchers must never send more items than the API accepts, regardless of a
 * user-configured `batch.maxSize` — otherwise every oversized flush 400s silently
 * (recall degrades to fallback, learn is swallowed) and recall rate reads 0%.
 *
 * API caps (apps/api/src/routes): recall 100 items, learn 50 entries.
 * Like realistic-integration.test.ts, only global `fetch` is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchBrainClient } from "../src/client";

interface RecordedCall {
  path: string;
  body: any;
}

/** Fake API that enforces the real per-request item caps. */
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
      if (body.entries.length > 50) {
        return new Response(JSON.stringify({ error: "Maximum 50 entries per request" }), { status: 400 });
      }
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

function stubFetch(impl: typeof fetch) {
  vi.spyOn(globalThis, "fetch" as any).mockImplementation(impl as any);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("batch.maxSize clamping to API caps", () => {
  it("recall: a user maxSize above 100 never produces an oversized (400) flush", async () => {
    const api = createFakeApi(new Map([["https://site/p/0", { i: 0 }]]));
    stubFetch(api.fetchImpl as any);

    const client = new FetchBrainClient({
      apiKey: "fb_test_key",
      batch: { maxSize: 250, maxWait: 5 },
    });
    const results = await Promise.all(
      Array.from({ length: 120 }, (_, i) => client.recall({ url: `https://site/p/${i}` })),
    );

    for (const call of api.recallCalls()) {
      expect(call.body.items.length).toBeLessThanOrEqual(100);
    }
    // No flush 400'd — nothing degraded to fallback.
    expect(results.some((r) => r.fallback)).toBe(false);
    expect(results[0]).toMatchObject({ known: true, data: { i: 0 } });
    expect(results[1].known).toBe(false);
  });

  it("learn: a user maxSize above 50 never produces an oversized (silently swallowed 400) flush", async () => {
    const api = createFakeApi(new Map());
    stubFetch(api.fetchImpl as any);

    const client = new FetchBrainClient({
      apiKey: "fb_test_key",
      batch: { maxSize: 80, maxWait: 5 },
    });
    // Enqueue synchronously (awaiting each would flush tiny timer batches and
    // never fill the queue) — the 80th push triggers a full-queue flush.
    const pending = Array.from({ length: 80 }, (_, i) =>
      client.learn({ url: `https://site/p/${i}` }, { i }),
    );
    await Promise.allSettled(pending);
    await client.flushLearnBatch();

    const learned = api.learnCalls().reduce((n, c) => n + c.body.entries.length, 0);
    for (const call of api.learnCalls()) {
      expect(call.body.entries.length).toBeLessThanOrEqual(50);
    }
    expect(learned).toBe(80); // every entry made it to the API in a valid-sized batch
  });
});
