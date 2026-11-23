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

describe("telemetry buffer timer", () => {
  it("never keeps the process alive (plain Node scripts must exit after run())", async () => {
    const { TelemetryBuffer } = await import("../src/telemetry");
    const buf = new TelemetryBuffer({ flushInterval: 30_000 });
    const timer = (buf as any).flushTimer as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    await buf.stop();
  });
});
