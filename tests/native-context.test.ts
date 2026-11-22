import { describe, it, expect } from "vitest";
import { buildNativeContext, getPlatformBuildId, normalizeScraperName, resolveScraperName } from "../src/native-context";

describe("getPlatformBuildId", () => {
  it("returns the platform build identifier", () => {
    expect(getPlatformBuildId({ SCRAPER_BUILD_ID: "1.2.3" })).toBe("1.2.3");
  });

  it("returns a custom platform BUILD_ID", () => {
    expect(getPlatformBuildId({ CI_BUILD_ID: "abc-42" })).toBe("abc-42");
  });

  it("returns the first BUILD_ID when multiple are present", () => {
    const id = getPlatformBuildId({
      SCRAPER_BUILD_ID: "1.2.3",
      CI_BUILD_ID: "abc-42",
    });
    // Should find one of them (Object.keys order)
    expect(id).toBeDefined();
  });

  it("returns undefined when no BUILD_ID var exists", () => {
    expect(getPlatformBuildId({})).toBeUndefined();
    expect(getPlatformBuildId({ BUILD_VERSION: "1.0" })).toBeUndefined();
  });
});

describe("buildNativeContext", () => {
  it("forwards platform-identity vars verbatim", () => {
    const header = buildNativeContext({
      SCRAPER_ID: "my-scraper",
      SCRAPER_BUILD_ID: "1.2.3",
      SCRAPER_RUN_ID: "run-42",
    });

    expect(header).toBeDefined();
    expect(JSON.parse(header!)).toEqual({
      SCRAPER_ID: "my-scraper",
      SCRAPER_BUILD_ID: "1.2.3",
      SCRAPER_RUN_ID: "run-42",
    });
  });

  it("forwards only *_ID-shaped names plus NODE_ENV/REGION/CI — nothing else", () => {
    const header = buildNativeContext({
      SCRAPER_ID: "my-scraper",
      NODE_ENV: "production",
      REGION: "eu-west-1",
      CI: "true",
      HOME: "/home/user",
      USER: "alice",
      PWD: "/srv/app",
      DATABASE_URL: "postgres://db.internal:5432/app",
      STRIPE_WEBHOOK_SIGNING: "whsec_abc123",
    });

    expect(JSON.parse(header!)).toEqual({
      CI: "true",
      NODE_ENV: "production",
      REGION: "eu-west-1",
      SCRAPER_ID: "my-scraper",
    });
  });

  it("never forwards credential-shaped names, even when *_ID-shaped", () => {
    const header = buildNativeContext({
      SCRAPER_ID: "my-scraper",
      AWS_ACCESS_KEY_ID: "AKIA123",
      API_TOKEN_ID: "tok_123",
      AUTH_SESSION_ID: "sess_123",
    });

    expect(JSON.parse(header!)).toEqual({ SCRAPER_ID: "my-scraper" });
  });

  it("never forwards credential-shaped values, whatever the name", () => {
    const header = buildNativeContext({
      SCRAPER_ID: "my-scraper",
      FEED_ENDPOINT_ID: "https://user:hunter2@internal.example.com/feed",
      SESSION_JWT_ID:
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpM",
    });

    expect(JSON.parse(header!)).toEqual({ SCRAPER_ID: "my-scraper" });
  });

  it("returns undefined when env is empty", () => {
    expect(buildNativeContext({})).toBeUndefined();
  });

  it("returns undefined when nothing is forwardable", () => {
    expect(
      buildNativeContext({
        DB_PASSWORD: "hunter2",
        API_KEY: "sk-123",
        AUTH_TOKEN: "abc",
        HOME: "/home/user",
      }),
    ).toBeUndefined();
  });

  it("skips empty and oversized values", () => {
    const header = buildNativeContext({
      SCRAPER_ID: "my-scraper",
      SCRAPER_RUN_ID: "",
      SCRAPER_BUILD_ID: "x".repeat(300),
    });

    expect(JSON.parse(header!)).toEqual({ SCRAPER_ID: "my-scraper" });
  });

  it("caps total serialized size at 2KB by dropping later keys, never producing invalid JSON", () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      env[`PLATFORM_${String(i).padStart(2, "0")}_ID`] = "v".repeat(100);
    }

    const header = buildNativeContext(env);

    expect(header!.length).toBeLessThanOrEqual(2048);
    // Still valid JSON with a deterministic (sorted) subset
    const keys = Object.keys(JSON.parse(header!));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("scraper name (FETCHBRAIN_SCRAPER_ID)", () => {
  it("normalizes valid names and rejects invalid ones", () => {
    expect(normalizeScraperName(" Shop-A ")).toBe("shop-a");
    for (const bad of [undefined, "", "_default", "has space", "a/b", "a".repeat(65)]) {
      expect(normalizeScraperName(bad)).toBeUndefined();
    }
  });

  it("puts the name first in the header", () => {
    const header = buildNativeContext({ A_ID: "x" }, "shop-a");
    expect(Object.keys(JSON.parse(header!))[0]).toBe("FETCHBRAIN_SCRAPER_ID");
  });

  it("keeps the name even when many long *_ID vars exhaust the header budget", () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 60; i++) env[`A_${String(i).padStart(2, "0")}_ID`] = "v".repeat(200);
    const header = buildNativeContext(env, "shop-a");
    expect(header!.length).toBeLessThanOrEqual(2048);
    expect(JSON.parse(header!).FETCHBRAIN_SCRAPER_ID).toBe("shop-a");
  });

  it("never forwards the raw env var; only the resolved name it is given", () => {
    expect(buildNativeContext({ FETCHBRAIN_SCRAPER_ID: "_default" })).toBeUndefined();
    expect(buildNativeContext({ FETCHBRAIN_SCRAPER_ID: "shop-a" })).toBeUndefined();
    expect(buildNativeContext({}, "has space")).toBeUndefined();
  });
});

describe("resolveScraperName", () => {
  it("option wins over the env var, normalized", () => {
    expect(resolveScraperName("From-Config", { FETCHBRAIN_SCRAPER_ID: "from-env" })).toEqual({
      name: "from-config",
      rejected: [],
    });
  });

  it("falls back to the env var when the option is unset or empty", () => {
    for (const option of [undefined, "", "  "]) {
      expect(resolveScraperName(option, { FETCHBRAIN_SCRAPER_ID: "Shop-A" })).toEqual({ name: "shop-a", rejected: [] });
    }
  });

  it("falls back to a valid env var when the option is invalid, reporting the option", () => {
    expect(resolveScraperName("Shop A", { FETCHBRAIN_SCRAPER_ID: "shop-a" })).toEqual({
      name: "shop-a",
      rejected: ["option"],
    });
  });

  it("reports every invalid source and yields no name", () => {
    expect(resolveScraperName("-shop", { FETCHBRAIN_SCRAPER_ID: "_default" })).toEqual({
      rejected: ["option", "FETCHBRAIN_SCRAPER_ID"],
    });
    expect(resolveScraperName(undefined, {})).toEqual({ rejected: [] });
  });
});
