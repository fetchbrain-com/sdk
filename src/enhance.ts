import { AsyncLocalStorage } from "async_hooks";
import type { FetchBrainConfig, LearnedData, Logger, RawRequest, RecallResult, TelemetryData } from "./types";
import {
  FetchBrainClient,
  setScrapeContext,
  clearScrapeContext,
} from "./client";
import { createLogger } from "./logger";
import { collectTelemetry, TelemetryBuffer } from "./telemetry";

/**
 * Async context for tracking current request
 * This allows Dataset.pushData interception even when called statically
 */
interface RequestContext {
  request: RawRequest;
  client: FetchBrainClient;
  learning: boolean;
  aiKnown: boolean; // Whether the brain already knows this URL
  /** Items this request pushed; learned together once the handler succeeds. */
  items: Record<string, unknown>[];
}

const STRIP_HEADERS = new Set(["authorization", "cookie", "set-cookie"]);
const SDK_USERDATA_KEYS = new Set(["fetchBrainRecalled", "fetchBrainData", "__fetchBrainResult"]);
// Cap on in-process pre-recalled payloads (see preRecalledData). Payloads are full
// learned records, so the worst case is roughly cap × record size; oldest-first
// eviction targets entries least likely to still execute.
export const MAX_STASH_ENTRIES = 5000;
// ...and on their total size (JSON length), so pages of large records can't hold
// unbounded memory before their requests run. Sized so Crawlee's pre-crawl
// look-ahead (~3000 requests) fits for pages averaging up to ~85KB: a smaller cap
// evicts answers before the crawl starts, and each eviction is a second recall.
export const MAX_STASH_BYTES = 256 * 1024 * 1024;
let stashBytesCap = MAX_STASH_BYTES;
/** @internal Tests only: exercising a 256MB cap for real would need ~1GB of test data. */
export function __setStashBytesCapForTests(bytes?: number): void {
  stashBytesCap = bytes ?? MAX_STASH_BYTES;
}
// Requests pre-recalled per step of a large addRequests() list (5 bulk calls).
export const PRE_RECALL_SLICE = 500;
// Longest a slice waits for stash room before degrading to FIFO eviction.
export const PRE_RECALL_STASH_WAIT_MS = 30_000;
// Longest a request handler waits for room in a full background learn backlog.
export const LEARN_ROOM_WAIT_MS = 5_000;

/**
 * True when addRequests() rejected its input's shape rather than failing for some
 * other reason: Crawlee < 3.13.9 iterates it as an array (`TypeError: requests is
 * not iterable`, `requests.map is not a function`) or type-checks it as one.
 */
export function isIterableInputRejection(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /iterable|\barray\b/i.test(message);
}

/**
 * Which property holds the request handler the crawler actually invokes.
 * Browser crawlers call `userProvidedRequestHandler` (their `requestHandler` is a
 * never-called shim); HTTP crawlers call `requestHandler`. `userDefinedRequestHandler`
 * is kept as a last-resort fallback for unusual crawler shapes.
 */
function resolveHandlerKey(
  crawler: object,
): "userProvidedRequestHandler" | "requestHandler" | "userDefinedRequestHandler" | null {
  const c = crawler as Record<string, unknown>;
  for (const key of ["userProvidedRequestHandler", "requestHandler", "userDefinedRequestHandler"] as const) {
    if (typeof c[key] === "function") return key;
  }
  return null;
}

/**
 * Snapshot the raw request the SDK forwards (credentials + SDK userData removed).
 * Note: non-SDK `userData` keys are forwarded as-is — credentials belong in headers
 * (which ARE stripped), not userData.
 */
function buildRawRequest(request: Record<string, unknown>): RawRequest {
  const r = request as {
    url: string; method?: string; uniqueKey?: string; payload?: unknown;
    headers?: Record<string, unknown>; userData?: Record<string, unknown>; label?: string;
  };
  let headers: Record<string, string> | undefined;
  if (r.headers) {
    headers = {};
    for (const [k, v] of Object.entries(r.headers)) {
      if (!STRIP_HEADERS.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
    }
    if (Object.keys(headers).length === 0) headers = undefined;
  }
  let userData: Record<string, unknown> | undefined;
  if (r.userData) {
    userData = {};
    for (const [k, v] of Object.entries(r.userData)) if (!SDK_USERDATA_KEYS.has(k)) userData[k] = v;
    if (Object.keys(userData).length === 0) userData = undefined;
  }
  let body: string | undefined;
  if (typeof r.payload === "string") body = r.payload;
  // binary payloads are omitted (identity is url+method+uniqueKey; body is metadata only)
  return { url: r.url, method: r.method, uniqueKey: r.uniqueKey, body, headers, userData, label: r.label };
}

/** Warn once when a body-bearing request can't be differentiated by its key. */
function warnDefaultUniqueKey(request: { url: string; method?: string; uniqueKey?: string }, logger: Logger, warned: Set<string>): void {
  const method = (request.method ?? "GET").toUpperCase();
  const isDefault = !request.uniqueKey || request.uniqueKey === request.url;
  if (method !== "GET" && isDefault && !warned.has(request.url)) {
    warned.add(request.url);
    logger.warn(`FetchBrain: ${method} ${request.url} has a default uniqueKey — set request.uniqueKey to your stable identity, or these requests won't get their own memory.`);
  }
}

const asyncContext = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current request context (used by pushData wrapper)
 */
export function getCurrentContext(): RequestContext | undefined {
  return asyncContext.getStore();
}

/**
 * Crawlee crawler type - minimal interface for compatibility
 * We use a loose type to support various Crawlee crawler versions
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
type CrawlerLike = any;

/**
 * Brain context available in request handler
 */
export interface FetchBrainContext {
  /** Whether the brain knows this URL */
  known: boolean;
  /** Brain data if known */
  data?: LearnedData;
  /** Use brain data and skip scraping (call in handler to early return) */
  use: () => Promise<void>;
}

/**
 * Minimal request handler context interface
 */
interface RequestHandlerContext {
  request: {
    url: string;
    label?: string;
    userData?: Record<string, unknown>;
  };
  log?: {
    info: (message: string) => void;
    debug: (message: string) => void;
  };
  pushData?: (data: Record<string, unknown> | Record<string, unknown>[]) => Promise<void>;
  /** FetchBrain context - check if the brain knows this URL */
  brain?: FetchBrainContext;
  [key: string]: unknown;
}

/**
 * Check if handler should run based on alwaysRun config and request label
 */
function shouldRunHandler(
  alwaysRun: boolean | string | string[] | undefined,
  label: string | undefined,
): boolean {
  // Default: skip when the brain knows
  if (alwaysRun === undefined || alwaysRun === false) {
    return false;
  }

  // Always run all handlers
  if (alwaysRun === true) {
    return true;
  }

  // Run specific label(s)
  const labels = Array.isArray(alwaysRun) ? alwaysRun : [alwaysRun];
  const requestLabel = label || "default";

  return labels.includes(requestLabel);
}

/**
 * FetchBrain main class
 *
 * Provides the static enhance() method to wrap Crawlee crawlers
 * with brain recall and learning
 */
export class FetchBrain {
  private client: FetchBrainClient;
  private logger: Logger;

  constructor(config: FetchBrainConfig) {
    this.client = new FetchBrainClient(config);
    this.logger = createLogger(config.debug ? "debug" : "info", true);
  }

  /**
   * Recall whether FetchBrain "knows" a URL
   */
  async recall(options: { url: string; memory?: string }) {
    const result = await this.client.recall({ url: options.url });
    return {
      known: result.known,
      data: result.data,
    };
  }

  /**
   * "Teach" FetchBrain new data
   */
  async learn(options: { url: string; data: Record<string, unknown> }) {
    return this.client.learn({ url: options.url }, options.data);
  }

  /**
   * Get usage statistics
   */
  async stats() {
    return this.client.stats();
  }

  /**
   * Enhance a Crawlee crawler with FetchBrain optimization
   *
   * This wraps the crawler's request handler to:
   * 1. Recall the brain before making requests (brain knows = skip request)
   * 2. Teach the brain after successful requests (learning)
   *
   * @param crawler - Any Crawlee crawler (CheerioCrawler, PlaywrightCrawler, etc.)
   * @param config - FetchBrain configuration
   * @returns Enhanced crawler with same interface
   */
  static enhance<T>(
    crawler: T,
    config: FetchBrainConfig,
  ): T & { fetchBrain: FetchBrainClient } {
    const client = new FetchBrainClient(config);
    const logger = createLogger(config.debug ? "debug" : "info", true);

    // Telemetry is OPT-IN (`telemetry: { enabled: true }`); off otherwise. When on it
    // is pseudonymous — sent with the API key — see README "Telemetry (opt-in)".
    const telemetryConfig = config.telemetry ?? { enabled: false };

    // Telemetry buffer - automatically flushes to API
    const telemetryBuffer = new TelemetryBuffer({
      maxSize: 50,
      flushInterval: 30000,
      onFlush: async (entries: TelemetryData[]) => {
        if (telemetryConfig.enabled) {
          await client.sendTelemetry(entries);
          logger.debug(`Telemetry: sent ${entries.length} entries`);
        }
      },
    });

    // Run stats tracking
    const runStats = {
      totalRequests: 0,
      recalled: 0,
      aiSkipped: 0, // brain knew + skipped scraping
      learned: 0,
      scraped: 0, // Actually ran handler
      bypassed: 0, // skipLabels match — ran handler outside FetchBrain
      dropped: 0, // enqueue-time fetch skipped, but remembered data gone by execution
      startTime: 0,
    };
    // Background learns whose result has not been counted into runStats yet.
    const pendingLearns = new Set<Promise<void>>();

    // Get the handler the crawler actually calls. Browser crawlers (Playwright,
    // Puppeteer) keep the user's handler in `userProvidedRequestHandler` and call
    // it from their own `_runRequestHandler`; their `requestHandler` is an
    // internal shim that is never invoked, so wrapping it would be a no-op.
    // AdaptivePlaywrightCrawler (experimental in Crawlee) routes requests through
    // `adaptiveRequestHandler` and a proxy over the browser path, and needs a real
    // response there — skipping navigation would crash it. Not supported yet:
    // leave it untouched rather than wrap a handler it never calls.
    if ("adaptiveRequestHandler" in (crawler as object)) {
      logger.warn(
        "AdaptivePlaywrightCrawler is not supported yet — FetchBrain left this crawler unmodified",
      );
      return Object.assign(crawler as object, { fetchBrain: client }) as T & {
        fetchBrain: FetchBrainClient;
      };
    }

    const handlerKey = resolveHandlerKey(crawler as object);
    const originalHandler = handlerKey ? (crawler as any)[handlerKey] : undefined;

    if (!originalHandler) {
      logger.warn("No request handler found on crawler, returning unmodified");
      return Object.assign(crawler as object, { fetchBrain: client }) as T & {
        fetchBrain: FetchBrainClient;
      };
    }

    // Detect crawler type for context
    const crawlerType = (crawler as any).constructor?.name || "Unknown";

    // Per-crawl set to track urls already warned about default uniqueKey
    const warnedKeys = new Set<string>();

    // Pre-recalled payloads live here, NOT in the persisted request queue record — a
    // full learned record stashed in userData would bloat every queue write and can hit
    // platform request-size limits. userData carries only a small {known} marker; if the
    // process restarts between enqueue and execution (map lost), the handler falls back
    // to one batched recall. Entries are deleted on consumption; entries whose request
    // never executes (e.g. a resumed persisted queue dedups it) are bounded by FIFO
    // eviction at MAX_STASH_ENTRIES — an evicted entry degrades to handler-time recall.
    const preRecalledData = new Map<string, { data: LearnedData; bytes: number }>();
    let stashBytes = 0;
    // Set by the first request handler call: until then nothing consumes the stash.
    let crawlStarted = false;
    const stashDelete = (key: string): boolean => {
      const entry = preRecalledData.get(key);
      if (!entry) return false;
      preRecalledData.delete(key);
      stashBytes -= entry.bytes;
      return true;
    };
    // Identity key: `uniqueKey ?? url` folds Crawlee's GET default (uniqueKey = url), so
    // the enqueue-time key (often no explicit uniqueKey yet) matches the handler-time key.
    const stashKey = (r: { url: string; method?: string; uniqueKey?: string }) =>
      `${(r.method ?? "GET").toUpperCase()} ${r.uniqueKey ?? r.url}`;
    const stashSet = (key: string, data: LearnedData) => {
      // Re-stashing an existing key must not evict an unrelated entry; delete+set
      // also moves the key to the back of the FIFO (a re-enqueue is recent again).
      const reStash = stashDelete(key);
      const bytes = JSON.stringify(data).length;
      while (
        preRecalledData.size > 0 &&
        ((!reStash && preRecalledData.size >= MAX_STASH_ENTRIES) ||
          stashBytes + bytes > stashBytesCap)
      ) {
        const oldest = preRecalledData.keys().next().value;
        if (oldest === undefined) break;
        stashDelete(oldest);
      }
      preRecalledData.set(key, { data, bytes });
      stashBytes += bytes;
    };
    // Consume a stashed payload. Crawlee computes uniqueKey (a NORMALIZED url — host
    // lowercased, fragment stripped) at Request construction, AFTER the enqueue-time
    // stash was keyed by the raw url — so on a miss, retry under the raw-url identity.
    // Assumes no request's explicit uniqueKey equals a DIFFERENT request's raw url
    // (the fallback would consume the wrong entry); Crawlee's own dedup makes the
    // same assumption.
    const stashTake = (r: { url: string; method?: string; uniqueKey?: string }) => {
      for (const key of [stashKey(r), `${(r.method ?? "GET").toUpperCase()} ${r.url}`]) {
        const entry = preRecalledData.get(key);
        if (entry) {
          stashDelete(key); // consumed — keep the map from growing over long crawls
          return entry.data;
        }
      }
      return undefined;
    };

    // Labels that bypass FetchBrain entirely (no recall/learn/brain).
    const skipLabels = config.skipLabels && config.skipLabels.length ? new Set(config.skipLabels) : undefined;

    // Create wrapped handler
    const wrappedHandler = async (context: RequestHandlerContext) => {
      crawlStarted = true;
      const { request } = context;
      const url = request.url;
      const label = request.label;
      const startTime = Date.now();

      // Track request
      runStats.totalRequests++;

      // Bypass: this label opts out of FetchBrain — run the original handler live with no
      // recall round-trip and no learn interception. Cheapest possible path for dynamic
      // requests (search/pagination) whose data isn't worth remembering.
      if (skipLabels && skipLabels.has(label || "default")) {
        runStats.bypassed++;
        logger.debug(`Bypassing FetchBrain for [${label || "default"}]: ${url}`);
        await originalHandler.call(crawler, context);
        return;
      }

      // Set scrape context for API calls
      setScrapeContext({
        crawler: crawlerType,
        label: label,
        url: url,
      });

      // Snapshot BEFORE enhance mutates request.userData
      const rawRequest = buildRawRequest(request as Record<string, unknown>);
      warnDefaultUniqueKey(rawRequest, logger, warnedKeys);

      // Consume-on-confirmed-delivery: if the handler fails after a stashed payload
      // was read (dataset write error, handler timeout), the catch puts it back so a
      // Crawlee retry serves it without a fallback recall.
      let consumedStash: LearnedData | undefined;

      try {
        // 1. Check if FetchBrain "knows" this URL. An enqueue-time pre-recall marker
        // (stashed on userData by the addRequests wrapper) wins: no second recall
        // round-trip, no double-billed query. A known marker carries no payload —
        // the data waits in the in-process map; if the process restarted since
        // enqueue (map empty), one batched recall restores it.
        const preRecalled = request.userData?.__fetchBrainResult as
          | RecallResult
          | undefined;
        let aiResult: RecallResult;
        if (preRecalled?.known) {
          const stashedData = stashTake(rawRequest);
          if (stashedData) {
            consumedStash = stashedData;
            aiResult = { known: true, data: stashedData };
          } else {
            aiResult = await client.recall(rawRequest);
          }
        } else if (preRecalled) {
          aiResult = preRecalled; // pre-checked and unknown — no second recall
        } else {
          aiResult = await client.recall(rawRequest);
        }

        // A request we marked skipNavigation at enqueue never fetched. If its
        // remembered data is no longer available (memory expired across a process
        // restart), running the original handler without a response would crash it.
        // Fail the request instead — retrying is useless (the fetch already didn't
        // happen), so noRetry routes it straight to failedRequestHandler where the
        // missing record is visible, rather than reading as a silent success.
        if (
          preRecalled?.known &&
          (request as { skipNavigation?: boolean }).skipNavigation &&
          !(aiResult.known && aiResult.data)
        ) {
          // A fallback result means the API was unreachable, not that the memory
          // expired — that's transient, so leave the request retryable: the next
          // attempt recalls again and may restore the data. Only an authoritative
          // "unknown" from a healthy API fails fast without retries.
          if (aiResult.fallback) {
            throw new Error(
              `FetchBrain: ${url} skipped its fetch at enqueue time and its remembered data could not be restored (API unreachable) — retrying.`,
            );
          }
          runStats.dropped++;
          (request as { noRetry?: boolean }).noRetry = true;
          throw new Error(
            `FetchBrain: ${url} skipped its fetch at enqueue time but its remembered data is no longer available — failing without retries; it will be re-scraped on a future run.`,
          );
        }

        // Track if brain data was used (to skip learning)
        let usedAIData = false;
        const originalPushData = context.pushData;

        // Per-record bookkeeping (e.g. metrics, counters) normally lives in the
        // handler that recalled data replaces — this is its one hook. Never let it
        // break the crawl. userData comes from the rawRequest snapshot: SDK
        // bookkeeping keys already stripped, taken before enhance mutated
        // request.userData.
        const fireOnRecalled = async (data: LearnedData) => {
          if (!config.onRecalled) return;
          try {
            await config.onRecalled({
              url,
              label: request.label,
              userData: rawRequest.userData,
              data,
            });
          } catch (hookErr) {
            logger.debug(`onRecalled hook error: ${hookErr}`);
          }
        };

        // 2. Add brain context to handler - developers can check and decide
        context.brain = {
          known: aiResult.known,
          data: aiResult.data,
          use: async () => {
            if (aiResult.known && aiResult.data && originalPushData) {
              usedAIData = true;
              await originalPushData.call(context, aiResult.data);
              logger.info(`Used brain data: ${url}`);
              await fireOnRecalled(aiResult.data);
            }
          },
        };

        // Save in userData for reference
        request.userData = {
          ...request.userData,
          fetchBrainRecalled: aiResult.known,
          fetchBrainData: aiResult.data,
        };

        // 3. Check if we should run handler based on label
        const handlerLabel = request.label;
        const runHandler = shouldRunHandler(config.alwaysRun, handlerLabel);

        // 4. Auto-optimization: if brain knows and handler should not run, skip
        if (aiResult.known && aiResult.data && !runHandler) {
          runStats.recalled++;
          runStats.aiSkipped++;
          logger.info(`Recalled: ${url} [${handlerLabel || "default"}]`);
          if (originalPushData) {
            await originalPushData.call(context, aiResult.data);
          }
          await fireOnRecalled(aiResult.data);
          return;
        }

        // 5. Run handler (either brain doesn't know, or alwaysRun matches this label)
        runStats.scraped++;
        if (aiResult.known) {
          runStats.recalled++;
          logger.info(
            `Running handler [${
              handlerLabel || "default"
            }] with recalled data available: ${url}`,
          );
        } else {
          logger.debug(`Learning: ${url}`);
        }

        // Intercept context.pushData to capture results for learning
        // Items the page pushes are collected, not learned one by one: a page that
        // pushes N items is ONE memory entry holding all N (learning them one at a
        // time kept only the last — 500 learned, 100 recalled). Collecting also
        // keeps pushData off the network: the learn is queued after the handler.
        const learnItems: Record<string, unknown>[] = [];
        if (originalPushData && config.learning !== false) {
          context.pushData = async (data: Record<string, unknown> | Record<string, unknown>[]) => {
            // Skip learning if the developer used brain data via use(), or the
            // brain already knows this URL (no need to re-learn).
            if (!usedAIData && !aiResult.known) {
              learnItems.push(...(Array.isArray(data) ? data : [data]));
            }
            return originalPushData.call(context, data);
          };
        }

        // Run handler with async context (for Dataset.pushData interception)
        const requestContext: RequestContext = {
          request: rawRequest,
          client,
          learning: config.learning !== false,
          aiKnown: aiResult.known,
          items: learnItems,
        };

        await asyncContext.run(requestContext, async () => {
          await originalHandler.call(crawler, context);
        });

        // Learn only a page whose handler SUCCEEDED (a throw above skips this, so a
        // half-parsed page is never remembered). Not awaited: the learn batcher
        // sends it in the background and run() flushes whatever is still pending.
        if (learnItems.length > 0 && !usedAIData && !aiResult.known) {
          // When the background backlog is full (API slower than the crawl), hold
          // this handler briefly so the crawl slows to the API's pace. Bounded:
          // past the wait the learn is dropped, never the crawl stalled.
          await client.waitForLearnRoom(LEARN_ROOM_WAIT_MS);
          const pending = client
            .learn(rawRequest, learnItems.length === 1 ? learnItems[0] : learnItems)
            .then((res) => {
              // Count only what the API accepted (not refused, oversized, paused).
              if (res.status !== "rejected") runStats.learned += learnItems.length;
            })
            .catch((learnErr) => logger.debug(`Learn failed: ${learnErr}`));
          pendingLearns.add(pending);
          void pending.finally(() => pendingLearns.delete(pending));
        }

        // Collect telemetry (if enabled) - behind the scenes
        if (telemetryConfig.enabled) {
          try {
            const telemetry = await collectTelemetry(
              {
                request: {
                  url: url,
                  retryCount: (request as any).retryCount,
                  label: label,
                  userData: request.userData,
                },
                response: {
                  statusCode:
                    (context as any).response?.statusCode ||
                    (context as any).response?.status,
                },
                proxyInfo: (context as any).proxyInfo
                  ? {
                      url: (context as any).proxyInfo.url,
                      hostname: (context as any).proxyInfo.hostname,
                      countryCode: (context as any).proxyInfo.countryCode,
                    }
                  : undefined,
                session: (context as any).session
                  ? {
                      errorScore: (context as any).session.errorScore,
                      usageCount: (context as any).session.usageCount,
                    }
                  : undefined,
                crawler: {
                  constructor: { name: crawlerType },
                },
              },
              {
                startTime,
                endTime: Date.now(),
                responseTime: Date.now() - startTime,
                contentSize: (context as any).response?.body?.length,
              },
              telemetryConfig,
            );

            if (telemetry) {
              telemetryBuffer.add(telemetry);
            }
          } catch (err) {
            // Telemetry errors should never affect scraping
            logger.debug(`Telemetry collection error: ${err}`);
          }
        }
      } catch (err) {
        // The handler failed after its stashed payload was consumed — put it back
        // so a Crawlee retry is served from the stash instead of a fallback recall
        // (which, if the API is also degraded, would discard available data).
        if (consumedStash) {
          stashSet(stashKey(rawRequest), consumedStash);
        }
        // On error, still collect telemetry with error info
        if (telemetryConfig.enabled) {
          try {
            const telemetry = await collectTelemetry(
              {
                request: {
                  url: url,
                  retryCount: (request as any).retryCount,
                  label: label,
                },
                crawler: {
                  constructor: { name: crawlerType },
                },
              },
              {
                startTime,
                endTime: Date.now(),
                responseTime: Date.now() - startTime,
              },
              telemetryConfig,
              err instanceof Error ? err : new Error(String(err)),
            );

            if (telemetry) {
              telemetryBuffer.add(telemetry);
            }
          } catch {
            // Ignore telemetry errors
          }
        }
        throw err; // Re-throw original error
      } finally {
        // Clear scrape context
        clearScrapeContext();
      }
    };

    // Replace the handler
    const crawlerAny = crawler as any;
    crawlerAny[handlerKey!] = wrappedHandler;
    logger.debug(`Wrapped ${handlerKey}`);

    // Wrap the run method to flush telemetry and print summary when crawl completes
    if (typeof crawlerAny.run === "function") {
      const originalRun = crawlerAny.run.bind(crawlerAny);
      crawlerAny.run = async (...args: unknown[]) => {
        runStats.startTime = Date.now();
        try {
          const result = await originalRun(...args);
          return result;
        } finally {
          // Flush pending learn requests before shutdown
          logger.debug("Flushing pending learn requests on crawl complete");
          await client.flushLearnBatch();
          // Let each learn's result land in runStats before the summary prints.
          await Promise.allSettled([...pendingLearns]);

          // Flush telemetry buffer when crawl completes
          if (telemetryConfig.enabled) {
            logger.debug("Telemetry: flushing on crawl complete");
            await telemetryBuffer.stop();
          }

          // Print run summary
          const duration = ((Date.now() - runStats.startTime) / 1000).toFixed(
            1,
          );
          // Bypassed requests opted out of FetchBrain, so they don't dilute the savings rate
          const managedRequests = runStats.totalRequests - runStats.bypassed;
          const savingsPercent =
            managedRequests > 0
              ? ((runStats.aiSkipped / managedRequests) * 100).toFixed(1)
              : "0";

          logger.info(
            `🧠 Finished! recalled: ${runStats.recalled}/${managedRequests} (${savingsPercent}%), ` +
              `learned: ${runStats.learned}, scraped: ${runStats.scraped}` +
              (skipLabels ? `, bypassed: ${runStats.bypassed}` : "") +
              (runStats.dropped ? `, dropped: ${runStats.dropped}` : "") +
              `, duration: ${duration}s`,
          );
        }
      };
    }

    // Pre-recall at enqueue time (default on). In HttpCrawler/CheerioCrawler the HTTP
    // fetch happens BEFORE the (wrapped) requestHandler runs, so a recall inside the
    // handler is too late to save the fetch. Recalling the batch as it enters the queue
    // lets known requests skip navigation entirely (request.skipNavigation) and removes
    // the per-request recall round-trip for the rest. `run(startRequests)` funnels
    // through addRequests, so wrapping it covers both entry points.
    // Note: this covers ARRAY input to crawler.addRequests()/run(requests) only.
    // Crawlee's context-level helpers (`enqueueLinks()`, the context `addRequests()`)
    // feed the queue via generators/other paths and pass through un-recalled — inside
    // a handler, enqueue follow-ups with `context.crawler.addRequests([...])` to get
    // pre-recall (see README).
    if (config.preRecall !== false && typeof crawlerAny.addRequests === "function") {
      const originalAddRequests = crawlerAny.addRequests.bind(crawlerAny);
      if (crawlerAny.retryOnBlocked) {
        logger.info(
          "preRecall: this crawler uses retryOnBlocked, whose blocked-check needs a fetched response — known requests will keep their fetch; recalled data still replaces the handler.",
        );
      }
      // Annotate one slice in place: recall it, stash known payloads, mark
      // markers/skipNavigation. Never throws (enqueueing must not fail because of
      // FetchBrain) — on error the slice falls back to handler-time recall.
      const preRecallSlice = async (slice: unknown[], retryOnBlocked: boolean) => {
          try {
            type EnqueuedRequest = {
              url?: string;
              method?: string;
              uniqueKey?: string;
              label?: string;
              skipNavigation?: boolean;
              userData?: Record<string, unknown>;
            };
            // Eligible: has a url, label not bypassed, not already skipNavigation (a
            // request that intentionally skips navigation has its own handler logic —
            // auto-pushing recalled data over it would be wrong), and an identity that
            // is stable between enqueue and execution: for non-GET without an explicit
            // uniqueKey, Crawlee computes an extended key at Request construction, so an
            // enqueue-time recall would query the wrong identity — leave those to the
            // handler-time recall, which sees the computed key.
            const candidateIdx: number[] = [];
            for (let i = 0; i < slice.length; i++) {
              const r = slice[i] as EnqueuedRequest;
              if (!r || typeof r.url !== "string") continue;
              // A marker already in userData is OUR annotation from a previous
              // enqueue/run (Request instances are annotated in place and may be
              // reused) — not user intent. Strip it, and the skipNavigation we set
              // alongside a known marker, so this enqueue re-decides from a fresh
              // recall; if that yields no answer (API down), the safe state is a
              // normal fetch — never a permanently poisoned, forever-dropped request.
              const prior = r.userData?.__fetchBrainResult as { known?: boolean } | undefined;
              if (prior) {
                if (prior.known && r.skipNavigation) r.skipNavigation = false;
                const rest = { ...(r.userData as Record<string, unknown>) };
                delete rest.__fetchBrainResult;
                r.userData = rest;
              }
              if (r.skipNavigation) continue;
              if (skipLabels && skipLabels.has(r.label || "default")) continue;
              if ((r.method ?? "GET").toUpperCase() !== "GET" && !r.uniqueKey) continue;
              candidateIdx.push(i);
            }
            if (candidateIdx.length > 0) {
              const rawRequests = candidateIdx.map((i) =>
                buildRawRequest(slice[i] as Record<string, unknown>),
              );
              const results = await client.recallBulk(rawRequests);
              let known = 0;
              candidateIdx.forEach((reqIdx, j) => {
                const result = results[j];
                // On fallback (API degraded) stash nothing — the handler-time recall
                // path stays as the retry.
                if (!result || result.fallback) return;
                const r = slice[reqIdx] as EnqueuedRequest;
                if (result.known && result.data) {
                  // Marker in userData (persisted, tiny); payload in the in-process map.
                  r.userData = { ...r.userData, __fetchBrainResult: { known: true } };
                  stashSet(stashKey(rawRequests[j]), result.data);
                  if (!retryOnBlocked && !shouldRunHandler(config.alwaysRun, r.label)) {
                    r.skipNavigation = true; // Crawlee will never fetch this request
                    known++;
                  }
                } else {
                  r.userData = { ...r.userData, __fetchBrainResult: { known: false } };
                }
              });
              logger.debug(
                `Pre-recalled ${candidateIdx.length} enqueued request(s): ${known} known (fetch skipped)`,
              );
            }
          } catch (err) {
            // Enqueueing must never fail because of FetchBrain — fall back to
            // handler-time recall for this batch.
            logger.debug(`Pre-recall failed, falling back to handler-time recall: ${err}`);
          }
      };

      // Wait (bounded) until the stash has room for another slice, so payloads are
      // not FIFO-evicted before their requests run — an evicted payload costs a
      // second, double-billed recall per request. Bounded because entries for
      // requests Crawlee drops as duplicates never drain; once a wait times out the
      // call stops waiting and degrades to eviction rather than stalling the crawl.
      const waitForStashRoom = async (needed: number, state: { gaveUp: boolean }) => {
        // Before the first request handler runs nothing drains the stash, so a
        // wait could only time out — and Crawlee pulls a look-ahead of requests
        // before run() starts crawling, so waiting here would stall the start.
        if (!crawlStarted) return;
        const deadline = Date.now() + PRE_RECALL_STASH_WAIT_MS;
        // Room by count, and by the bytes actually stashed (not a projection).
        const hasRoom = () =>
          preRecalledData.size + needed <= MAX_STASH_ENTRIES && stashBytes < stashBytesCap;
        while (!state.gaveUp && !hasRoom()) {
          if (Date.now() >= deadline) {
            state.gaveUp = true;
            logger.debug("preRecall: stash still full after waiting; continuing (oldest payloads may be evicted)");
            return;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      };

      crawlerAny.addRequests = async (requests: unknown, options?: unknown) => {
        if (!Array.isArray(requests) || requests.length === 0) {
          return originalAddRequests(requests, options);
        }
        // Crawlee's retryOnBlocked check (isRequestBlocked) reads the response
        // contentType, which never exists for a skipNavigation request — combining
        // them would crash every known request before the handler runs. Keep the
        // marker + stash (no second recall, handler still auto-skipped) but let the
        // fetch happen. Read per call: the flag lives on the crawler instance.
        const retryOnBlocked = Boolean(
          (crawlerAny as { retryOnBlocked?: boolean }).retryOnBlocked,
        );
        // Never mutate caller-owned inputs: a startRequests array reused for a second
        // run (or shared between crawlers) must not carry this run's stash into the
        // next. Strings are normalized, plain option objects shallow-cloned; Crawlee
        // Request instances pass through as-is (cloning would drop their internal
        // state) and are the one case annotated in place.
        const batch: unknown[] = requests.map((r) => {
          if (typeof r === "string") return { url: r };
          if (r && typeof r === "object" && Object.getPrototypeOf(r) === Object.prototype) {
            return { ...r };
          }
          return r;
        });

        if (batch.length <= PRE_RECALL_SLICE) {
          await preRecallSlice(batch, retryOnBlocked);
          return originalAddRequests(batch, options);
        }

        // Large list: hand Crawlee an async iterable and pre-recall slice by slice
        // AS Crawlee pulls requests. Crawlee adds its first batch before returning
        // and the rest in the background (its queue stays unfinished meanwhile), so
        // crawling starts after one slice instead of after the whole list.
        const state = { gaveUp: false };
        let started = false;
        async function* lazilyRecalled() {
          started = true;
          for (let i = 0; i < batch.length; i += PRE_RECALL_SLICE) {
            const slice = batch.slice(i, i + PRE_RECALL_SLICE);
            await waitForStashRoom(slice.length, state);
            await preRecallSlice(slice, retryOnBlocked);
            yield* slice;
          }
        }
        try {
          return await originalAddRequests(lazilyRecalled(), options);
        } catch (err) {
          // Iterable input to addRequests only exists since Crawlee 3.13.9; older
          // versions reject it up front ("requests is not iterable" / an array
          // type check) before pulling a single request. Only in that case — the
          // generator never started, so nothing was recalled or enqueued — retry
          // with a plain array. Any other error is the caller's and is rethrown.
          if (started || !isIterableInputRejection(err)) throw err;
          logger.debug(
            "preRecall: this Crawlee version does not accept lazy request lists; pre-recalling eagerly",
          );
          // The crawl has not started, so nothing drains the stash: waiting for room
          // would only time out. Pre-recall what fits; the rest is recalled at
          // handler time (the same outcome eviction gave before lazy lists existed).
          const eager = batch.slice(0, MAX_STASH_ENTRIES);
          for (let i = 0; i < eager.length && stashBytes < stashBytesCap; i += PRE_RECALL_SLICE) {
            await preRecallSlice(eager.slice(i, i + PRE_RECALL_SLICE), retryOnBlocked);
          }
          return originalAddRequests(batch, options);
        }
      };
    }

    // Attach client for direct access
    return Object.assign(crawler as object, { fetchBrain: client }) as T & {
      fetchBrain: FetchBrainClient;
    };
  }
}

/**
 * Create a standalone FetchBrain client without crawler enhancement
 */
export function createFetchBrain(config: FetchBrainConfig): FetchBrain {
  return new FetchBrain(config);
}

/**
 * Dataset interface for pushData wrapper
 */
interface DatasetLike {
  pushData: (
    data: Record<string, unknown> | Record<string, unknown>[],
  ) => Promise<void>;
  open?: (name?: string | null) => Promise<DatasetLike>;
}

/**
 * Learning-aware pushData wrapper
 *
 * Use this instead of Dataset.pushData() so the brain learns from what you push.
 * Works with both static Dataset class and dataset instances.
 *
 * @example
 * ```typescript
 * import { Dataset } from 'crawlee';
 * import { pushData } from '@fetchbrain.com/sdk';
 *
 * // Default dataset:
 * await pushData(data, Dataset);
 *
 * // Named dataset (opens automatically):
 * await pushData(data, Dataset, 'products');
 *
 * // Pre-opened dataset instance:
 * const myDataset = await Dataset.open('products');
 * await pushData(data, myDataset);
 * ```
 */
export async function pushData(
  data: Record<string, unknown> | Record<string, unknown>[],
  dataset: DatasetLike,
  datasetName?: string,
): Promise<void> {
  const ctx = getCurrentContext();

  // Learn if we're in a FetchBrain-enhanced request and the brain doesn't already know
  if (ctx && ctx.learning && !ctx.aiKnown) {
    // Collected with the page's other items; the enhanced handler learns them
    // together once it succeeds (see the requestHandler wrapper).
    ctx.items.push(...(Array.isArray(data) ? data : [data]));
  }

  // Open named dataset if name provided and dataset has open method
  if (datasetName && dataset.open) {
    const namedDataset = await dataset.open(datasetName);
    await namedDataset.pushData(data);
  } else {
    // Push to dataset directly (default or pre-opened instance)
    await dataset.pushData(data);
  }
}
