import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlaywrightCrawler, CheerioCrawler, AdaptivePlaywrightCrawler, createPlaywrightRouter } from "crawlee";
import { FetchBrain } from "../src/enhance";
import type { FetchBrainConfig } from "../src/types";

vi.mock("../src/client", () => {
  const recall = vi.fn();
  const recallBulk = vi.fn().mockResolvedValue([]);
  return {
    FetchBrainClient: vi.fn().mockImplementation(() => ({
      recall,
      recallBulk,
      learn: vi.fn().mockResolvedValue({ learned: 0, status: "success" }),
      waitForLearnRoom: vi.fn().mockResolvedValue(true),
      sendTelemetry: vi.fn(),
      getConfig: () => ({}),
    })),
    setScrapeContext: vi.fn(),
    clearScrapeContext: vi.fn(),
    __recall: recall,
    __recallBulk: recallBulk,
  };
});

import { __recall, __recallBulk } from "../src/client";

const config: FetchBrainConfig = { apiKey: "test-api-key", debug: false, learning: true };

function fakeContext(url: string) {
  return {
    request: { url, userData: {}, label: undefined, retryCount: 0 },
    pushData: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), debug: vi.fn(), warning: vi.fn(), error: vi.fn() },
  } as any;
}

describe("browser crawler wrapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps userProvidedRequestHandler on PlaywrightCrawler", async () => {
    (__recall as any).mockResolvedValue({ known: true, data: { t: 1 } });
    const userFn = vi.fn();
    const crawler = new PlaywrightCrawler({ requestHandler: userFn });
    FetchBrain.enhance(crawler, config);

    const handler = (crawler as any).userProvidedRequestHandler;
    expect(handler).not.toBe(userFn);

    const ctx = fakeContext("https://a.test/x");
    await handler(ctx);
    expect(userFn).not.toHaveBeenCalled();
    expect(ctx.pushData).toHaveBeenCalledWith({ t: 1 });
  });

  it("wraps a router-based PlaywrightCrawler", async () => {
    (__recall as any).mockResolvedValue({ known: true, data: { t: 2 } });
    const userFn = vi.fn();
    const router = createPlaywrightRouter();
    router.addDefaultHandler(userFn);
    const crawler = new PlaywrightCrawler({ requestHandler: router });
    FetchBrain.enhance(crawler, config);

    const ctx = fakeContext("https://a.test/y");
    await (crawler as any).userProvidedRequestHandler(ctx);
    expect(userFn).not.toHaveBeenCalled();
    expect(ctx.pushData).toHaveBeenCalledWith({ t: 2 });
  });

  it("still wraps requestHandler on CheerioCrawler exactly once", async () => {
    (__recall as any).mockResolvedValue({ known: false });
    const userFn = vi.fn();
    const crawler = new CheerioCrawler({ requestHandler: userFn });
    FetchBrain.enhance(crawler, config);

    const handler = (crawler as any).requestHandler;
    expect(handler).not.toBe(userFn);
    await handler(fakeContext("https://a.test/z"));
    expect(userFn).toHaveBeenCalledTimes(1);
  });

  it("does not mark skipNavigation when no handler was wrapped", async () => {
    const originalAddRequests = vi.fn().mockResolvedValue(undefined);
    const crawler: any = {
      addRequests: originalAddRequests,
      run: vi.fn().mockResolvedValue(undefined),
      constructor: { name: "HandlerlessCrawler" },
    };
    (__recallBulk as any).mockResolvedValue([{ known: true, data: { t: 3 } }]);
    FetchBrain.enhance(crawler, config);
    await crawler.addRequests([{ url: "https://a.test/1" }]);
    const passed = originalAddRequests.mock.calls[0][0];
    expect(passed[0].skipNavigation).toBeUndefined();
  });

  it("marks skipNavigation for a known URL when the handler is wrapped (control)", async () => {
    const originalAddRequests = vi.fn().mockResolvedValue(undefined);
    const crawler: any = {
      requestHandler: vi.fn(),
      addRequests: originalAddRequests,
      run: vi.fn().mockResolvedValue(undefined),
      constructor: { name: "HttpLikeCrawler" },
    };
    (__recallBulk as any).mockResolvedValue([{ known: true, data: { t: 4 } }]);
    FetchBrain.enhance(crawler, config);
    await crawler.addRequests([{ url: "https://a.test/2" }]);
    const passed = originalAddRequests.mock.calls[0][0];
    expect(passed[0].skipNavigation).toBe(true);
  });

  it("leaves AdaptivePlaywrightCrawler unmodified (unsupported)", async () => {
    const userFn = vi.fn();
    const crawler: any = new AdaptivePlaywrightCrawler({ requestHandler: userFn });
    const adaptiveBefore = crawler.adaptiveRequestHandler;
    const providedBefore = crawler.userProvidedRequestHandler;
    const addRequestsBefore = crawler.addRequests;
    FetchBrain.enhance(crawler, config);
    expect(crawler.adaptiveRequestHandler).toBe(adaptiveBefore);
    expect(crawler.userProvidedRequestHandler).toBe(providedBefore);
    expect(crawler.addRequests).toBe(addRequestsBefore);
  });
});
