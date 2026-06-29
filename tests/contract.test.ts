import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchBrainClient } from "../src/client";

describe("query wire contract", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ known: [], unknown: ["k1"] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends items:[{key,url}] not urls", async () => {
    const c = new FetchBrainClient({ apiKey: "t", baseUrl: "http://x", batch: { maxSize: 1, maxWait: 0 } });
    await c.query("k1", "https://p/1");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.items).toEqual([{ key: "k1", url: "https://p/1" }]);
    expect(body.urls).toBeUndefined();
  });
});

describe("learn wire contract", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ learned: 1, status: "success" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("learn sends entries:[{key,url,data}] with a key", async () => {
    const c = new FetchBrainClient({ apiKey: "t", baseUrl: "http://x", batch: { maxSize: 1, maxWait: 0 } });
    await c.learn("k1", { a: 1 }, "https://p/1");
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/v1/learn"))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.entries[0]).toMatchObject({ key: "k1", url: "https://p/1", data: { a: 1 } });
  });
});
