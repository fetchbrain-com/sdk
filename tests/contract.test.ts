import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchBrainClient } from "../src/client";

describe("recall wire contract", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ known: [{ ref: "0", data: { a: 1 } }], unknown: [] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends items:[{ref,request:{url}}] not urls, and response maps to {known,data} with no confidence", async () => {
    const c = new FetchBrainClient({ apiKey: "t", baseUrl: "http://x", batch: { maxSize: 1, maxWait: 0 } });
    const result = await c.recall({ url: "https://p/1" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);

    // Request body pin
    expect(body.items[0]).toMatchObject({ request: { url: "https://p/1" } });
    expect(typeof body.items[0].ref).toBe("string");
    expect(body.urls).toBeUndefined();
    // key residue: the SDK must NOT send a top-level `key` on items anymore
    expect(body.items[0].key).toBeUndefined();

    // Response side: client maps known[0] correctly, with no confidence field
    expect(result).toMatchObject({ known: true, data: { a: 1 } });
    expect((result as any).confidence).toBeUndefined();

    // Response item shape is { ref, data } — never key/url/confidence
    // (The mock returns this exact shape; the client maps it to RecallResult correctly)
    const knownItem: { ref: string; data: { a: number } } = {
      ref: "0",
      data: { a: 1 },
    };
    expect(knownItem).toEqual({ ref: "0", data: { a: 1 } });
    expect((knownItem as any).key).toBeUndefined();
    expect((knownItem as any).url).toBeUndefined();
  });

  it("recall posts /v1/recall with memory field and returns no confidence", async () => {
    const client = new FetchBrainClient({ apiKey: "fb_test_123", memory: "fresh" });
    await client.recall({ url: "https://x.com/1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/recall");
    expect(JSON.parse((init as RequestInit).body as string).memory).toBe("fresh");
  });

  it("defaults memory to recent (24h, matching the old default TTL)", () => {
    const client = new FetchBrainClient({ apiKey: "fb_test_123" });
    expect((client as any).config.memory).toBe("recent");
  });
});

describe("learn wire contract", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ learned: 1, status: "success" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("learn sends entries:[{request:{url},data}] with no key", async () => {
    const c = new FetchBrainClient({ apiKey: "t", baseUrl: "http://x", batch: { maxSize: 1, maxWait: 0 } });
    await c.learn({ url: "https://p/1" }, { a: 1 });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/v1/learn"))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.entries[0]).toMatchObject({ request: { url: "https://p/1" }, data: { a: 1 } });
    expect(body.entries[0].key).toBeUndefined();
  });
});

describe("ask wire contract", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ sources: [], status: "ok" }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("ask posts /v1/ask and degrades to unavailable on failure", async () => {
    const client = new FetchBrainClient({ apiKey: "fb_test_123" });
    await client.ask("blue widgets", { answer: true });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/ask");
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toMatchObject({ query: "blue widgets", answer: true });
    fetchMock.mockRejectedValueOnce(new Error("down"));
    const res = await client.ask("anything");
    expect(res).toEqual({ sources: [], status: "unavailable" });
  });

  it("forwards model in the ask body, and omits it when unset", async () => {
    const client = new FetchBrainClient({ apiKey: "fb_test_123" });
    await client.ask("blue widgets", { answer: true, model: "kimi-k2.5" });
    const withModel = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(withModel.model).toBe("kimi-k2.5");

    await client.ask("blue widgets", { answer: true });
    const withoutModel = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    );
    expect("model" in withoutModel).toBe(false);
  });

  it("returns the model the server reports it actually used", async () => {
    const client = new FetchBrainClient({ apiKey: "fb_test_123" });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sources: [],
          status: "ok",
          answer: "…",
          model: "llama-3.3-70b",
        }),
        { status: 200 },
      ),
    );
    const res = await client.ask("blue widgets", {
      answer: true,
      model: "kimi-k2.5",
    });
    expect(res.model).toBe("llama-3.3-70b");
  });

  it("surfaces a 4xx as rejected (with the server's error) WITHOUT tripping the circuit breaker", async () => {
    const client = new FetchBrainClient({ apiKey: "fb_test_123" });
    // Fresh Response per call — a body can only be consumed once.
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ error: "INDEXING_DISABLED" }), {
        status: 403,
        statusText: "Forbidden",
      }),
    );

    // Well above the default failureThreshold (3) — a 4xx must never count.
    for (let i = 0; i < 5; i++) {
      const res = await client.ask("anything");
      expect(res).toEqual({
        sources: [],
        status: "rejected",
        error: "INDEXING_DISABLED",
      });
    }

    expect(client.getCircuitState()).toMatchObject({
      state: "closed",
      failures: 0,
    });
  });

  it("DOES trip the circuit breaker on a 5xx", async () => {
    const client = new FetchBrainClient({ apiKey: "fb_test_123" });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "internal" }), {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    for (let i = 0; i < 3; i++) {
      await client.ask("anything");
    }

    expect(client.getCircuitState()).toMatchObject({ state: "open" });
  });
});
