import { describe, it, expect } from "vitest";
import { FetchBrainClient } from "../src/client";

describe("telemetry default", () => {
  it("is OFF by default (opt-in model)", () => {
    const client = new FetchBrainClient({ apiKey: "fb_test_123" });
    expect(client.isTelemetryEnabled()).toBe(false);
  });

  it("is enabled only when the developer opts in", () => {
    const client = new FetchBrainClient({
      apiKey: "fb_test_123",
      telemetry: { enabled: true },
    });
    expect(client.isTelemetryEnabled()).toBe(true);
  });
});
