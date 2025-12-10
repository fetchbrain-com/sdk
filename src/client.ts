import type {
  FetchBrainConfig,
  QueryRequest,
  QueryResponse,
  LearnRequest,
  LearnResponse,
  StatsResponse,
  AIResult,
  Logger,
  TelemetryData,
  TelemetryRequest,
  TelemetryResponse,
} from "./types";
import { CircuitBreaker } from "./circuit-breaker";
import { RequestBatcher } from "./batch";
import { createLogger } from "./logger";

const DEFAULT_BASE_URL = "https://api.fetchbrain.com";
const DEFAULT_TIMEOUT = 500; // Fast timeout for graceful degradation

/**
 * Scrape context sent with API requests
 */
interface ScrapeContext {
  crawler?: string;
  label?: string;
  url?: string;
}

// Track current scrape context (set by enhance wrapper)
let currentContext: ScrapeContext = {};

export function setScrapeContext(ctx: ScrapeContext): void {
  currentContext = ctx;
}

export function clearScrapeContext(): void {
  currentContext = {};
}

/**
 * FetchBrain API Client
 *
 * Handles all communication with the FetchBrain API including:
 * - Request batching for high concurrency
 * - Circuit breaker for graceful degradation
 * - Automatic retries and timeouts
 */
export class FetchBrainClient {
  private config: Required<Omit<FetchBrainConfig, "extractForLearning">> &
    Pick<FetchBrainConfig, "extractForLearning">;
  private circuitBreaker: CircuitBreaker;
  private batcher: RequestBatcher;
  private logger: Logger;

  constructor(config: FetchBrainConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || DEFAULT_BASE_URL,
      intelligence: config.intelligence || "high",
      learning: config.learning ?? true,
      alwaysRun: config.alwaysRun ?? false,
      strictBuildMatch: config.strictBuildMatch ?? false,
      timeout: config.timeout || DEFAULT_TIMEOUT,
      debug: config.debug || false,
      extractForLearning: config.extractForLearning,
      telemetry: config.telemetry ?? { enabled: true },
    };

    this.logger = createLogger(this.config.debug ? "debug" : "info", true);

    this.circuitBreaker = new CircuitBreaker({}, this.logger);

    this.batcher = new RequestBatcher(
      (urls) => this.executeBatchQuery(urls),
      {},
      this.logger
    );
  }

  /**
   * Query if FetchBrain "knows" a URL
   */
  async query(url: string): Promise<AIResult> {
    // Circuit breaker check
    if (this.circuitBreaker.isOpen()) {
      this.logger.debug(`Circuit open, skipping query for: ${url}`);
      return { known: false, fallback: true };
    }

    try {
      return await this.batcher.query(url);
    } catch (error) {
      this.logger.debug(`Query failed for ${url}:`, error);
      return { known: false, fallback: true };
    }
  }

  /**
   * Query multiple URLs at once (bypass batcher for bulk operations)
   */
  async queryBulk(urls: string[]): Promise<Map<string, AIResult>> {
    if (this.circuitBreaker.isOpen()) {
      this.logger.debug(`Circuit open, skipping bulk query`);
      return new Map(
        urls.map((url) => [url, { known: false, fallback: true }])
      );
    }

    try {
      return await this.executeBatchQuery(urls);
    } catch (error) {
      this.logger.debug(`Bulk query failed:`, error);
      return new Map(
        urls.map((url) => [url, { known: false, fallback: true }])
      );
    }
  }

  /**
   * "Teach" FetchBrain new data
   */
  async learn(
    url: string,
    data: Record<string, unknown>
  ): Promise<LearnResponse> {
    if (!this.config.learning) {
      return { status: "rejected", learned: 0 };
    }

    if (this.circuitBreaker.isOpen()) {
      this.logger.debug(`Circuit open, skipping learn for: ${url}`);
      return { status: "rejected", learned: 0 };
    }

    try {
      const extractedData = this.config.extractForLearning
        ? this.config.extractForLearning(data)
        : data;

      const response = await this.makeRequest<LearnResponse>("/v1/learn", {
        method: "POST",
        body: JSON.stringify({
          entries: [{ url, data: extractedData }],
        } satisfies LearnRequest),
      });

      this.circuitBreaker.recordSuccess();
      this.logger.debug(`Learned data for: ${url}`);
      return response;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      this.logger.warn(`Learn failed for ${url}:`, error);
      return { status: "rejected", learned: 0 };
    }
  }

  /**
   * Get usage statistics
   */
  async stats(): Promise<StatsResponse | null> {
    if (this.circuitBreaker.isOpen()) {
      return null;
    }

    try {
      const response = await this.makeRequest<StatsResponse>("/v1/stats", {
        method: "GET",
      });
      this.circuitBreaker.recordSuccess();
      return response;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      this.logger.warn("Stats request failed:", error);
      return null;
    }
  }

  /**
   * Execute a batch query against the API
   */
  private async executeBatchQuery(
    urls: string[]
  ): Promise<Map<string, AIResult>> {
    const results = new Map<string, AIResult>();

    // Build query request
    const request: QueryRequest = {
      urls,
      intelligence: this.config.intelligence,
    };

    // If strictBuildMatch is enabled, include current build to filter results
    if (this.config.strictBuildMatch && process.env.APIFY_ACTOR_BUILD_ID) {
      request.build = process.env.APIFY_ACTOR_BUILD_ID;
    }

    try {
      const response = await this.makeRequest<QueryResponse>("/v1/query", {
        method: "POST",
        body: JSON.stringify(request),
      });

      this.circuitBreaker.recordSuccess();

      // Process known URLs
      for (const item of response.known) {
        results.set(item.url, {
          known: true,
          data: item.data,
          confidence: item.confidence,
        });
      }

      // Process unknown URLs
      for (const url of response.unknown) {
        results.set(url, { known: false });
      }

      return results;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      throw error;
    }
  }

  /**
   * Make an HTTP request to the API
   */
  private async makeRequest<T>(path: string, options: RequestInit): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    // Build context headers
    const contextHeaders: Record<string, string> = {
      "X-FB-SDK": "js",
      "X-FB-Node": process.version || "unknown",
      "X-FB-Platform": process.platform || "unknown",
    };

    // Environment
    if (process.env.NODE_ENV) {
      contextHeaders["X-FB-Env"] = process.env.NODE_ENV;
    }

    // Apify context (auto-detected from environment)
    if (process.env.APIFY_ACTOR_ID) {
      contextHeaders["X-FB-Apify"] = process.env.APIFY_ACTOR_ID;
    }
    if (process.env.APIFY_ACTOR_BUILD_ID) {
      contextHeaders["X-FB-Build"] = process.env.APIFY_ACTOR_BUILD_ID;
    }
    if (process.env.APIFY_ACTOR_RUN_ID) {
      contextHeaders["X-FB-Apify-Run"] = process.env.APIFY_ACTOR_RUN_ID;
    }

    // Scrape context
    if (currentContext.crawler) {
      contextHeaders["X-FB-Crawler"] = currentContext.crawler;
    }
    if (currentContext.label) {
      contextHeaders["X-FB-Label"] = currentContext.label;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          ...contextHeaders,
          ...options.headers,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get the current configuration
   */
  getConfig(): FetchBrainConfig {
    return { ...this.config };
  }

  /**
   * Get the circuit breaker state
   */
  getCircuitState() {
    return this.circuitBreaker.getStats();
  }

  /**
   * Reset the circuit breaker (for testing)
   */
  resetCircuit(): void {
    this.circuitBreaker.reset();
  }

  /**
   * Clear pending batched requests
   */
  clearBatch(): void {
    this.batcher.clear();
  }

  /**
   * Send telemetry data to the API
   * This is fire-and-forget - failures are silently ignored
   */
  async sendTelemetry(entries: TelemetryData[]): Promise<void> {
    if (!this.config.telemetry?.enabled || entries.length === 0) {
      return;
    }

    try {
      await this.makeRequest<TelemetryResponse>("/v1/telemetry", {
        method: "POST",
        body: JSON.stringify({ entries } satisfies TelemetryRequest),
      });
    } catch {
      // Telemetry failures are silent - don't affect scraper
    }
  }

  /**
   * Check if telemetry is enabled
   */
  isTelemetryEnabled(): boolean {
    return this.config.telemetry?.enabled ?? false;
  }

  /**
   * Get telemetry config
   */
  getTelemetryConfig() {
    return this.config.telemetry;
  }
}
