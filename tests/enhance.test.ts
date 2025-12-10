import { describe, it, expect, vi, beforeEach } from "vitest";
import { FetchBrain, pushData, getCurrentContext } from "../src/enhance";
import type { FetchBrainConfig, AIResult, LearnResponse } from "../src/types";

// Mock the client module
vi.mock("../src/client", () => {
  const mockQuery = vi.fn();
  const mockLearn = vi.fn();
  const mockStats = vi.fn();
  const mockSendTelemetry = vi.fn();

  return {
    FetchBrainClient: vi.fn().mockImplementation(() => ({
      query: mockQuery,
      learn: mockLearn,
      stats: mockStats,
      sendTelemetry: mockSendTelemetry,
      getConfig: () => ({}),
    })),
    setScrapeContext: vi.fn(),
    clearScrapeContext: vi.fn(),
    // Export mocks for test access
    __mockQuery: mockQuery,
    __mockLearn: mockLearn,
    __mockStats: mockStats,
  };
});

// Get mock functions for assertions
import { __mockQuery, __mockLearn, __mockStats } from "../src/client";

// Create a mock Crawlee crawler
function createMockCrawler() {
  const handler = vi.fn();
  return {
    requestHandler: handler,
    run: vi.fn().mockResolvedValue({ requestsFinished: 1 }),
    constructor: { name: "MockCrawler" },
    _handler: handler, // For test access
  };
}

const testConfig: FetchBrainConfig = {
  apiKey: "test-api-key",
  debug: false,
  learning: true,
};

describe("FetchBrain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should create FetchBrain instance", () => {
      const fb = new FetchBrain(testConfig);
      expect(fb).toBeInstanceOf(FetchBrain);
    });
  });

  describe("query", () => {
    it("should query AI for URL knowledge", async () => {
      const mockResult: AIResult = {
        known: true,
        data: { title: "Test" },
        confidence: 0.95,
      };
      (__mockQuery as any).mockResolvedValueOnce(mockResult);

      const fb = new FetchBrain(testConfig);
      const result = await fb.query({ url: "https://example.com/test" });

      expect(result.known).toBe(true);
      expect(result.data).toEqual({ title: "Test" });
      expect(result.confidence).toBe(0.95);
    });

    it("should return unknown for new URLs", async () => {
      (__mockQuery as any).mockResolvedValueOnce({ known: false });

      const fb = new FetchBrain(testConfig);
      const result = await fb.query({ url: "https://example.com/new" });

      expect(result.known).toBe(false);
      expect(result.data).toBeUndefined();
    });
  });

  describe("learn", () => {
    it("should teach AI new data", async () => {
      const mockResponse: LearnResponse = { status: "accepted", learned: 1 };
      (__mockLearn as any).mockResolvedValueOnce(mockResponse);

      const fb = new FetchBrain(testConfig);
      const result = await fb.learn({
        url: "https://example.com/new",
        data: { title: "New Product" },
      });

      expect(result.status).toBe("accepted");
      expect(result.learned).toBe(1);
    });
  });

  describe("stats", () => {
    it("should return usage statistics", async () => {
      (__mockStats as any).mockResolvedValueOnce({
        queries: 100,
        recognized: 80,
        recognitionRate: 0.8,
        learned: 20,
        period: "day",
      });

      const fb = new FetchBrain(testConfig);
      const stats = await fb.stats();

      expect(stats?.queries).toBe(100);
      expect(stats?.recognitionRate).toBe(0.8);
    });
  });
});

describe("FetchBrain.enhance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("enhancement", () => {
    it("should return enhanced crawler with fetchBrain property", () => {
      const crawler = createMockCrawler();
      const enhanced = FetchBrain.enhance(crawler, testConfig);

      expect(enhanced).toBe(crawler);
      expect(enhanced.fetchBrain).toBeDefined();
    });

    it("should preserve original crawler properties", () => {
      const crawler = createMockCrawler();
      crawler.customProp = "test";

      const enhanced = FetchBrain.enhance(crawler, testConfig);

      expect((enhanced as any).customProp).toBe("test");
    });

    it("should handle crawler without request handler gracefully", () => {
      const crawler = { run: vi.fn() };
      const enhanced = FetchBrain.enhance(crawler, testConfig);

      expect(enhanced.fetchBrain).toBeDefined();
    });
  });

  describe("AI query before request", () => {
    it("should query AI before running handler", async () => {
      (__mockQuery as any).mockResolvedValue({ known: false });

      const crawler = createMockCrawler();
      const enhanced = FetchBrain.enhance(crawler, testConfig);

      const context = {
        request: { url: "https://example.com/test" },
        pushData: vi.fn(),
      };

      await enhanced.requestHandler(context);

      expect(__mockQuery).toHaveBeenCalledWith("https://example.com/test");
    });

    it("should skip handler when AI knows and alwaysRun is false", async () => {
      (__mockQuery as any).mockResolvedValue({
        known: true,
        data: { title: "Known Product" },
        confidence: 0.95,
      });

      const handlerFn = vi.fn();
      const crawler = {
        requestHandler: handlerFn,
        run: vi.fn(),
        constructor: { name: "MockCrawler" },
      };

      const enhanced = FetchBrain.enhance(crawler, {
        ...testConfig,
        alwaysRun: false,
      });

      const pushData = vi.fn();
      const context = {
        request: { url: "https://example.com/known" },
        pushData,
      };

      await enhanced.requestHandler(context);

      // Handler should NOT be called
      expect(handlerFn).not.toHaveBeenCalled();
      // AI data should be pushed
      expect(pushData).toHaveBeenCalledWith({ title: "Known Product" });
    });

    it("should run handler when AI knows but alwaysRun is true", async () => {
      (__mockQuery as any).mockResolvedValue({
        known: true,
        data: { title: "Known Product" },
        confidence: 0.95,
      });

      const handlerFn = vi.fn();
      const crawler = {
        requestHandler: handlerFn,
        run: vi.fn(),
        constructor: { name: "MockCrawler" },
      };

      const enhanced = FetchBrain.enhance(crawler, {
        ...testConfig,
        alwaysRun: true,
      });

      const context = {
        request: { url: "https://example.com/known" },
        pushData: vi.fn(),
      };

      await enhanced.requestHandler(context);

      // Handler should be called even though AI knows
      expect(handlerFn).toHaveBeenCalled();
    });
  });

  describe("alwaysRun with labels", () => {
    it("should run handler when label matches alwaysRun string", async () => {
      (__mockQuery as any).mockResolvedValue({
        known: true,
        data: { title: "Known" },
        confidence: 0.9,
      });

      const handlerFn = vi.fn();
      const crawler = {
        requestHandler: handlerFn,
        run: vi.fn(),
        constructor: { name: "MockCrawler" },
      };

      const enhanced = FetchBrain.enhance(crawler, {
        ...testConfig,
        alwaysRun: "listing",
      });

      const context = {
        request: { url: "https://example.com/page", label: "listing" },
        pushData: vi.fn(),
      };

      await enhanced.requestHandler(context);

      expect(handlerFn).toHaveBeenCalled();
    });

    it("should skip handler when label does not match alwaysRun string", async () => {
      (__mockQuery as any).mockResolvedValue({
        known: true,
        data: { title: "Known" },
        confidence: 0.9,
      });

      const handlerFn = vi.fn();
      const crawler = {
        requestHandler: handlerFn,
        run: vi.fn(),
        constructor: { name: "MockCrawler" },
      };

      const enhanced = FetchBrain.enhance(crawler, {
        ...testConfig,
        alwaysRun: "listing",
      });

      const context = {
        request: { url: "https://example.com/page", label: "detail" },
        pushData: vi.fn(),
      };

      await enhanced.requestHandler(context);

      expect(handlerFn).not.toHaveBeenCalled();
    });

    it("should handle alwaysRun as array of labels", async () => {
      (__mockQuery as any).mockResolvedValue({
        known: true,
        data: { title: "Known" },
        confidence: 0.9,
      });

      const handlerFn = vi.fn();
      const crawler = {
        requestHandler: handlerFn,
        run: vi.fn(),
        constructor: { name: "MockCrawler" },
      };

      const enhanced = FetchBrain.enhance(crawler, {
        ...testConfig,
        alwaysRun: ["listing", "category"],
      });

      const context1 = {
        request: { url: "https://example.com/1", label: "listing" },
        pushData: vi.fn(),
      };
      const context2 = {
        request: { url: "https://example.com/2", label: "category" },
        pushData: vi.fn(),
      };
      const context3 = {
        request: { url: "https://example.com/3", label: "detail" },
        pushData: vi.fn(),
      };

      await enhanced.requestHandler(context1);
      await enhanced.requestHandler(context2);
      await enhanced.requestHandler(context3);

      // First two should run, third should skip
      expect(handlerFn).toHaveBeenCalledTimes(2);
    });
  });

  describe("context.ai", () => {
    it("should provide AI context in handler", async () => {
      (__mockQuery as any).mockResolvedValue({
        known: true,
        data: { title: "AI Data" },
        confidence: 0.92,
      });

      let capturedContext: any;
      const handlerFn = vi.fn((ctx) => {
        capturedContext = ctx;
      });
      const crawler = {
        requestHandler: handlerFn,
        run: vi.fn(),
        constructor: { name: "MockCrawler" },
      };

      const enhanced = FetchBrain.enhance(crawler, {
        ...testConfig,
        alwaysRun: true,
      });

      const context = {
        request: { url: "https://example.com/test" },
        pushData: vi.fn(),
      };

      await enhanced.requestHandler(context);

      expect(capturedContext.ai).toBeDefined();
      expect(capturedContext.ai.known).toBe(true);
      expect(capturedContext.ai.data).toEqual({ title: "AI Data" });
      expect(capturedContext.ai.confidence).toBe(0.92);
      expect(typeof capturedContext.ai.useAIData).toBe("function");
    });

    it("should allow useAIData() to push AI data", async () => {
      (__mockQuery as any).mockResolvedValue({
        known: true,
        data: { title: "AI Data" },
        confidence: 0.92,
      });

      const pushData = vi.fn();
      const handlerFn = vi.fn(async (ctx) => {
        await ctx.ai.useAIData();
      });

      const crawler = {
        requestHandler: handlerFn,
        run: vi.fn(),
        constructor: { name: "MockCrawler" },
      };

      const enhanced = FetchBrain.enhance(crawler, {
        ...testConfig,
        alwaysRun: true,
      });

      const context = {
        request: { url: "https://example.com/test" },
        pushData,
      };

      await enhanced.requestHandler(context);

      expect(pushData).toHaveBeenCalledWith({ title: "AI Data" });
    });
  });

  describe("learning", () => {
    it("should learn from pushData when AI does not know", async () => {
      (__mockQuery as any).mockResolvedValue({ known: false });
      (__mockLearn as any).mockResolvedValue({
        status: "accepted",
        learned: 1,
      });

      const handlerFn = vi.fn(async (ctx) => {
        await ctx.pushData({ title: "New Data" });
      });

      const crawler = {
        requestHandler: handlerFn,
        run: vi.fn(),
        constructor: { name: "MockCrawler" },
      };

      const enhanced = FetchBrain.enhance(crawler, testConfig);

      const context = {
        request: { url: "https://example.com/new" },
        pushData: vi.fn(),
      };

      await enhanced.requestHandler(context);

      expect(__mockLearn).toHaveBeenCalledWith("https://example.com/new", {
        title: "New Data",
      });
    });

    it("should NOT learn when AI already knows", async () => {
      (__mockQuery as any).mockResolvedValue({
        known: true,
        data: { title: "Existing" },
        confidence: 0.9,
      });

      const handlerFn = vi.fn(async (ctx) => {
        await ctx.pushData({ title: "Updated Data" });
      });

      const crawler = {
        requestHandler: handlerFn,
        run: vi.fn(),
        constructor: { name: "MockCrawler" },
      };

      const enhanced = FetchBrain.enhance(crawler, {
        ...testConfig,
        alwaysRun: true,
      });

      const context = {
        request: { url: "https://example.com/known" },
        pushData: vi.fn(),
      };

      await enhanced.requestHandler(context);

      expect(__mockLearn).not.toHaveBeenCalled();
    });

    it("should NOT learn when learning is disabled", async () => {
      (__mockQuery as any).mockResolvedValue({ known: false });

      const handlerFn = vi.fn(async (ctx) => {
        await ctx.pushData({ title: "New Data" });
      });

      const crawler = {
        requestHandler: handlerFn,
        run: vi.fn(),
        constructor: { name: "MockCrawler" },
      };

      const enhanced = FetchBrain.enhance(crawler, {
        ...testConfig,
        learning: false,
      });

      const context = {
        request: { url: "https://example.com/new" },
        pushData: vi.fn(),
      };

      await enhanced.requestHandler(context);

      expect(__mockLearn).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should propagate handler errors", async () => {
      (__mockQuery as any).mockResolvedValue({ known: false });

      const handlerFn = vi.fn().mockRejectedValue(new Error("Handler error"));
      const crawler = {
        requestHandler: handlerFn,
        run: vi.fn(),
        constructor: { name: "MockCrawler" },
      };

      const enhanced = FetchBrain.enhance(crawler, testConfig);

      const context = {
        request: { url: "https://example.com/error" },
        pushData: vi.fn(),
      };

      await expect(enhanced.requestHandler(context)).rejects.toThrow(
        "Handler error"
      );
    });
  });
});

describe("pushData wrapper", () => {
  it("should work with mock dataset", async () => {
    const mockDataset = {
      pushData: vi.fn(),
    };

    await pushData({ title: "Test" }, mockDataset);

    expect(mockDataset.pushData).toHaveBeenCalledWith({ title: "Test" });
  });

  it("should work with named dataset", async () => {
    const namedDataset = { pushData: vi.fn() };
    const mockDataset = {
      pushData: vi.fn(),
      open: vi.fn().mockResolvedValue(namedDataset),
    };

    await pushData({ title: "Test" }, mockDataset, "products");

    expect(mockDataset.open).toHaveBeenCalledWith("products");
    expect(namedDataset.pushData).toHaveBeenCalledWith({ title: "Test" });
  });
});
