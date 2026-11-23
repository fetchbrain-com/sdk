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
  LearnedData,
} from "./types";
import { CircuitBreaker } from "./circuit-breaker";
import { RequestBatcher, LearnBatcher } from "./batch";
import { createLogger } from "./logger";
import { buildNativeContext, getPlatformBuildId, resolveScraperName } from "./native-context";

const DEFAULT_BASE_URL = "https://api.fetchbrain.com";
// Per-request recall timeout. Measured against the real API (2026-11-22): server
// time 205-490ms by batch size plus network RTT (up to ~165ms observed), so 500ms
// timed out every 50-recall batch and opened the breaker. 1500ms leaves headroom;
// a degraded API still trips the breaker after a few timeouts.
const DEFAULT_TIMEOUT = 1500;
const DEFAULT_LEARN_TIMEOUT = 5000; // Longer timeout for batch learn operations
const BULK_RECALL_TIMEOUT = 3000; // Enqueue-time pre-recall is off the per-request hot path: favor reliability over fast-fail
// API's MAX_ITEMS_PER_REQUEST is 100, but API versions before the high-volume fix
// fail a recall with 97+ unknown items (database variable limit). 90 works on both,
// so this SDK is safe whichever side deploys first.
const MAX_BULK_ITEMS = 90;
// How long all calls pause after a 401 before trying the key again.
const KEY_REJECTED_PAUSE_MS = 60_000;
const BULK_RECALL_CONCURRENCY = 5; // Chunks in flight at once — caps enqueue latency for huge seed lists without stampeding the API
const MAX_LEARN_ENTRIES = 50; // API's MAX_ENTRIES_PER_REQUEST for /v1/learn
const MAX_LEARN_DATA_BYTES = 100 * 1024; // API's per-entry cap (JSON length of data)

/**
 * A 4xx is the API refusing THIS request (hard cap, bad input, auth), not the
 * API being down. Counting it as an outage would open the shared breaker and
 * also stop learns the API would accept. Only 5xx, network errors and timeouts
 * are outages.
 */
function isOutage(error: unknown): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}
const ASK_TIMEOUT = 10000; // Ask searches memory and may generate an answer; give it room like learn

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
    /** Specific rejection reason (`details.code ?? code`), e.g. LEARN_CAP_EXCEEDED. */
    public readonly code?: string,
    /** Seconds from a `Retry-After` header, when the API sent one. */
    public readonly retryAfterSec?: number,
  ) {
    super(`API error: ${status} ${statusText}`);
    this.name = "ApiError";
  }
}

/** `Retry-After` as seconds: delta-seconds or an HTTP-date (RFC 9110). */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs > 0 ? secs : undefined;
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  const delta = (at - Date.now()) / 1000;
  return delta > 0 ? delta : undefined;
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
      "extractForLearning" | "learnUrlField" | "batch" | "circuitBreaker" | "skipLabels" | "preRecall" | "onRecalled" | "scraper"
    >
  > &
    Pick<
      FetchBrainConfig,
      "extractForLearning" | "learnUrlField" | "batch" | "circuitBreaker" | "skipLabels" | "preRecall" | "onRecalled" | "scraper"
    >;
  private circuitBreaker: CircuitBreaker;
  private batcher: RequestBatcher;
  private learnBatcher: LearnBatcher;
  private logger: Logger;
  /**
   * Epoch ms until which learns are paused after the API reported the monthly
   * learn cap — the start of the next UTC month, when the cap resets. 0 = not paused.
   */
  private learnPausedUntil = 0;
  /**
   * Set by a 401 (key invalid or revoked): calls answer locally until then
   * instead of each paying a failing round-trip. A pause, not a permanent stop:
   * a key used right after it is created can see a brief 401 while the key
   * propagates, and that must not switch FetchBrain off for a whole run.
   */
  private keyRejectedUntil = 0;
  private keyRejectedWarned = false;
  /** The oversized-page warning is shown once per client, then logged at debug. */
  private warnedOversizeLearn = false;
  /** Warn about the learn cap once per pause, independent of the pause state. */
  private learnCapWarnedUntil = 0;
  /** Valid, normalized scraper name (option, else env var); undefined = default memory. */
  private scraperName: string | undefined;

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
      scraper: config.scraper,
    };

    this.logger = createLogger(this.config.debug ? "debug" : "info", true);

    // Scraper name, resolved once: invalid values are dropped (never thrown).
    const scraper = resolveScraperName(config.scraper);
    this.scraperName = scraper.name;
    for (const source of scraper.rejected) {
      this.logger.warn(
        `ignoring invalid scraper name from ${source === "option" ? "the scraper option" : source}; ` +
          "use 1-64 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit. " +
          (scraper.name ? `Using "${scraper.name}" instead.` : "This scraper uses the shared default memory."),
      );
    }

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

  /** True when recalls must not reach the API right now (crawl continues without). */
  private recallBlocked(): boolean {
    return this.isKeyRejected() || this.circuitBreaker.isOpen();
  }

  private isKeyRejected(): boolean {
    return Date.now() < this.keyRejectedUntil;
  }

  /**
   * React to a 4xx the API returned. These are not outages (they don't open the
   * shared breaker). A 401 means the next calls would fail the same way, so all
   * calls pause for KEY_REJECTED_PAUSE_MS. (429 on recall deliberately does NOT
   * pause recalls locally: a locally refused handler-time recall fails a
   * fetch-skipped request, whereas the API's own answer can still succeed.)
   */
  private noteRefusal(error: unknown): void {
    if (!(error instanceof ApiError) || error.status !== 401) return;
    this.keyRejectedUntil = Date.now() + KEY_REJECTED_PAUSE_MS;
    if (!this.keyRejectedWarned) {
      this.keyRejectedWarned = true;
      this.logger.warn(
        "FetchBrain API key was rejected (401: invalid or revoked). FetchBrain pauses for 60s at a time while it is; the crawl continues without it.",
      );
    }
  }

  /**
   * Recall if FetchBrain "knows" a request
   */
  async recall(request: RawRequest): Promise<RecallResult> {
    if (this.recallBlocked()) {
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
   * Chunks to MAX_BULK_ITEMS (under the API's 100-item cap) and runs chunks with bounded concurrency; a
   * failed chunk degrades to fallback results for its own items only.
   */
  async recallBulk(requests: RawRequest[]): Promise<RecallResult[]> {
    const chunks: RawRequest[][] = [];
    for (let start = 0; start < requests.length; start += MAX_BULK_ITEMS) {
      chunks.push(requests.slice(start, start + MAX_BULK_ITEMS));
    }
    const chunkResults: RecallResult[][] = new Array(chunks.length);
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const idx = next++;
        const chunk = chunks[idx];
        if (this.recallBlocked()) {
          chunkResults[idx] = chunk.map(() => ({ known: false, fallback: true }));
          continue;
        }
        try {
          const items = chunk.map((request, i) => ({ ref: String(i), request }));
          const resultMap = await this.executeBatchQuery(items, BULK_RECALL_TIMEOUT);
          chunkResults[idx] = items.map((i) => resultMap.get(i.ref) ?? { known: false });
        } catch {
          chunkResults[idx] = chunk.map(() => ({ known: false, fallback: true }));
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(BULK_RECALL_CONCURRENCY, chunks.length) }, worker),
    );
    return chunkResults.flat();
  }

  /**
   * "Teach" FetchBrain new data (batched for high-concurrency)
   */
  async learn(request: RawRequest, data: LearnedData): Promise<LearnResponse> {
    if (!this.config.learning) {
      return { status: "rejected", learned: 0 };
    }
    if (this.isKeyRejected() || Date.now() < this.learnPausedUntil || this.circuitBreaker.isOpen()) {
      return { status: "rejected", learned: 0 };
    }
    // Size is checked per page, before batching, so an oversized page is
    // refused on its own (and reported as not learned) instead of being dropped
    // silently inside a batch whose result says "success". The page's records
    // are kept or refused together: learning only the ones that fit would later
    // recall a listing with items missing and no sign that anything is.
    const processed = this.extractForLearning(data);
    if (JSON.stringify(processed).length > MAX_LEARN_DATA_BYTES) {
      const message =
        `A page's data is over the ${MAX_LEARN_DATA_BYTES / 1024}KB learn limit, so it was not learned ` +
        "and will be fetched again on later runs. Use extractForLearning to keep only the fields you need.";
      if (this.warnedOversizeLearn) this.logger.debug(message);
      else this.logger.warn(message);
      this.warnedOversizeLearn = true;
      return { status: "rejected", learned: 0, errors: ["too_large"] };
    }
    try {
      return await this.learnBatcher.learn(request, processed);
    } catch (error) {
      if (error instanceof ApiError && error.code === "LEARN_CAP_EXCEEDED") {
        return { status: "rejected", learned: 0 };
      }
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
      if (isOutage(error)) this.circuitBreaker.recordFailure();
      this.logger.warn("Stats request failed:", error);
      return null;
    }
  }

  /**
   * Ask a natural-language question, answered from everything the account has learned
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
      if (isOutage(error)) this.circuitBreaker.recordFailure();
      else this.noteRefusal(error);
      throw error;
    }
  }

  /** Apply the user's extractForLearning hook to each learned record. */
  private extractForLearning(data: LearnedData): LearnedData {
    const extract = this.config.extractForLearning;
    if (!extract) return data;
    return Array.isArray(data) ? data.map((d) => extract(d)) : extract(data);
  }

  /**
   * Execute a batch learn against the API
   */
  private async executeBatchLearn(
    entries: { request: RawRequest; data: LearnedData }[],
  ): Promise<LearnResponse> {
    // Entries arrive already extracted and size-checked by learn().
    if (entries.length === 0) return { status: "rejected", learned: 0 };

    const request: LearnRequest = { entries };

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
      // A 4xx is the learn being refused (cap reached, rate-limited, invalid
      // entry), not the API degrading — tripping the shared breaker here would
      // also stop RECALLS, so the crawl would re-scrape pages FetchBrain
      // already knows. Back-pressure is handled with a learn-only pause instead.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        this.noteRefusal(error);
        if (error.code === "LEARN_CAP_EXCEEDED") {
          const now = new Date();
          const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
          // Always extend (a shorter 429 pause may already be active).
          this.learnPausedUntil = Math.max(this.learnPausedUntil, monthStart);
          if (this.learnCapWarnedUntil < monthStart) {
            this.learnCapWarnedUntil = monthStart;
            this.logger.warn(
              "FetchBrain monthly learning limit reached — learning is paused until the 1st (UTC); recall keeps working.",
            );
          }
        } else if (error.status === 429) {
          const waitMs = Math.min(Math.max(error.retryAfterSec ?? 30, 1), 3600) * 1000;
          this.learnPausedUntil = Math.max(this.learnPausedUntil, Date.now() + waitMs);
          this.logger.debug(`Learn rate-limited; pausing learns for ${waitMs / 1000}s`);
        }
        throw error;
      }
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
    const nativeContext = buildNativeContext(process.env, this.scraperName);
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
        let code: string | undefined;
        try {
          const errBody = (await response.json()) as {
            error?: unknown;
            code?: unknown;
            details?: { code?: unknown };
          };
          if (typeof errBody.error === "string") serverError = errBody.error;
          const specific = errBody.details?.code ?? errBody.code;
          if (typeof specific === "string") code = specific;
        } catch {
          // Non-JSON error body — no machine-readable code to carry.
        }
        throw new ApiError(
          response.status,
          response.statusText,
          serverError,
          code,
          parseRetryAfter(response.headers.get("Retry-After")),
        );
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
  /**
   * Wait (at most `timeoutMs`) until the background learn backlog has room.
   * Lets the crawler slow to the API's pace instead of queueing without limit.
   */
  async waitForLearnRoom(timeoutMs: number): Promise<boolean> {
    return this.learnBatcher.waitForRoom(timeoutMs);
  }

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
