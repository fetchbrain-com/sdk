import type { FetchBrainConfig, Logger } from './types';
import { FetchBrainClient } from './client';
import { createLogger } from './logger';

/**
 * Crawlee crawler type - we use a minimal interface to avoid tight coupling
 */
interface CrawlerLike {
  requestHandler?: (context: RequestHandlerContext) => Promise<void>;
  run: (requests?: unknown[]) => Promise<void>;
}

/**
 * Minimal request handler context interface
 */
interface RequestHandlerContext {
  request: {
    url: string;
    userData?: Record<string, unknown>;
  };
  log?: {
    info: (message: string) => void;
    debug: (message: string) => void;
  };
  pushData?: (data: Record<string, unknown>) => Promise<void>;
  [key: string]: unknown;
}

/**
 * Enhanced crawler with FetchBrain optimization
 */
interface EnhancedCrawler<T extends CrawlerLike> extends CrawlerLike {
  fetchBrain: FetchBrainClient;
  originalCrawler: T;
}

/**
 * Context tracking for learning
 * Uses a WeakMap to track current request URL for pushData interception
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
    this.logger = createLogger(config.debug ? 'debug' : 'info', true);
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
      learnedAt: result.learnedAt,
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
  static enhance<T extends CrawlerLike>(
    crawler: T,
    config: FetchBrainConfig
  ): T & { fetchBrain: FetchBrainClient } {
    const client = new FetchBrainClient(config);
    const logger = createLogger(config.debug ? 'debug' : 'info', true);

    // Get original request handler
    const originalHandler = (crawler as any).requestHandler || 
                           (crawler as any).userDefinedRequestHandler;

    if (!originalHandler) {
      logger.warn('No request handler found on crawler, returning unmodified');
      return Object.assign(crawler, { fetchBrain: client });
    }

    // Create wrapped handler
    const wrappedHandler = async (context: RequestHandlerContext) => {
      const { request } = context;
      const url = request.url;

      // 1. Check if FetchBrain "knows" this URL
      const aiResult = await client.query(url);

      if (aiResult.known && aiResult.data) {
        // AI knows this URL - skip the actual request
        logger.info(`Optimized: ${url} (confidence: ${aiResult.confidence?.toFixed(2) || 'N/A'})`);
        
        // Push AI knowledge directly
        if (context.pushData) {
          await context.pushData(aiResult.data);
        }
        
        // Save in userData for reference
        request.userData = {
          ...request.userData,
          fetchBrainKnown: true,
          fetchBrainData: aiResult.data,
        };
        
        return; // Don't call original handler
      }

      // 2. AI doesn't know - run original handler
      logger.debug(`Learning: ${url}`);

      // Track current URL for pushData interception
      requestContextMap.set(context, url);

      // Intercept pushData to capture results for learning
      const originalPushData = context.pushData;
      if (originalPushData && config.learning !== false) {
        context.pushData = async (data: Record<string, unknown>) => {
          // Teach FetchBrain this data
          const currentUrl = requestContextMap.get(context) || url;
          await client.learn(currentUrl, data);
          
          // Continue with normal pushData
          return originalPushData.call(context, data);
        };
      }

      // Run original handler
      await originalHandler.call(crawler, context);

      // Cleanup
      requestContextMap.delete(context);
    };

    // Replace the handler
    if ('requestHandler' in crawler) {
      (crawler as any).requestHandler = wrappedHandler;
    }
    if ('userDefinedRequestHandler' in crawler) {
      (crawler as any).userDefinedRequestHandler = wrappedHandler;
    }

    // Attach client for direct access
    return Object.assign(crawler, { fetchBrain: client });
  }
}

/**
 * Create a standalone FetchBrain client without crawler enhancement
 */
export function createFetchBrain(config: FetchBrainConfig): FetchBrain {
  return new FetchBrain(config);
}
