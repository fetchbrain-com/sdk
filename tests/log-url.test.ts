/**
 * Per-request log lines: debug-only, and every URL they print goes through `logUrl`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchBrain } from "../src/enhance";
import type { FetchBrainConfig } from "../src/types";

vi.mock("../src/client", () => {
  const mockQuery = vi.fn();
  const mockLearn = vi.fn();
  return {
    FetchBrainClient: vi.fn().mockImplementation(() => ({
      recall: mockQuery,
      learn: mockLearn,
      waitForLearnRoom: vi.fn().mockResolvedValue(true),
      stats: vi.fn(),
      sendTelemetry: vi.fn(),
      getConfig: () => ({}),
    })),
    setScrapeContext: vi.fn(),
    clearScrapeContext: vi.fn(),
    __mockQuery: mockQuery,
    __mockLearn: mockLearn,
  };
});

import { __mockQuery, __mockLearn } from "../src/client";

const URL_A = "https://example.com/internal/api/item?id=42";

function createMockCrawler(handler = vi.fn()) {
  return {
    requestHandler: handler,
    run: vi.fn().mockResolvedValue({ requestsFinished: 1 }),
    constructor: { name: "MockCrawler" },
  };
}

type Spies = Record<"debug" | "info" | "warn" | "error" | "log", ReturnType<typeof vi.spyOn>>;
let spies: Spies;
const printed = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((args: unknown[]) => args.map(String).join(" "));
const allPrinted = () => Object.values(spies).flatMap(printed);

beforeEach(() => {
  vi.clearAllMocks();
  (__mockLearn as any).mockResolvedValue({ learned: 1 });
  spies = {
    debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
  };
});

afterEach(() => {
  for (const spy of Object.values(spies)) spy.mockRestore();
});

/** Drive every request path that logs a URL. */
async function driveAllPaths(config: FetchBrainConfig) {
  const errors: string[] = [];
  const run = async (cfg: Partial<FetchBrainConfig>, ctx: Record<string, any>, handler = vi.fn()) => {
    const enhanced = FetchBrain.enhance(createMockCrawler(handler), { ...config, ...cfg });
    await enhanced.requestHandler({ pushData: vi.fn(), ...ctx }).catch((e: Error) => errors.push(e.message));
  };
  const known = { known: true, data: { title: "Known" } };

  // auto-skip on a known page
  (__mockQuery as any).mockResolvedValueOnce(known);
  await run({}, { request: { url: URL_A, label: "detail" } });
  // context.brain.use()
  (__mockQuery as any).mockResolvedValueOnce(known);
  await run({ alwaysRun: true }, { request: { url: URL_A } }, vi.fn(async (ctx) => ctx.brain.use()));
  // alwaysRun on a known page
  (__mockQuery as any).mockResolvedValueOnce(known);
  await run({ alwaysRun: true }, { request: { url: URL_A } });
  // unknown page (learning)
  (__mockQuery as any).mockResolvedValueOnce({ known: false });
  await run({}, { request: { url: URL_A } }, vi.fn(async (ctx) => ctx.pushData({ title: "New" })));
  // skipLabels bypass
  await run({ skipLabels: ["search"] }, { request: { url: URL_A, label: "search" } });
  // POST with a default uniqueKey
  (__mockQuery as any).mockResolvedValueOnce({ known: false });
  await run({}, { request: { url: URL_A, method: "POST", uniqueKey: URL_A } });
  // pre-recalled known request whose remembered data is gone (thrown error message)
  (__mockQuery as any).mockResolvedValueOnce({ known: false });
  await run({}, { request: { url: URL_A, skipNavigation: true, userData: { __fetchBrainResult: { known: true } } } });

  return errors;
}

describe("per-request log lines", () => {
  it("Recalled / Used brain data lines are debug, not info (debug off: not printed at all)", async () => {
    await driveAllPaths({ apiKey: "k", debug: false });
    expect(printed(spies.info).some((l) => l.includes(URL_A))).toBe(false);
    expect(printed(spies.debug).some((l) => l.includes(URL_A))).toBe(false);
  });

  it("with debug on, Recalled and Used brain data print at debug level with the URL", async () => {
    await driveAllPaths({ apiKey: "k", debug: true });
    const debug = printed(spies.debug);
    expect(debug.some((l) => l.includes(`Recalled: ${URL_A} [detail]`))).toBe(true);
    expect(debug.some((l) => l.includes("Used brain data") && l.includes(URL_A))).toBe(true);
    expect(printed(spies.info).some((l) => l.includes(URL_A))).toBe(false);
  });
});

describe("logUrl", () => {
  it("rewrites the URL in every log line and error message", async () => {
    const logUrl = vi.fn(({ uniqueKey, label }) => `item:${label ?? "default"}:${uniqueKey.length}`);
    const errors = await driveAllPaths({ apiKey: "k", debug: true, logUrl });

    const lines = [...allPrinted(), ...errors];
    expect(lines.some((l) => l.includes(URL_A))).toBe(false);
    expect(printed(spies.debug).some((l) => /Recalled: item:detail:\d+ \[detail\]/.test(l))).toBe(true);
    expect(printed(spies.warn).some((l) => l.includes("POST item:default:") && l.includes("default uniqueKey"))).toBe(true);
    expect(errors.some((e) => e.includes("item:default:") && e.includes("no longer available"))).toBe(true);
    // called with the cleaned request: no SDK bookkeeping keys in userData
    for (const [arg] of logUrl.mock.calls) {
      expect(arg.url).toBe(URL_A);
      expect(arg.userData).not.toHaveProperty("__fetchBrainResult");
      expect(arg.userData).not.toHaveProperty("fetchBrainData");
    }
  });

  it("returning undefined prints the line without the URL", async () => {
    await driveAllPaths({ apiKey: "k", debug: true, logUrl: () => undefined });
    expect(allPrinted().some((l) => l.includes(URL_A))).toBe(false);
    expect(printed(spies.debug).some((l) => /Recalled \[detail\]$/.test(l))).toBe(true);
    expect(printed(spies.warn).some((l) => l.includes("POST request has a default uniqueKey"))).toBe(true);
  });

  it("a throwing logUrl does not break the crawl and never leaks the raw URL", async () => {
    const pushed: unknown[] = [];
    const errors = await driveAllPaths({
      apiKey: "k",
      debug: true,
      logUrl: () => {
        throw new Error("logUrl failed");
      },
    });
    expect([...allPrinted(), ...errors].some((l) => l.includes(URL_A))).toBe(false);
    // only the expected memory-gone error surfaced; the logUrl error never did
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("a request skipped its fetch");

    // and the recalled data is still delivered
    (__mockQuery as any).mockResolvedValueOnce({ known: true, data: { title: "Known" } });
    const enhanced = FetchBrain.enhance(createMockCrawler(), {
      apiKey: "k",
      debug: true,
      logUrl: () => {
        throw new Error("logUrl failed");
      },
    });
    await enhanced.requestHandler({ request: { url: URL_A }, pushData: async (d: unknown) => void pushed.push(d) });
    expect(pushed).toEqual([{ title: "Known" }]);
  });

  it("an async logUrl that rejects omits the URL without an unhandled rejection", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    try {
      await driveAllPaths({ apiKey: "k", debug: true, logUrl: (async () => { throw new Error("nope"); }) as any });
      await new Promise((r) => setTimeout(r, 10));
      expect(allPrinted().some((l) => l.includes(URL_A))).toBe(false);
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("is not called for debug-only lines when debug is off", async () => {
    const logUrl = vi.fn(() => "x");
    (__mockQuery as any).mockResolvedValueOnce({ known: true, data: { title: "Known" } });
    const enhanced = FetchBrain.enhance(createMockCrawler(), { apiKey: "k", logUrl });
    await enhanced.requestHandler({ request: { url: URL_A }, pushData: vi.fn() });
    expect(logUrl).not.toHaveBeenCalled();
  });
});
