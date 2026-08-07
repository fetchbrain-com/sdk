import type {
  FetchBrainConfig,
  RecallRequest,
  RecallResponse,
  LearnRequest,
  LearnResponse,
  StatsResponse,
  RecallResult,
  AskResponse,
  Logger,
  TelemetryData,
  TelemetryRequest,
  TelemetryResponse,
  RawRequest,
} from "./types";
import { CircuitBreaker } from "./circuit-breaker";
import { RequestBatcher, LearnBatcher } from "./batch";
import { createLogger } from "./logger";
import { buildNativeContext, getPlatformBuildId } from "./native-context";

const DEFAULT_BASE_URL = "https://api.fetchbrain.com";
const DEFAULT_TIMEOUT = 500; // Fast timeout for graceful degradation
const DEFAULT_LEARN_TIMEOUT = 5000; // Longer timeout for batch learn operations
const ASK_TIMEOUT = 10000; // Ask hits the knowledge index; give it room like learn

/**
 * Thrown by makeRequest when the API responds with a non-2xx status.
 * Carries the HTTP status so callers can decide whether a failure should
 * count against the circuit breaker (client errors are the caller's fault,
 * not the API's — they shouldn't trip degradation for everyone).
 */
class ApiError extends Error {
  constructor(
    public readonly status: number,
    statusText: string,
  ) {
    super(`API error: ${status} ${statusText}`);
    this.name = "ApiError";
  }
}

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
      memory: config.memory || "recent",
      learning: config.learning ?? true,
      alwaysRun: config.alwaysRun ?? false,
      refreshOnRebuild: config.refreshOnRebuild ?? false,
      timeout: config.timeout || DEFAULT_TIMEOUT,
      debug: config.debug || false,
      extractForLearning: config.extractForLearning,
      learnUrlField: config.learnUrlField,
      telemetry: config.telemetry ?? { enabled: false }, // opt-in
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
   * Recall if FetchBrain "knows" a request
   */
  async recall(request: RawRequest): Promise<RecallResult> {
    if (this.circuitBreaker.isOpen()) {
      return { known: false, fallback: true };
    }
    try {
      return await this.batcher.query(request);
    } catch (error) {
      this.logger.debug("Recall failed:", error);
      return { known: false, fallback: true };
    }
  }

  /**
   * Recall multiple requests at once — returns ordered array matching input order
   */
  async recallBulk(requests: RawRequest[]): Promise<RecallResult[]> {
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
   * Ask a natural-language question against learned knowledge
   *
   * `model` picks the generation model for answer mode from the server's
   * menu (e.g. "llama-3.3-70b", "kimi-k2.5" — premium models cost extra ask
   * credits), or "byok" to answer with your own linked provider model.
   * Omit it for the default model.
   */
  async ask(
    question: string,
    opts?: { answer?: boolean; limit?: number; model?: string },
  ): Promise<AskResponse> {
    if (this.circuitBreaker.isOpen()) {
      return { sources: [], status: "unavailable" };
    }

    const askBody: {
      query: string;
      answer?: boolean;
      limit?: number;
      build?: string;
      model?: string;
    } = {
      query: question,
      answer: opts?.answer,
      limit: opts?.limit,
      model: opts?.model,
    };

    const platformBuildId = getPlatformBuildId();
    if (this.config.refreshOnRebuild && platformBuildId) {
      askBody.build = platformBuildId;
    }

    try {
      const response = await this.makeRequest<AskResponse>(
        "/v1/ask",
        {
          method: "POST",
          body: JSON.stringify(askBody),
        },
        ASK_TIMEOUT,
      );
      this.circuitBreaker.recordSuccess();
      return response;
    } catch (error) {
      // A 4xx means the request itself was rejected (bad input, indexing
      // disabled, etc.) — that's not the API degrading, so don't trip the
      // breaker for every scraper sharing this client over it.
      const isClientError =
        error instanceof ApiError && error.status >= 400 && error.status < 500;
      if (!isClientError) {
        this.circuitBreaker.recordFailure();
      }
      this.logger.debug("Ask request failed:", error);
      return { sources: [], status: "unavailable" };
    }
  }

  /**
   * Execute a batch query against the API
   */
  private async executeBatchQuery(
    items: { ref: string; request: RawRequest }[],
  ): Promise<Map<string, RecallResult>> {
    const results = new Map<string, RecallResult>();

    const request: RecallRequest = {
      items,
      memory: this.config.memory,
    };

    const platformBuildId = getPlatformBuildId();
    if (this.config.refreshOnRebuild && platformBuildId) {
      request.build = platformBuildId;
    }

    try {
      const response = await this.makeRequest<RecallResponse>("/v1/recall", {
        method: "POST",
        body: JSON.stringify(request),
      });

      this.circuitBreaker.recordSuccess();

      // Index known items by ref
      for (const item of response.known) {
        results.set(item.ref, { known: true, data: item.data });
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

    const request: LearnRequest = { entries: processed };

    const platformBuildId = getPlatformBuildId();
    if (this.config.refreshOnRebuild && platformBuildId) {
      request.build = platformBuildId;
    }

    try {
      const response = await this.makeRequest<LearnResponse>(
        "/v1/learn",
        {
          method: "POST",
          body: JSON.stringify(request),
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

    // Native platform context (allowlisted env vars, picked apart server-side)
    const nativeContext = buildNativeContext();
    if (nativeContext) {
      contextHeaders["X-FB-Context"] = nativeContext;
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
        throw new ApiError(response.status, response.statusText);
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
