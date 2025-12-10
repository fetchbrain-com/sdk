import { AsyncLocalStorage } from "async_hooks";
import type { FetchBrainConfig, Logger, TelemetryData } from "./types";
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
  url: string;
  client: FetchBrainClient;
  learning: boolean;
  aiKnown: boolean; // Whether AI already knows this URL
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
 * AI context available in request handler
 */
export interface FetchBrainContext {
  /** Whether AI knows this URL */
  known: boolean;
  /** AI data if known */
  data?: Record<string, unknown>;
  /** Confidence score (0-1) */
  confidence?: number;
  /** Use AI data and skip scraping (call in handler to early return) */
  useAIData: () => Promise<void>;
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
  /** FetchBrain AI context - check if AI knows this URL */
  ai?: FetchBrainContext;
  [key: string]: unknown;
}

/**
 * Check if handler should run based on alwaysRun config and request label
 */
function shouldRunHandler(
  alwaysRun: boolean | string | string[] | undefined,
  label: string | undefined
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
 * Context tracking for learning (legacy WeakMap for context.pushData)
 */
const requestContextMap = new WeakMap<object, string>();

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
   * Query if FetchBrain "knows" a URL
   */
  async query(options: { url: string; intelligence?: string }) {
    const result = await this.client.query(options.url);
    return {
      known: result.known,
      data: result.data,
      confidence: result.confidence,
    };
  }

  /**
   * "Teach" FetchBrain new data
   */
  async learn(options: { url: string; data: Record<string, unknown> }) {
    return this.client.learn(options.url, options.data);
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
   * 1. Query AI before making requests (AI knows = skip request)
   * 2. Teach AI after successful requests (learning)
   *
   * @param crawler - Any Crawlee crawler (CheerioCrawler, PlaywrightCrawler, etc.)
   * @param config - FetchBrain configuration
   * @returns Enhanced crawler with same interface
   */
  static enhance<T>(
    crawler: T,
    config: FetchBrainConfig
  ): T & { fetchBrain: FetchBrainClient } {
    const client = new FetchBrainClient(config);
    const logger = createLogger(config.debug ? "debug" : "info", true);

    // Telemetry buffer - automatically flushes to API
    const telemetryBuffer = new TelemetryBuffer({
      maxSize: 50,
      flushInterval: 30000,
      onFlush: async (entries: TelemetryData[]) => {
        if (config.telemetry?.enabled) {
          await client.sendTelemetry(entries);
          logger.debug(`Telemetry: sent ${entries.length} entries`);
        }
      },
    });

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

    // Create wrapped handler
    const wrappedHandler = async (context: RequestHandlerContext) => {
      const { request } = context;
      const url = request.url;
      const label = request.label;
      const startTime = Date.now();

      // Set scrape context for API calls
      setScrapeContext({
        crawler: crawlerType,
        label: label,
        url: url,
      });

      try {
        // 1. Check if FetchBrain "knows" this URL
        const aiResult = await client.query(url);

        // Track if AI data was used (to skip learning)
        let usedAIData = false;
        const originalPushData = context.pushData;

        // 2. Add AI context to handler - developers can check and decide
        context.ai = {
          known: aiResult.known,
          data: aiResult.data,
          confidence: aiResult.confidence,
          useAIData: async () => {
            if (aiResult.known && aiResult.data && originalPushData) {
              usedAIData = true;
              await originalPushData.call(context, aiResult.data);
              logger.info(
                `Used AI data: ${url} (confidence: ${
                  aiResult.confidence?.toFixed(2) || "N/A"
                })`
              );
            }
          },
        };

        // Save in userData for reference
        request.userData = {
          ...request.userData,
          fetchBrainKnown: aiResult.known,
          fetchBrainData: aiResult.data,
        };

        // 3. Check if we should run handler based on label
        const handlerLabel = request.label;
        const runHandler = shouldRunHandler(config.alwaysRun, handlerLabel);

        // 4. Auto-optimization: if AI knows and handler should not run, skip
        if (aiResult.known && aiResult.data && !runHandler) {
          logger.info(
            `Optimized: ${url} [${handlerLabel || "default"}] (confidence: ${
              aiResult.confidence?.toFixed(2) || "N/A"
            })`
          );
          if (originalPushData) {
            await originalPushData.call(context, aiResult.data);
          }
          return;
        }

        // 5. Run handler (either AI doesn't know, or alwaysRun matches this label)
        if (aiResult.known) {
          logger.info(
            `Running handler [${
              handlerLabel || "default"
            }] with AI data available: ${url}`
          );
        } else {
          logger.debug(`Learning: ${url}`);
        }

        // Track current URL for pushData interception
        requestContextMap.set(context, url);

        // Intercept context.pushData to capture results for learning
        if (originalPushData && config.learning !== false) {
          context.pushData = async (data: Record<string, unknown>) => {
            // Skip learning if:
            // 1. Developer already used AI data via useAIData()
            // 2. AI already knows this URL (no need to re-learn)
            const shouldLearn = !usedAIData && !aiResult.known;

            if (shouldLearn) {
              const currentUrl = requestContextMap.get(context) || url;
              await client.learn(currentUrl, data);
            }

            // Continue with normal pushData
            return originalPushData.call(context, data);
          };
        }

        // Run handler with async context (for Dataset.pushData interception)
        const requestContext: RequestContext = {
          url,
          client,
          learning: config.learning !== false,
          aiKnown: aiResult.known,
        };

        await asyncContext.run(requestContext, async () => {
          await originalHandler.call(crawler, context);
        });

        // Cleanup
        requestContextMap.delete(context);

        // Collect telemetry (if enabled) - behind the scenes
        if (config.telemetry?.enabled) {
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
              config.telemetry
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
        if (config.telemetry?.enabled) {
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
              config.telemetry,
              err instanceof Error ? err : new Error(String(err))
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

    // Wrap the run method to flush telemetry when crawl completes
    if (typeof crawlerAny.run === "function") {
      const originalRun = crawlerAny.run.bind(crawlerAny);
      crawlerAny.run = async (...args: unknown[]) => {
        try {
          const result = await originalRun(...args);
          return result;
        } finally {
          // Flush telemetry buffer when crawl completes
          if (config.telemetry?.enabled) {
            logger.debug("Telemetry: flushing on crawl complete");
            await telemetryBuffer.stop();
          }
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
    data: Record<string, unknown> | Record<string, unknown>[]
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
  datasetName?: string
): Promise<void> {
  const ctx = getCurrentContext();

  // Learn if we're in a FetchBrain-enhanced request and AI doesn't already know
  if (ctx && ctx.learning && !ctx.aiKnown) {
    // Handle both single object and array
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      await ctx.client.learn(ctx.url, item);
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
