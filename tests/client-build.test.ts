import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchBrainClient } from "../src/client";

describe("learn build transmission", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ learned: 1, status: "success" }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("includes build on learn when refreshOnRebuild is true", async () => {
    vi.stubEnv("CUSTOM_BUILD_ID", "b42");
    const client = new FetchBrainClient({
      apiKey: "fb_test_x",
      refreshOnRebuild: true,
      batch: { maxSize: 1, maxWait: 0 },
    });
    await client.learn({ url: "https://a.test/1" }, { ok: 1 });

    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/v1/learn"))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.build).toBe("b42");
  });

  it("omits build on learn by default", async () => {
    vi.stubEnv("CUSTOM_BUILD_ID", "b42");
    const client = new FetchBrainClient({
      apiKey: "fb_test_x",
      batch: { maxSize: 1, maxWait: 0 },
    });
    await client.learn({ url: "https://a.test/1" }, { ok: 1 });

    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/v1/learn"))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.build).toBeUndefined();
  });

  it("omits build on learn when refreshOnRebuild is true but no platform build id is set", async () => {
    const client = new FetchBrainClient({
      apiKey: "fb_test_x",
      refreshOnRebuild: true,
      batch: { maxSize: 1, maxWait: 0 },
    });
    await client.learn({ url: "https://a.test/1" }, { ok: 1 });

    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/v1/learn"))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.build).toBeUndefined();
  });
});
