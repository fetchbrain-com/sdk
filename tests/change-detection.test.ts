import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- enhance-level tests use a mocked client ----
const m = vi.hoisted(() => ({
  recall: vi.fn(),
  learn: vi.fn(),
  getChangeStats: vi.fn(),
  reportRun: vi.fn(),
  recallBulk: vi.fn(),
}));

vi.mock("../src/client", async (orig) => {
  const actual = await orig<typeof import("../src/client")>();
  return {
    ...actual,
    FetchBrainClient: vi.fn().mockImplementation(() => ({
      recall: m.recall,
      learn: m.learn,
      waitForLearnRoom: vi.fn().mockResolvedValue(true),
      flushLearnBatch: vi.fn().mockResolvedValue(undefined),
      sendTelemetry: vi.fn(),
      getChangeStats: m.getChangeStats,
      reportRun: m.reportRun,
      recallBulk: m.recallBulk,
      getConfig: () => ({}),
    })),
  };
});

import { FetchBrain } from "../src/enhance";
import { FetchBrainClient as RealClient } from "../src/client";

const real = (await vi.importActual<typeof import("../src/client")>("../src/client"))
  .FetchBrainClient as typeof RealClient;

const KNOWN = { known: true, data: { title: "old" } };
const base = { apiKey: "fb_test_1", debug: false, learning: true };

function crawlerWith(handler: (ctx: any) => Promise<void>) {
  // run() plays `script` (the crawl) so pages are handled inside run(), as in real use.
  const c: any = {
    requestHandler: handler,
    script: undefined as undefined | (() => Promise<void>),
    constructor: { name: "MockCrawler" },
    async run() {
      await this.script?.();
    },
  };
  return c;
}
const ctx = (url: string, label?: string) => ({
  request: { url, label },
  pushData: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  m.learn.mockResolvedValue({ learned: 1, status: "success" });
  m.getChangeStats.mockReturnValue({ changed: 0, unchanged: 0, firstSeen: 0, drift: [] });
  m.reportRun.mockResolvedValue([]);
  delete process.env.APIFY_ACTOR_RUN_ID;
});

describe("relearn gate", () => {
  const handler = async (c: any) => {
    await c.pushData({ title: "new" });
  };

  it("relearns a known alwaysRun page when changeDetection is enabled", async () => {
    m.recall.mockResolvedValue(KNOWN);
    const e = FetchBrain.enhance(crawlerWith(handler), {
      ...base,
      alwaysRun: true,
      changeDetection: { enabled: true },
    });
    await e.requestHandler(ctx("https://a.test/1"));
    expect(m.learn).toHaveBeenCalledTimes(1);
  });

  it("does not relearn without the flag", async () => {
    m.recall.mockResolvedValue(KNOWN);
    const e = FetchBrain.enhance(crawlerWith(handler), { ...base, alwaysRun: true });
    await e.requestHandler(ctx("https://a.test/1"));
    expect(m.learn).not.toHaveBeenCalled();
  });

  it("never learns when the page used recalled data", async () => {
    m.recall.mockResolvedValue(KNOWN);
    const e = FetchBrain.enhance(
      crawlerWith(async (c) => {
        await c.brain.use();
        await c.pushData({ title: "new" });
      }),
      { ...base, alwaysRun: true, changeDetection: { enabled: true } },
    );
    await e.requestHandler(ctx("https://a.test/1"));
    expect(m.learn).not.toHaveBeenCalled();
  });
});

describe("client change stats and ignore", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  afterEach(() => vi.unstubAllGlobals());

  function stub(responder: (path: string, body: any) => Response) {
    fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) =>
      responder(new URL(String(url)).pathname, init?.body ? JSON.parse(init.body as string) : {}),
    );
    vi.stubGlobal("fetch", fetchMock);
  }
  const json = (b: unknown, status = 201) => new Response(JSON.stringify(b), { status });

  it("sends ignore fields when configured, omits when empty", async () => {
    stub(() => json({ learned: 1, status: "success" }));
    const c = new real({
      apiKey: "k",
      baseUrl: "http://x",
      batch: { maxSize: 1, maxWait: 0 },
      changeDetection: { ignoreFields: ["scrapedAt"] },
    });
    await c.learn({ url: "https://a.test/1" }, { a: 1 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).ignore).toEqual(["scrapedAt"]);

    stub(() => json({ learned: 1, status: "success" }));
    const c2 = new real({ apiKey: "k", baseUrl: "http://x", batch: { maxSize: 1, maxWait: 0 } });
    await c2.learn({ url: "https://a.test/1" }, { a: 1 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).ignore).toBeUndefined();
  });

  it("counts a 3-entry batch once, dedupes drift", async () => {
    const drift = { label: "D", field: "price", kind: "fill_drop", from: 0.95, to: 0 };
    stub(() => json({ learned: 3, status: "success", changed: 2, unchanged: 1, firstSeen: 0, drift: [drift] }));
    const c = new real({ apiKey: "k", baseUrl: "http://x", batch: { maxSize: 3, maxWait: 50 } });
    await Promise.all([1, 2, 3].map((i) => c.learn({ url: `https://a.test/${i}` }, { i })));
    expect(fetchMock.mock.calls.filter((x) => String(x[0]).endsWith("/v1/learn"))).toHaveLength(1);
    expect(c.getChangeStats()).toEqual({ changed: 2, unchanged: 1, firstSeen: 0, drift: [drift] });

    // a second batch with the same drift item adds counts but not a duplicate item
    await Promise.all([4, 5, 6].map((i) => c.learn({ url: `https://a.test/${i}` }, { i })));
    const s = c.getChangeStats();
    expect(s.changed).toBe(4);
    expect(s.drift).toHaveLength(1);
  });

  it("reportRun posts to /v1/runs and returns flags", async () => {
    const flags = [{ label: "D", kind: "empty_pages", rate: 0.4 }];
    stub(() => json({ status: "recorded", flags }));
    const c = new real({ apiKey: "k", baseUrl: "http://x" });
    const out = await c.reportRun({ runId: "r1", scraped: 1, learned: 1, recalled: 0 });
    expect(out).toEqual(flags);
    expect(fetchMock.mock.calls[0][0]).toBe("http://x/v1/runs");
  });

  it("reportRun swallows failures and returns no flags", async () => {
    stub(() => json({ error: "boom" }, 500));
    const c = new real({ apiKey: "k", baseUrl: "http://x" });
    await expect(c.reportRun({ runId: "r1", scraped: 1, learned: 0, recalled: 0 })).resolves.toEqual([]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net")));
    await expect(c.reportRun({ runId: "r1", scraped: 1, learned: 0, recalled: 0 })).resolves.toEqual([]);
  });

  it("reportRun is skipped when reportRuns is false", async () => {
    stub(() => json({ status: "recorded", flags: [] }));
    const c = new real({ apiKey: "k", baseUrl: "http://x", reportRuns: false });
    await c.reportRun({ runId: "r1", scraped: 1, learned: 0, recalled: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("run tracking and summary", () => {
  it("counts scraped/empty/failed per label and reports them", async () => {
    const boom = new Error("parse");
    m.recall.mockResolvedValue({ known: false });
    const e = FetchBrain.enhance(
      crawlerWith(async (c) => {
        if (c.request.url.includes("fail")) throw boom;
        if (!c.request.url.includes("empty")) await c.pushData({ x: 1 });
      }),
      base,
    );
    e.script = async () => {
      await e.requestHandler(ctx("https://a.test/ok", "DETAIL"));
      await e.requestHandler(ctx("https://a.test/empty", "DETAIL"));
      await expect(e.requestHandler(ctx("https://a.test/fail", "DETAIL"))).rejects.toBe(boom);
      await e.requestHandler(ctx("https://a.test/ok2"));
    };
    await e.run([]);

    const report = m.reportRun.mock.calls[0][0];
    expect(report.labels).toEqual({
      DETAIL: { scraped: 3, empty: 1, failed: 1 },
      _nolabel: { scraped: 1, empty: 0, failed: 0 },
    });
    expect(report.scraped).toBe(4);
  });

  it("does not count empty for known non-relearn pages, learning:false, or recalled-data pages", async () => {
    m.recall.mockResolvedValue(KNOWN);
    const e = FetchBrain.enhance(crawlerWith(async () => {}), { ...base, alwaysRun: true });
    e.script = () => e.requestHandler(ctx("https://a.test/1", "L"));
    await e.run([]);
    expect(m.reportRun.mock.calls[0][0].labels.L).toEqual({ scraped: 1, empty: 0, failed: 0 });

    m.recall.mockResolvedValue({ known: false });
    const off = FetchBrain.enhance(crawlerWith(async () => {}), { ...base, learning: false });
    off.script = () => off.requestHandler(ctx("https://a.test/2", "M"));
    await off.run([]);
    expect(m.reportRun.mock.calls[1][0].labels.M).toEqual({ scraped: 1, empty: 0, failed: 0 });

    m.recall.mockResolvedValue(KNOWN);
    const used = FetchBrain.enhance(
      crawlerWith(async (c) => {
        await c.brain.use();
      }),
      { ...base, alwaysRun: true, changeDetection: { enabled: true } },
    );
    used.script = () => used.requestHandler(ctx("https://a.test/3", "N"));
    await used.run([]);
    expect(m.reportRun.mock.calls[2][0].labels.N).toEqual({ scraped: 1, empty: 0, failed: 0 });
  });

  it("isolates each run(): second report and warnings cover only that run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    m.recall.mockResolvedValue({ known: false });
    const d1 = { label: "D", field: "price", kind: "fill_drop", from: 0.9, to: 0 };
    let stats = { changed: 0, unchanged: 0, firstSeen: 0, drift: [] as any[] };
    m.getChangeStats.mockImplementation(() => ({ ...stats, drift: [...stats.drift] }));
    const e = FetchBrain.enhance(
      crawlerWith(async (c) => {
        await c.pushData({ x: 1 });
      }),
      { ...base, changeDetection: { enabled: true } },
    );
    e.script = async () => {
      await e.requestHandler(ctx("https://a.test/1", "D"));
      stats = { changed: 2, unchanged: 0, firstSeen: 1, drift: [d1] };
    };
    await e.run([]);
    e.script = async () => {
      await e.requestHandler(ctx("https://a.test/2", "D"));
      await e.requestHandler(ctx("https://a.test/3", "D"));
      stats = { changed: 5, unchanged: 0, firstSeen: 1, drift: [d1] };
    };
    await e.run([]);

    expect(m.reportRun.mock.calls[0][0].scraped).toBe(1);
    expect(m.reportRun.mock.calls[1][0].scraped).toBe(2);
    expect(m.reportRun.mock.calls[1][0].labels).toEqual({ D: { scraped: 2, empty: 0, failed: 0 } });
    const driftWarns = warn.mock.calls.filter((c) => c.join(" ").includes("drift [D]"));
    expect(driftWarns).toHaveLength(1);
    const infos = infoSpy.mock.calls.map((c: any[]) => c.join(" "));
    expect(infos.some((l: string) => l.includes("changed: 3"))).toBe(true);
    warn.mockRestore();
    infoSpy.mockRestore();
  });

  it("sends build only with refreshOnRebuild", async () => {
    vi.stubEnv("CUSTOM_BUILD_ID", "b9");
    m.recall.mockResolvedValue({ known: false });
    const a = FetchBrain.enhance(crawlerWith(async () => {}), base);
    await a.run([]);
    expect(m.reportRun.mock.calls[0][0].build).toBeUndefined();
    const b = FetchBrain.enhance(crawlerWith(async () => {}), { ...base, refreshOnRebuild: true });
    await b.run([]);
    expect(m.reportRun.mock.calls[1][0].build).toBe("b9");
    vi.unstubAllEnvs();
  });

  it("uses the platform run id when present, else a fresh uuid per run()", async () => {
    m.recall.mockResolvedValue({ known: false });
    const e = FetchBrain.enhance(crawlerWith(async () => {}), base);
    await e.run([]);
    await e.run([]);
    const [a, b] = m.reportRun.mock.calls.map((c) => c[0].runId);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).not.toBe(a);

    process.env.APIFY_ACTOR_RUN_ID = "run_123";
    await e.run([]);
    expect(m.reportRun.mock.calls[2][0].runId).toBe("run_123");
  });

  it("gives each run() and each crawler in one Apify run its own id", async () => {
    process.env.APIFY_ACTOR_RUN_ID = "apify_multi";
    const a = FetchBrain.enhance(crawlerWith(async () => {}), base);
    const b = FetchBrain.enhance(crawlerWith(async () => {}), base);
    await a.run([]);
    await b.run([]);
    await a.run([]);
    expect(m.reportRun.mock.calls.map((c) => c[0].runId)).toEqual(["apify_multi", "apify_multi-2", "apify_multi-3"]);
  });

  it("skips the report when reportRuns is false", async () => {
    const e = FetchBrain.enhance(crawlerWith(async () => {}), { ...base, reportRuns: false });
    await e.run([]);
    expect(m.reportRun).not.toHaveBeenCalled();
  });

  it("a failing report never breaks run()", async () => {
    m.reportRun.mockRejectedValue(new Error("down"));
    const e = FetchBrain.enhance(crawlerWith(async () => {}), base);
    await expect(e.run([])).resolves.toBeUndefined();
  });

  it("prints changed count and warns on drift and run flags", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.getChangeStats.mockReturnValueOnce({ changed: 0, unchanged: 0, firstSeen: 0, drift: [] });
    m.getChangeStats.mockReturnValue({
      changed: 3,
      unchanged: 1,
      firstSeen: 0,
      drift: [{ label: "DETAIL", field: "price", kind: "fill_drop", from: 0.95, to: 0 }],
    });
    m.reportRun.mockResolvedValue([{ label: "DETAIL", kind: "empty_pages", rate: 0.4 }]);
    const e = FetchBrain.enhance(crawlerWith(async () => {}), { ...base, changeDetection: { enabled: true } });
    await e.run([]);

    const logs = info.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logs).toContain("changed: 3");
    const warns = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warns).toContain("⚠️ drift [DETAIL] price: filled 95% → 0%");
    expect(warns).toContain("⚠️ 40% of DETAIL pages pushed no data");
    info.mockRestore();
    warn.mockRestore();
  });

  it("omits the changed count when disabled and zero", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const e = FetchBrain.enhance(crawlerWith(async () => {}), base);
    await e.run([]);
    expect(info.mock.calls.map((c) => c.join(" ")).join("\n")).not.toContain("changed:");
    info.mockRestore();
  });

  it("ignores malformed drift items; only valid items are stored; run() resolves even if stats are junk", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const valid = { label: "D", field: "price", kind: "fill_drop", from: 0.9, to: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ learned: 1, status: "success", changed: 1, drift: [null, valid, 5, { label: 1 }] }), { status: 201 })),
    );
    const c = new real({ apiKey: "k", baseUrl: "http://x", batch: { maxSize: 1, maxWait: 0 } });
    await c.learn({ url: "https://a.test/1" }, { a: 1 });
    expect(c.getChangeStats().drift).toEqual([valid]);

    // run() with a client-shaped stats object containing junk must still resolve
    m.getChangeStats.mockReturnValueOnce({ changed: 0, unchanged: 0, firstSeen: 0, drift: [] });
    m.getChangeStats.mockReturnValue({ changed: 1, unchanged: 0, firstSeen: 0, drift: [null, valid] });
    const e = FetchBrain.enhance(crawlerWith(async () => {}), { ...base, changeDetection: { enabled: true } });
    await expect(e.run([])).resolves.toBeUndefined();
    await expect(e.run([])).resolves.toBeUndefined();
    // Junk stats are skipped (debug only); nothing throws into the finished crawl.
    warn.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("run tracking: requests skipped and late recalls", () => {
  type QReq = { url: string; method?: string; uniqueKey?: string; label?: string; skipNavigation?: boolean; userData?: Record<string, unknown> };
  /**
   * A crawler with a request queue: run(reqs) enqueues through this.addRequests (the
   * FetchBrain wrapper once enhanced), then handles each request, retrying a failed
   * one up to maxRetries times with the SAME request object (as Crawlee does).
   */
  function queueCrawler(
    handler: (ctx: any) => Promise<void>,
    opts: { retryOnBlocked?: boolean; maxRetries?: number; pushData?: () => any } = {},
  ) {
    const c: any = {
      requestHandler: handler,
      retryOnBlocked: opts.retryOnBlocked,
      queue: [] as QReq[],
      constructor: { name: "MockCrawler" },
      async addRequests(reqs: Array<string | QReq>) {
        for (const r of reqs) this.queue.push(typeof r === "string" ? { url: r } : r);
      },
      async run(reqs?: Array<string | QReq>) {
        if (reqs) await this.addRequests(reqs);
        while (this.queue.length) {
          const r = this.queue.shift() as QReq;
          const request = { ...r, userData: { ...(r.userData ?? {}) } };
          for (let attempt = 0; attempt <= (opts.maxRetries ?? 0); attempt++) {
            try {
              await this.requestHandler({ request, pushData: opts.pushData ?? vi.fn() });
              break;
            } catch {
              // failed attempt — retry with the same request object
            }
          }
        }
      },
    };
    return c;
  }
  const report = (i = 0) => m.reportRun.mock.calls[i][0];
  const knownBulk = () =>
    m.recallBulk.mockImplementation(async (rs: unknown[]) => rs.map(() => ({ known: true, data: { title: "old" } })));
  const TIP = "were recalled after they were fetched";

  it("1. a pre-recalled known page counts as a request skipped", async () => {
    knownBulk();
    const e = FetchBrain.enhance(queueCrawler(async () => {}), base);
    await e.run(["https://a.test/1"]);
    expect(m.recall).not.toHaveBeenCalled();
    expect(report()).toMatchObject({ recalled: 1, requestsSkipped: 1, lateRecalls: 0, scraped: 0 });
  });

  it("2. a handler-time recall counts as a late recall", async () => {
    m.recall.mockResolvedValue(KNOWN);
    const e = FetchBrain.enhance(crawlerWith(async () => {}), base);
    e.script = () => e.requestHandler(ctx("https://a.test/1"));
    await e.run([]);
    expect(report()).toMatchObject({ recalled: 1, requestsSkipped: 0, lateRecalls: 1 });
  });

  it("3. a known page the user marked skipNavigation is recalled, not a late recall (never fetched)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    knownBulk();
    m.recall.mockResolvedValue(KNOWN);
    const e = FetchBrain.enhance(queueCrawler(async () => {}), base);
    await e.run([{ url: "https://a.test/1", skipNavigation: true }]);
    expect(m.recallBulk).not.toHaveBeenCalled();
    expect(report()).toMatchObject({ recalled: 1, requestsSkipped: 0, lateRecalls: 0 });
    expect(info.mock.calls.map((c) => c.join(" ")).join("\n")).not.toContain(TIP);
    info.mockRestore();
  });

  it("3b. a fetched non-GET without an explicit uniqueKey is a late recall, and the tip says to set one", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    knownBulk();
    m.recall.mockResolvedValue(KNOWN);
    const e = FetchBrain.enhance(queueCrawler(async () => {}), base);
    await e.run([{ url: "https://a.test/api", method: "POST" }]);
    expect(m.recallBulk).not.toHaveBeenCalled(); // pre-recall can't identify it at enqueue
    expect(report()).toMatchObject({ recalled: 1, requestsSkipped: 0, lateRecalls: 1 });
    expect(info.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("non-GET requests also need an explicit uniqueKey");
    info.mockRestore();
  });

  it("4. an alwaysRun page counts as recalled + scraped only", async () => {
    knownBulk();
    const e = FetchBrain.enhance(queueCrawler(async () => {}), { ...base, alwaysRun: ["D"] });
    await e.run([{ url: "https://a.test/1", label: "D" }]);
    expect(report()).toMatchObject({ recalled: 1, scraped: 1, requestsSkipped: 0, lateRecalls: 0 });
  });

  it("5. retryOnBlocked pages count as late recalls and log no tip", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    knownBulk();
    const e = FetchBrain.enhance(queueCrawler(async () => {}, { retryOnBlocked: true }), base);
    await e.run(["https://a.test/1"]);
    expect(report()).toMatchObject({ recalled: 1, requestsSkipped: 0, lateRecalls: 1 });
    expect(info.mock.calls.map((c) => c.join(" ")).join("\n")).not.toContain(TIP);
    info.mockRestore();
  });

  it("6. pushData rejects once, then the retry succeeds: counted once", async () => {
    knownBulk();
    const push = vi.fn().mockRejectedValueOnce(new Error("dataset")).mockResolvedValue(undefined);
    const e = FetchBrain.enhance(queueCrawler(async () => {}, { maxRetries: 2, pushData: push }), base);
    await e.run(["https://a.test/1"]);
    expect(push).toHaveBeenCalledTimes(2);
    expect(report()).toMatchObject({ recalled: 1, requestsSkipped: 1, lateRecalls: 0 });
  });

  it("6b. the same request handled successfully twice is counted once", async () => {
    m.recall.mockResolvedValue(KNOWN);
    const e = FetchBrain.enhance(crawlerWith(async () => {}), base);
    const c = ctx("https://a.test/1");
    e.script = async () => {
      await e.requestHandler(c);
      await e.requestHandler(c);
    };
    await e.run([]);
    expect(c.pushData).toHaveBeenCalledTimes(2);
    expect(report()).toMatchObject({ recalled: 1, lateRecalls: 1 });
    expect(c.request).toHaveProperty("userData.__fetchBrainCounted", true);
  });

  it("7. pushData always rejects: not counted", async () => {
    knownBulk();
    const push = vi.fn().mockRejectedValue(new Error("dataset"));
    const e = FetchBrain.enhance(queueCrawler(async () => {}, { maxRetries: 2, pushData: push }), base);
    await e.run(["https://a.test/1"]);
    expect(push).toHaveBeenCalledTimes(3);
    expect(report()).toMatchObject({ recalled: 0, requestsSkipped: 0, lateRecalls: 0 });
  });

  it("8. a skipLabels page is reported as bypassed", async () => {
    const e = FetchBrain.enhance(queueCrawler(async () => {}), { ...base, skipLabels: ["LIST"] });
    await e.run([{ url: "https://a.test/list", label: "LIST" }]);
    expect(report()).toMatchObject({ bypassed: 1, recalled: 0, scraped: 0 });
  });

  it("9. two run() calls under one platform run id get distinct runIds", async () => {
    process.env.APIFY_ACTOR_RUN_ID = "rr_two_calls";
    const e = FetchBrain.enhance(crawlerWith(async () => {}), base);
    await e.run([]);
    await e.run([]);
    expect(m.reportRun.mock.calls.map((c) => c[0].runId)).toEqual(["rr_two_calls", "rr_two_calls-2"]);
  });

  it("10. two enhanced crawlers in one process get distinct runIds", async () => {
    process.env.APIFY_ACTOR_RUN_ID = "rr_two_crawlers";
    const a = FetchBrain.enhance(crawlerWith(async () => {}), base);
    const b = FetchBrain.enhance(crawlerWith(async () => {}), base);
    await a.run([]);
    await b.run([]);
    expect(m.reportRun.mock.calls.map((c) => c[0].runId)).toEqual(["rr_two_crawlers", "rr_two_crawlers-2"]);
  });

  it("10b. a long platform run id keeps its suffix within the length cap", async () => {
    process.env.APIFY_ACTOR_RUN_ID = "x".repeat(200);
    const e = FetchBrain.enhance(crawlerWith(async () => {}), base);
    await e.run([]);
    await e.run([]);
    const [first, second] = m.reportRun.mock.calls.map((c) => c[0].runId as string);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(second.length).toBeLessThanOrEqual(128);
    expect(second.endsWith("-2")).toBe(true);
    expect(second).not.toBe(first);
  });

  it("11. the summary on a second run() shows per-run deltas and requests skipped", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    knownBulk();
    const e = FetchBrain.enhance(queueCrawler(async () => {}), base);
    await e.run(["https://a.test/1", "https://a.test/2"]);
    info.mockClear();
    m.recallBulk.mockImplementation(async (rs: unknown[]) =>
      rs.map((_, i) => (i === 0 ? { known: true, data: { title: "old" } } : { known: false })),
    );
    await e.run(["https://a.test/3", "https://a.test/4"]);
    const line = info.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("Finished!")) ?? "";
    expect(line).toContain("recalled: 1/2 (50.0%)");
    expect(line).toContain("requests skipped: 1");
    expect(line).toContain("scraped: 1");
    expect(report(1)).toMatchObject({ recalled: 1, requestsSkipped: 1, lateRecalls: 0, scraped: 1 });
    info.mockRestore();
  });

  it("12. logs the tip once when pages were recalled after their fetch", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    m.recall.mockResolvedValue(KNOWN);
    const e = FetchBrain.enhance(queueCrawler(async () => {}), base);
    e.queue.push({ url: "https://a.test/1" }, { url: "https://a.test/2" }); // not via addRequests
    await e.run();
    const tips = info.mock.calls.map((c) => c.join(" ")).filter((l) => l.includes(TIP));
    expect(tips).toHaveLength(1);
    expect(tips[0]).toContain(
      "2 pages were recalled after they were fetched; enqueue them with context.crawler.addRequests([...]) to skip the fetch (non-GET requests also need an explicit uniqueKey).",
    );
    expect(report()).toMatchObject({ lateRecalls: 2, requestsSkipped: 0 });

    // No tip with preRecall off.
    info.mockClear();
    const off = FetchBrain.enhance(queueCrawler(async () => {}), { ...base, preRecall: false });
    off.queue.push({ url: "https://a.test/3" });
    await off.run();
    expect(info.mock.calls.map((c) => c.join(" ")).join("\n")).not.toContain(TIP);
    info.mockRestore();
  });

  it("strips the counted marker from the learned identity", async () => {
    m.recall.mockResolvedValue({ known: false });
    const e = FetchBrain.enhance(crawlerWith(async (c) => c.pushData({ x: 1 })), base);
    const c = ctx("https://a.test/1") as any;
    c.request.userData = { keep: 1, __fetchBrainCounted: true };
    await e.requestHandler(c);
    expect(m.learn.mock.calls[0][0].userData).toEqual({ keep: 1 });
  });
});

describe("drift hardening", () => {
  it("caps stored drift items, strips control characters, and drops unknown kinds", async () => {
    const drift = Array.from({ length: 150 }, (_, i) => ({ label: `L${i}`, field: "f", kind: "missing" }));
    drift.unshift({ label: "a\u001b[31mred", field: "x".repeat(500), kind: "missing" });
    drift.unshift({ label: "z", field: "f", kind: "evil" });
    drift.unshift({ label: "b\u202eid\u200b", field: "f", kind: "missing" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ learned: 1, status: "success", drift }), { status: 201 })),
    );
    const c = new real({ apiKey: "k", baseUrl: "http://x", batch: { maxSize: 1, maxWait: 0 } });
    await c.learn({ url: "https://a.test/1" }, { a: 1 });
    const stored = c.getChangeStats().drift;
    expect(stored).toHaveLength(100);
    expect(stored[0].label).toBe("b id ");
    expect(stored[1].label).toBe("a [31mred");
    expect(stored[1].field).toHaveLength(128);
    expect(stored.some((d) => d.kind === ("evil" as never))).toBe(false);
  });
});

describe("non-string labels", () => {
  // Crawlee types request.label as a string but returns whatever userData.label
  // holds, so a JS crawler can pass a number. It must never fail the page.
  it("runs the handler, learns and reports a numeric label as text", async () => {
    m.recall.mockResolvedValue({ known: false });
    const handler = vi.fn(async (c: any) => {
      await c.pushData({ title: "t" });
    });
    const crawler = crawlerWith(handler);
    const e = FetchBrain.enhance(crawler, { ...base });
    crawler.script = async () => {
      await e.requestHandler({ request: { url: "https://a.test/n", label: 7, userData: { label: 7 } }, pushData: vi.fn() });
      await e.requestHandler({ request: { url: "https://a.test/o", label: { x: 1 } }, pushData: vi.fn() });
    };
    await e.run();
    expect(handler).toHaveBeenCalledTimes(2);
    const learnedLabels = m.learn.mock.calls.map((c: any[]) => c[0]?.label);
    expect(learnedLabels).toEqual(["7", undefined]);
    const report = m.reportRun.mock.calls[0][0];
    expect(Object.keys(report.labels).sort()).toEqual(["7", "_nolabel"]);
  });
});
