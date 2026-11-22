import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FetchBrainClient } from "../src/client";

describe("client context headers", () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends the configured scraper name, normalized", async () => {
    const client = new FetchBrainClient({ apiKey: "fb_test_123", scraper: "Shop-A" });
    await client.stats();
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(JSON.parse(headers["X-FB-Context"]).FETCHBRAIN_SCRAPER_ID).toBe("shop-a");
    expect(client.getConfig().scraper).toBe("Shop-A");
  });

  it("drops an invalid scraper name with a warning, never throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const client = new FetchBrainClient({ apiKey: "fb_test_123", scraper: "has space" });
    await client.stats();
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    const ctx = headers["X-FB-Context"] ? JSON.parse(headers["X-FB-Context"]) : {};
    expect(ctx.FETCHBRAIN_SCRAPER_ID).toBeUndefined();
    const printed = [...warn.mock.calls, ...log.mock.calls].flat().join(" ");
    expect(printed).toMatch(/invalid scraper name/);
    expect(printed).not.toMatch(/has space/);
    warn.mockRestore();
    log.mockRestore();
  });

  it("sends native platform vars in X-FB-Context with no platform-specific headers", async () => {
    vi.stubEnv("SCRAPER_ID", "my-scraper");
    vi.stubEnv("SCRAPER_RUN_ID", "run-42");

    const client = new FetchBrainClient({ apiKey: "fb_test_123" });
    await client.stats();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;

    expect(JSON.parse(headers["X-FB-Context"])).toMatchObject({
      SCRAPER_ID: "my-scraper",
      SCRAPER_RUN_ID: "run-42",
    });
    expect(headers["X-FB-Build"]).toBeUndefined();
  });

  it("only includes platform-identity vars in X-FB-Context — never credentials or generic env", async () => {
    vi.stubEnv("DB_PASSWORD", "hunter2");
    vi.stubEnv("API_KEY", "sk-123");
    vi.stubEnv("SAFE_VAR", "hello");
    vi.stubEnv("SCRAPER_RUN_ID", "run-42");

    const client = new FetchBrainClient({ apiKey: "fb_test_123" });
    await client.stats();

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;

    expect(headers["X-FB-Context"]).toBeDefined();
    const ctx = JSON.parse(headers["X-FB-Context"]);
    expect(ctx["SCRAPER_RUN_ID"]).toBe("run-42");
    expect(ctx["DB_PASSWORD"]).toBeUndefined();
    expect(ctx["API_KEY"]).toBeUndefined();
    expect(ctx["SAFE_VAR"]).toBeUndefined(); // not *_ID-shaped — stays local
  });
});
