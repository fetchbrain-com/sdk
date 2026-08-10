import { AsyncLocalStorage } from "async_hooks";
import type { FetchBrainConfig, Logger, RawRequest, RecallResult, TelemetryData } from "./types";
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
}

const STRIP_HEADERS = new Set(["authorization", "cookie", "set-cookie"]);
const SDK_USERDATA_KEYS = new Set(["fetchBrainRecalled", "fetchBrainData", "__fetchBrainResult"]);
// Cap on in-process pre-recalled payloads (see preRecalledData). Payloads are full
// learned records, so the worst case is roughly cap × record size; oldest-first
// eviction targets entries least likely to still execute.
export const MAX_STASH_ENTRIES = 5000;

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
  data?: Record<string, unknown>;
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
  pushData?: (data: Record<string, unknown>) => Promise<void>;
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
  // Default: skip when AI knows
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
 * with AI-powered optimization
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

    // Telemetry is OPT-IN — enable it to join the access-intelligence network
    // (`telemetry: { enabled: true }`). Anonymized when on; off otherwise.
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

    // Get original request handler
    const originalHandler =
      (crawler as any).requestHandler ||
      (crawler as any).userDefinedRequestHandler;

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
    const preRecalledData = new Map<string, Record<string, unknown>>();
    // Identity key: `uniqueKey ?? url` folds Crawlee's GET default (uniqueKey = url), so
    // the enqueue-time key (often no explicit uniqueKey yet) matches the handler-time key.
    const stashKey = (r: { url: string; method?: string; uniqueKey?: string }) =>
      `${(r.method ?? "GET").toUpperCase()} ${r.uniqueKey ?? r.url}`;
    const stashSet = (key: string, data: Record<string, unknown>) => {
      if (preRecalledData.size >= MAX_STASH_ENTRIES) {
        const oldest = preRecalledData.keys().next().value;
        if (oldest !== undefined) preRecalledData.delete(oldest);
      }
      preRecalledData.set(key, data);
    };
    // Consume a stashed payload. Crawlee computes uniqueKey (a NORMALIZED url — host
    // lowercased, fragment stripped) at Request construction, AFTER the enqueue-time
    // stash was keyed by the raw url — so on a miss, retry under the raw-url identity.
    const stashTake = (r: { url: string; method?: string; uniqueKey?: string }) => {
      for (const key of [stashKey(r), `${(r.method ?? "GET").toUpperCase()} ${r.url}`]) {
        const data = preRecalledData.get(key);
        if (data) {
          preRecalledData.delete(key); // consumed — keep the map from growing over long crawls
          return data;
        }
      }
      return undefined;
    };

    // Labels that bypass FetchBrain entirely (no recall/learn/brain).
    const skipLabels = config.skipLabels && config.skipLabels.length ? new Set(config.skipLabels) : undefined;

    // Create wrapped handler
    const wrappedHandler = async (context: RequestHandlerContext) => {
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
        // restart), running the original handler without a response would crash it —
        // drop the request instead; it will be re-scraped on a future run.
        if (
          preRecalled?.known &&
          (request as { skipNavigation?: boolean }).skipNavigation &&
          !(aiResult.known && aiResult.data)
        ) {
          runStats.dropped++;
          logger.warn(
            `FetchBrain: ${url} skipped its fetch at enqueue time but its remembered data is no longer available — dropping this request (it will be re-scraped on a future run).`,
          );
          return;
        }

        // Track if brain data was used (to skip learning)
        let usedAIData = false;
        const originalPushData = context.pushData;

        // 2. Add brain context to handler - developers can check and decide
        context.brain = {
          known: aiResult.known,
          data: aiResult.data,
          use: async () => {
            if (aiResult.known && aiResult.data && originalPushData) {
              usedAIData = true;
              await originalPushData.call(context, aiResult.data);
              logger.info(`Used brain data: ${url}`);
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
          // Per-record bookkeeping (e.g. platform billing) normally lives in the
          // skipped handler — give it one hook. Never let it break the crawl.
          // userData comes from the rawRequest snapshot: SDK bookkeeping keys already
          // stripped, taken before enhance mutated request.userData.
          if (config.onRecalled) {
            try {
              await config.onRecalled({
                url,
                label: handlerLabel,
                userData: rawRequest.userData,
                data: aiResult.data,
              });
            } catch (hookErr) {
              logger.debug(`onRecalled hook error: ${hookErr}`);
            }
          }
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
        if (originalPushData && config.learning !== false) {
          context.pushData = async (data: Record<string, unknown>) => {
            // Skip learning if:
            // 1. Developer already used brain data via use()
            // 2. Brain already knows this URL (no need to re-learn)
            const shouldLearn = !usedAIData && !aiResult.known;

            if (shouldLearn) {
              runStats.learned++;
              await client.learn(rawRequest, data);
            }

            // Continue with normal pushData
            return originalPushData.call(context, data);
          };
        }

        // Run handler with async context (for Dataset.pushData interception)
        const requestContext: RequestContext = {
          request: rawRequest,
          client,
          learning: config.learning !== false,
          aiKnown: aiResult.known,
        };

        await asyncContext.run(requestContext, async () => {
          await originalHandler.call(crawler, context);
        });

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
    if ("requestHandler" in crawlerAny) {
      crawlerAny.requestHandler = wrappedHandler;
    }
    if ("userDefinedRequestHandler" in crawlerAny) {
      crawlerAny.userDefinedRequestHandler = wrappedHandler;
    }

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
      crawlerAny.addRequests = async (requests: unknown, options?: unknown) => {
        if (!Array.isArray(requests) || requests.length === 0) {
          return originalAddRequests(requests, options);
        }
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
          for (let i = 0; i < batch.length; i++) {
            const r = batch[i] as EnqueuedRequest;
            if (!r || typeof r.url !== "string" || r.skipNavigation) continue;
            if (skipLabels && skipLabels.has(r.label || "default")) continue;
            if ((r.method ?? "GET").toUpperCase() !== "GET" && !r.uniqueKey) continue;
            candidateIdx.push(i);
          }
          if (candidateIdx.length > 0) {
            const rawRequests = candidateIdx.map((i) =>
              buildRawRequest(batch[i] as Record<string, unknown>),
            );
            const results = await client.recallBulk(rawRequests);
            let known = 0;
            candidateIdx.forEach((reqIdx, j) => {
              const result = results[j];
              // On fallback (API degraded) stash nothing — the handler-time recall
              // path stays as the retry.
              if (!result || result.fallback) return;
              const r = batch[reqIdx] as EnqueuedRequest;
              if (result.known && result.data) {
                // Marker in userData (persisted, tiny); payload in the in-process map.
                r.userData = { ...r.userData, __fetchBrainResult: { known: true } };
                stashSet(stashKey(rawRequests[j]), result.data);
                if (!shouldRunHandler(config.alwaysRun, r.label)) {
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
        return originalAddRequests(batch, options);
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
 * AI-aware pushData wrapper
 *
 * Use this instead of Dataset.pushData() for automatic AI learning.
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

  // Learn if we're in a FetchBrain-enhanced request and AI doesn't already know
  if (ctx && ctx.learning && !ctx.aiKnown) {
    // Handle both single object and array
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      await ctx.client.learn(ctx.request, item);
    }
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
