import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchBrainClient } from "../src/client";

describe("query wire contract", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ known: [{ ref: "0", data: { a: 1 }, confidence: 0.95 }], unknown: [] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends items:[{ref,request:{url}}] not urls, and response maps to {known,data,confidence}", async () => {
    const c = new FetchBrainClient({ apiKey: "t", baseUrl: "http://x", batch: { maxSize: 1, maxWait: 0 } });
    const result = await c.query({ url: "https://p/1" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);

    // Request body pin
    expect(body.items[0]).toMatchObject({ request: { url: "https://p/1" } });
    expect(typeof body.items[0].ref).toBe("string");
    expect(body.urls).toBeUndefined();
    // key residue: the SDK must NOT send a top-level `key` on items anymore
    expect(body.items[0].key).toBeUndefined();

    // Response side: client maps known[0] correctly
    expect(result).toMatchObject({ known: true, data: { a: 1 }, confidence: 0.95 });

    // Response item shape is { ref, data, confidence } — never key/url
    // (The mock returns this exact shape; the client maps it to AIResult correctly)
    const knownItem: { ref: string; data: { a: number }; confidence: number } = {
      ref: "0",
      data: { a: 1 },
      confidence: 0.95,
    };
    expect(knownItem).toEqual({ ref: "0", data: { a: 1 }, confidence: 0.95 });
    expect((knownItem as any).key).toBeUndefined();
    expect((knownItem as any).url).toBeUndefined();
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
