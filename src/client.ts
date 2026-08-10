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
  BatchConfig,
} from "./types";
import { CircuitBreaker } from "./circuit-breaker";
import { RequestBatcher, LearnBatcher } from "./batch";
import { createLogger } from "./logger";
import { buildNativeContext, getPlatformBuildId } from "./native-context";

const DEFAULT_BASE_URL = "https://api.fetchbrain.com";
const DEFAULT_TIMEOUT = 500; // Fast timeout for graceful degradation
const DEFAULT_LEARN_TIMEOUT = 5000; // Longer timeout for batch learn operations
const BULK_RECALL_TIMEOUT = 3000; // Enqueue-time pre-recall is off the per-request hot path: favor reliability over fast-fail
const MAX_BULK_ITEMS = 100; // API's MAX_ITEMS_PER_REQUEST — recallBulk chunks to stay under it
const MAX_LEARN_ENTRIES = 50; // API's MAX_ENTRIES_PER_REQUEST for /v1/learn
const ASK_TIMEOUT = 10000; // Ask hits the knowledge index; give it room like learn

/** Clamp a user-configured batch size to an endpoint's per-request cap. */
function clampBatch(
  batch: Partial<BatchConfig> | undefined,
  cap: number,
): Partial<BatchConfig> | undefined {
  return batch?.maxSize ? { ...batch, maxSize: Math.min(batch.maxSize, cap) } : batch;
}

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
    /** Machine-readable `error` code from the API's response body, if any. */
    public readonly serverError?: string,
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
      "extractForLearning" | "learnUrlField" | "batch" | "circuitBreaker" | "skipLabels" | "preRecall" | "onRecalled"
    >
  > &
    Pick<
      FetchBrainConfig,
      "extractForLearning" | "learnUrlField" | "batch" | "circuitBreaker" | "skipLabels" | "preRecall" | "onRecalled"
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
      skipLabels: config.skipLabels, // enhance-only; stored so getConfig() round-trips
      preRecall: config.preRecall, // enhance-only; stored so getConfig() round-trips
      onRecalled: config.onRecalled, // enhance-only; stored so getConfig() round-trips
    };

    this.logger = createLogger(this.config.debug ? "debug" : "info", true);

    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreaker,
      this.logger,
    );

    // Each batcher's maxSize is clamped to its endpoint's per-request cap — an
    // oversized flush 400s (recall degrades to fallback, learn is swallowed), so a
    // large user-configured maxSize would silently zero the recall rate.
    this.batcher = new RequestBatcher(
      (items) => this.executeBatchQuery(items),
      clampBatch(this.config.batch, MAX_BULK_ITEMS),
      this.logger,
    );

    this.learnBatcher = new LearnBatcher(
      (entries) => this.executeBatchLearn(entries),
      clampBatch(this.config.batch, MAX_LEARN_ENTRIES),
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
   * Recall multiple requests at once — returns ordered array matching input order.
   * Chunks to the API's 100-item cap; a failed chunk degrades to fallback results
   * for its own items only.
   */
  async recallBulk(requests: RawRequest[]): Promise<RecallResult[]> {
    const results: RecallResult[] = [];
    for (let start = 0; start < requests.length; start += MAX_BULK_ITEMS) {
      const chunk = requests.slice(start, start + MAX_BULK_ITEMS);
      if (this.circuitBreaker.isOpen()) {
        results.push(...chunk.map(() => ({ known: false, fallback: true })));
        continue;
      }
      try {
        const items = chunk.map((request, i) => ({ ref: String(i), request }));
        const chunkResults = await this.executeBatchQuery(items, BULK_RECALL_TIMEOUT);
        results.push(...items.map((i) => chunkResults.get(i.ref) ?? { known: false }));
      } catch {
        results.push(...chunk.map(() => ({ known: false, fallback: true })));
      }
    }
    return results;
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
      // A 4xx means the request itself was rejected (bad input, unknown
      // model slug, byok not linked, etc.) — that's not the API degrading,
      // so don't trip the breaker for every scraper sharing this client,
      // and tell the caller why instead of masking it as an outage.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        this.logger.debug("Ask rejected:", error);
        return {
          sources: [],
          status: "rejected",
          error: error.serverError ?? error.message,
        };
      }
      this.circuitBreaker.recordFailure();
      this.logger.debug("Ask request failed:", error);
      return { sources: [], status: "unavailable" };
    }
  }

  /**
   * Execute a batch query against the API
   */
  private async executeBatchQuery(
    items: { ref: string; request: RawRequest }[],
    timeout?: number,
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
      const response = await this.makeRequest<RecallResponse>(
        "/v1/recall",
        {
          method: "POST",
          body: JSON.stringify(request),
        },
        timeout,
      );

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
        let serverError: string | undefined;
        try {
          const errBody = (await response.json()) as { error?: unknown };
          if (typeof errBody.error === "string") serverError = errBody.error;
        } catch {
          // Non-JSON error body — no machine-readable code to carry.
        }
        throw new ApiError(response.status, response.statusText, serverError);
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
