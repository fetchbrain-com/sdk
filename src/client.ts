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
  RawRequest,
} from "./types";
import { CircuitBreaker } from "./circuit-breaker";
import { RequestBatcher, LearnBatcher } from "./batch";
import { createLogger } from "./logger";

const DEFAULT_BASE_URL = "https://api.fetchbrain.com";
const DEFAULT_TIMEOUT = 500; // Fast timeout for graceful degradation
const DEFAULT_LEARN_TIMEOUT = 5000; // Longer timeout for batch learn operations

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
  private config: Required<
    Omit<
      FetchBrainConfig,
      "extractForLearning" | "learnUrlField" | "batch" | "circuitBreaker"
    >
  > &
    Pick<
      FetchBrainConfig,
      "extractForLearning" | "learnUrlField" | "batch" | "circuitBreaker"
    >;
  private circuitBreaker: CircuitBreaker;
  private batcher: RequestBatcher;
  private learnBatcher: LearnBatcher;
  private logger: Logger;

  constructor(config: FetchBrainConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || DEFAULT_BASE_URL,
      intelligence: config.intelligence || "high",
      learning: config.learning ?? true,
      alwaysRun: config.alwaysRun ?? false,
      refreshOnRebuild: config.refreshOnRebuild ?? false,
      timeout: config.timeout || DEFAULT_TIMEOUT,
      debug: config.debug || false,
      extractForLearning: config.extractForLearning,
      learnUrlField: config.learnUrlField,
      telemetry: config.telemetry ?? { enabled: true },
      batch: config.batch,
      circuitBreaker: config.circuitBreaker,
    };

    this.logger = createLogger(this.config.debug ? "debug" : "info", true);

    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreaker,
      this.logger,
    );

    this.batcher = new RequestBatcher(
      (items) => this.executeBatchQuery(items),
      this.config.batch,
      this.logger,
    );

    this.learnBatcher = new LearnBatcher(
      (entries) => this.executeBatchLearn(entries),
      this.config.batch,
      this.logger,
    );
  }

  /**
   * Query if FetchBrain "knows" a request
   */
  async query(request: RawRequest): Promise<AIResult> {
    if (this.circuitBreaker.isOpen()) {
      return { known: false, fallback: true };
    }
    try {
      return await this.batcher.query(request);
    } catch (error) {
      this.logger.debug("Query failed:", error);
      return { known: false, fallback: true };
    }
  }

  /**
   * Query multiple requests at once — returns ordered array matching input order
   */
  async queryBulk(requests: RawRequest[]): Promise<AIResult[]> {
    if (this.circuitBreaker.isOpen()) {
      return requests.map(() => ({ known: false, fallback: true }));
    }
    try {
      const items = requests.map((request, i) => ({ ref: String(i), request }));
      const results = await this.executeBatchQuery(items);
      return items.map((i) => results.get(i.ref) ?? { known: false });
    } catch {
      return requests.map(() => ({ known: false, fallback: true }));
    }
  }

  /**
   * "Teach" FetchBrain new data (batched for high-concurrency)
   */
  async learn(request: RawRequest, data: Record<string, unknown>): Promise<LearnResponse> {
    if (!this.config.learning) {
      return { status: "rejected", learned: 0 };
    }
    if (this.circuitBreaker.isOpen()) {
      return { status: "rejected", learned: 0 };
    }
    try {
      return await this.learnBatcher.learn(request, data);
    } catch (error) {
      this.logger.warn("Learn failed:", error);
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
    items: { ref: string; request: RawRequest }[],
  ): Promise<Map<string, AIResult>> {
    const results = new Map<string, AIResult>();

    const request: QueryRequest = {
      items,
      intelligence: this.config.intelligence,
    };

    if (this.config.refreshOnRebuild && process.env.APIFY_ACTOR_BUILD_ID) {
      request.build = process.env.APIFY_ACTOR_BUILD_ID;
    }

    try {
      const response = await this.makeRequest<QueryResponse>("/v1/query", {
        method: "POST",
        body: JSON.stringify(request),
      });

      this.circuitBreaker.recordSuccess();

      // Index known items by ref
      for (const item of response.known) {
        results.set(item.ref, { known: true, data: item.data, confidence: item.confidence });
      }

      // Index unknown refs
      for (const ref of response.unknown) {
        results.set(ref, { known: false });
      }

      return results;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      throw error;
    }
  }

  /**
   * Execute a batch learn against the API
   */
  private async executeBatchLearn(
    entries: { request: RawRequest; data: Record<string, unknown> }[],
  ): Promise<LearnResponse> {
    const processed = entries.map((e) => ({
      request: e.request,
      data: this.config.extractForLearning ? this.config.extractForLearning(e.data) : e.data,
    }));

    try {
      const response = await this.makeRequest<LearnResponse>(
        "/v1/learn",
        {
          method: "POST",
          body: JSON.stringify({ entries: processed } satisfies LearnRequest),
        },
        DEFAULT_LEARN_TIMEOUT,
      );

      this.circuitBreaker.recordSuccess();
      return response;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      throw error;
    }
  }

  /**
   * Make an HTTP request to the API
   */
  private async makeRequest<T>(
    path: string,
    options: RequestInit,
    timeout?: number,
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      timeout ?? this.config.timeout,
    );

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
    this.learnBatcher.clear();
  }

  /**
   * Flush pending learn requests (call before shutdown)
   */
  async flushLearnBatch(): Promise<void> {
    await this.learnBatcher.forceFlush();
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
