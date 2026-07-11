import { describe, it, expect } from "vitest";
import { buildNativeContext, getPlatformBuildId } from "../src/native-context";

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
