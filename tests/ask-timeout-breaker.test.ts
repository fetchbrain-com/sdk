import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchBrainClient } from "../src/client";

type Route = (init: RequestInit) => Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** Resolves after `ms`, or rejects when the request's signal aborts (like real fetch). */
const delayed = (ms: number, body: unknown): Route => (init) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(json(body)), ms);
    init.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

const ASK_OK = { sources: [], status: "ok", answer: "42" };
const RECALL_OK = { known: [], unknown: ["0"] };

describe("ask timeout and its own circuit breaker", () => {
  let routes: { ask: Route; recall: Route };
  let fetchMock: ReturnType<typeof vi.fn>;
  const calls = (path: string) =>
    fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(path)).length;

  beforeEach(() => {
    routes = {
      ask: async () => json(ASK_OK),
      recall: async () => json(RECALL_OK),
    };
    fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/ask")) return routes.ask(init);
      if (url.endsWith("/v1/recall")) return routes.recall(init);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const newClient = (extra: Record<string, unknown> = {}) =>
    new FetchBrainClient({
      apiKey: "fb_test_x",
      batch: { maxSize: 1, maxWait: 0 },
      ...extra,
    });

  describe("timeout", () => {
    beforeEach(() => vi.useFakeTimers());

    it("defaults to 60s, so a slow answer (15s) still comes back", async () => {
      routes.ask = delayed(15_000, ASK_OK);
      const client = newClient();
      const p = client.ask("q", { answer: true });
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(p).resolves.toMatchObject({ status: "ok", answer: "42" });
    });

    it("gives up at the default 60s", async () => {
      routes.ask = delayed(90_000, ASK_OK);
      const client = newClient();
      const p = client.ask("q", { answer: true });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(p).resolves.toEqual({ sources: [], status: "unavailable" });
    });

    it("honours the askTimeout option", async () => {
      routes.ask = delayed(5_000, ASK_OK);
      const client = newClient({ askTimeout: 2_000 });
      expect(client.getConfig().askTimeout).toBe(2_000);
      const p = client.ask("q");
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(p).resolves.toEqual({ sources: [], status: "unavailable" });
    });

    it("lets a per-call timeout win over askTimeout", async () => {
      routes.ask = delayed(5_000, ASK_OK);
      const client = newClient({ askTimeout: 2_000 });
      const p = client.ask("q", { timeout: 10_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toMatchObject({ status: "ok" });

      const short = client.ask("q", { timeout: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(short).resolves.toEqual({ sources: [], status: "unavailable" });
    });

    it("does not send the per-call timeout to the API", async () => {
      vi.useRealTimers();
      const client = newClient();
      await client.ask("q", { timeout: 5_000 });
      const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/v1/ask"))!;
      expect(JSON.parse((call[1] as RequestInit).body as string)).not.toHaveProperty("timeout");
    });
  });

  describe("invalid timeouts fall back to the default", () => {
    // Node clamps these setTimeout delays to ~1ms, which would abort every call.
    const invalid: [string, number][] = [
      ["Infinity", Infinity],
      ["-5", -5],
      ["0", 0],
      ["NaN", NaN],
      ["3_600_000_000", 3_600_000_000],
    ];

    it.each(invalid)("askTimeout %s uses 60s", (_name, value) => {
      expect(newClient({ askTimeout: value }).getConfig().askTimeout).toBe(60_000);
    });

    it.each(invalid)("timeout %s uses 1500ms", (_name, value) => {
      expect(newClient({ timeout: value }).getConfig().timeout).toBe(1_500);
    });

    it("keeps a valid value", () => {
      const config = newClient({ askTimeout: 5_000, timeout: 5_000 }).getConfig();
      expect(config.askTimeout).toBe(5_000);
      expect(config.timeout).toBe(5_000);
    });

    it("does not throw and logs a debug line", () => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      expect(() => newClient({ askTimeout: Infinity, debug: true })).not.toThrow();
      expect(debug.mock.calls.some((c) => String(c[0]).includes("ignoring invalid askTimeout"))).toBe(true);
      debug.mockRestore();
    });

    it.each(invalid)("per-call timeout %s uses askTimeout instead of aborting at once", async (_name, value) => {
      vi.useFakeTimers();
      routes.ask = delayed(5_000, ASK_OK);
      const client = newClient({ askTimeout: 10_000 });
      const p = client.ask("q", { timeout: value });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toMatchObject({ status: "ok" });
    });

    it("a 5000ms per-call timeout is kept", async () => {
      vi.useFakeTimers();
      routes.ask = delayed(8_000, ASK_OK);
      const client = newClient();
      const p = client.ask("q", { timeout: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ sources: [], status: "unavailable" });
    });
  });

  describe("breaker isolation", () => {
    it("the ask breaker's open warning names Ask and says recall and learn are unaffected", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      routes.ask = async () => json({ error: "boom" }, 503);
      const client = newClient();
      for (let i = 0; i < 3; i++) await client.ask("q");
      const lines = warn.mock.calls.map((c) => String(c[0]));
      warn.mockRestore();
      const opened = lines.find((l) => l.includes("circuit opened"));
      expect(opened).toContain("Ask circuit opened after 3 failures");
      expect(opened).toContain("recall and learn are unaffected");
      expect(opened).not.toContain("without optimization");
    });

    it("the recall breaker's open warning is unchanged", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      routes.recall = async () => json({ error: "boom" }, 503);
      const client = newClient();
      for (let i = 0; i < 3; i++) await client.recall({ url: `https://a.test/${i}` });
      const lines = warn.mock.calls.map((c) => String(c[0]));
      warn.mockRestore();
      expect(lines.some((l) => l.includes("Circuit opened after 3 failures. Scraper will continue without optimization."))).toBe(true);
      expect(lines.some((l) => l.includes("Ask circuit"))).toBe(false);
    });

    it("ask failures do not open the recall breaker", async () => {
      routes.ask = async () => json({ error: "boom" }, 503);
      const client = newClient();

      for (let i = 0; i < 5; i++) {
        await expect(client.ask("q")).resolves.toEqual({ sources: [], status: "unavailable" });
      }
      // The ask breaker opened after 3 failures: later asks answer locally.
      expect(calls("/v1/ask")).toBe(3);

      expect(client.getCircuitState().state).toBe("closed");
      const result = await client.recall({ url: "https://a.test/1" });
      expect(result).toEqual({ known: false });
      expect(calls("/v1/recall")).toBe(1);
    });

    it("an open recall breaker does not block ask", async () => {
      routes.recall = async () => json({ error: "boom" }, 503);
      const client = newClient();

      for (let i = 0; i < 3; i++) {
        await client.recall({ url: `https://a.test/${i}` });
      }
      expect(client.getCircuitState().state).toBe("open");

      await expect(client.ask("q")).resolves.toMatchObject({ status: "ok" });
      expect(calls("/v1/ask")).toBe(1);
    });

    it("a rejected API key still blocks ask", async () => {
      routes.recall = async () => json({ error: "invalid key" }, 401);
      const client = newClient();
      await client.recall({ url: "https://a.test/1" });

      await expect(client.ask("q")).resolves.toEqual({ sources: [], status: "unavailable" });
      expect(calls("/v1/ask")).toBe(0);
    });

    it("resetCircuit() closes the ask breaker too", async () => {
      routes.ask = async () => json({ error: "boom" }, 503);
      const client = newClient();
      for (let i = 0; i < 3; i++) await client.ask("q");

      client.resetCircuit();
      routes.ask = async () => json(ASK_OK);
      await expect(client.ask("q")).resolves.toMatchObject({ status: "ok" });
    });
  });
});
