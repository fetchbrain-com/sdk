/**
 * A learn rejection (4xx) is the request being refused, not the API degrading:
 * it must never trip the circuit breaker shared with recall. On the fair-use
 * learn cap (403 details.code LEARN_CAP_EXCEEDED) the client stops sending
 * learns for the rest of its life, warns once, and keeps recalling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchBrainClient } from "../src/client";

const capBody = JSON.stringify({
  error: "Monthly learning limit reached.",
  code: "FORBIDDEN",
  details: { code: "LEARN_CAP_EXCEEDED" },
});

function api(learnResponse: () => Response) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === "/v1/learn") return learnResponse();
    return new Response(JSON.stringify({ known: [], unknown: [{ ref: "0" }] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, learnCalls: () => calls.filter((p) => p === "/v1/learn").length };
}

const newClient = () =>
  new FetchBrainClient({
    apiKey: "fb_test_1",
    baseUrl: "http://x",
    batch: { maxSize: 1, maxWait: 0 },
  });

describe("learn cap / learn 4xx handling", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("learn 4xx never trips the breaker, so recall keeps hitting the API", async () => {
    const a = api(() => new Response(JSON.stringify({ error: "bad" }), { status: 400 }));
    const c = newClient();
    for (let i = 0; i < 5; i++) {
      const r = await c.learn({ url: `https://p/${i}` }, { i });
      expect(r.status).toBe("rejected");
    }
    expect(c.getCircuitState()).toMatchObject({ state: "closed", failures: 0 });
    await c.recall({ url: "https://p/r" });
    expect(a.calls).toContain("/v1/recall");
  });

  it("LEARN_CAP_EXCEEDED stops further learn calls, warns once, recall unaffected", async () => {
    const a = api(() => new Response(capBody, { status: 403 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = newClient();
    for (let i = 0; i < 4; i++) {
      expect((await c.learn({ url: `https://p/${i}` }, { i })).status).toBe("rejected");
    }
    expect(a.learnCalls()).toBe(1);
    const capWarnings = warn.mock.calls.filter((args) => args.join(" ").includes("learning limit"));
    expect(capWarnings).toHaveLength(1);
    expect(c.getCircuitState()).toMatchObject({ state: "closed", failures: 0 });
    await c.recall({ url: "https://p/r" });
    expect(a.calls).toContain("/v1/recall");
  });

  it("the learn pause lifts at the start of the next UTC month", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-30T23:00:00Z"));
    const a = api(() => new Response(capBody, { status: 403 }));
    const c = newClient();
    await c.learn({ url: "https://p/1" }, {});
    await c.learn({ url: "https://p/2" }, {});
    expect(a.learnCalls()).toBe(1); // paused
    vi.setSystemTime(new Date("2026-12-01T00:00:01Z"));
    await c.learn({ url: "https://p/3" }, {});
    expect(a.learnCalls()).toBe(2); // new month: tries again
    vi.useRealTimers();
  });

  it("the cap code pauses learning whatever 4xx status carries it", async () => {
    const a = api(() => new Response(capBody, { status: 429 }));
    const c = newClient();
    await c.learn({ url: "https://p/1" }, {});
    await c.learn({ url: "https://p/2" }, {});
    expect(a.learnCalls()).toBe(1);
    expect(c.getCircuitState()).toMatchObject({ state: "closed", failures: 0 });
  });

  it("a learn 429 pauses learns for Retry-After, never trips the recall breaker", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T10:00:00Z"));
    const a = api(() =>
      new Response(JSON.stringify({ error: "slow down" }), { status: 429, headers: { "Retry-After": "10" } }),
    );
    const c = newClient();
    for (let i = 0; i < 4; i++) await c.learn({ url: `https://p/${i}` }, { i });
    expect(a.learnCalls()).toBe(1); // paused after the first 429
    expect(c.getCircuitState()).toMatchObject({ state: "closed", failures: 0 });
    await c.recall({ url: "https://p/r" });
    expect(a.calls).toContain("/v1/recall");
    vi.setSystemTime(new Date("2026-11-22T10:00:11Z"));
    await c.learn({ url: "https://p/later" }, {});
    expect(a.learnCalls()).toBe(2); // pause lifted
    vi.useRealTimers();
  });

  it("a learn 5xx still trips the breaker", async () => {
    api(() => new Response(JSON.stringify({ error: "internal" }), { status: 500 }));
    const c = newClient();
    for (let i = 0; i < 3; i++) await c.learn({ url: `https://p/${i}` }, { i });
    expect(c.getCircuitState()).toMatchObject({ state: "open" });
  });
});
