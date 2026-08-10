/**
 * FetchBrain SDK Types
 *
 * Type definitions for the FetchBrain AI-powered scraping optimization SDK.
 */

/** How far back the brain recalls: fresh=1h, recent=24h, standard=7d, deep=30d */
export type MemoryDepth = "fresh" | "recent" | "standard" | "deep";

/** Configuration for FetchBrain SDK */
export interface FetchBrainConfig {
  /** API key for authentication */
  apiKey: string;

  /** Base URL for API (defaults to production) */
  baseUrl?: string;

  /** How far back the brain recalls: fresh=1h, recent=24h, standard=7d, deep=30d */
  memory?: MemoryDepth;

  /** Whether AI should learn from new pages */
  learning?: boolean;

  /**
   * Control which handlers run when AI knows the page.
   * - false: Auto-skip all handlers when AI knows (default)
   * - true: Always run all handlers
   * - string[]: Only run handlers with these labels (e.g., ['listing', 'category'])
   * - 'default': Only run the default handler
   *
   * Recalled data always available via context.brain
   */
  alwaysRun?: boolean | string | string[];

  /**
   * Labels that bypass FetchBrain entirely — no recall round-trip, no learn, no brain context.
   * Use for dynamic requests (search, listing, pagination) that must always run live and should
   * never be remembered: unlike `alwaysRun` (which still recalls + can learn), these skip the
   * recall network round-trip and the learn write altogether, removing per-request overhead for
   * requests whose data is not worth remembering. Matches the request `label` (unlabeled = "default").
   * A label listed in both `skipLabels` and `alwaysRun` is bypassed. Bypassed requests are also
   * excluded from telemetry.
   */
  skipLabels?: string[];

  /**
   * Recall requests in bulk as they are enqueued (default: true).
   *
   * In HttpCrawler/CheerioCrawler the HTTP fetch happens BEFORE the request handler runs,
   * so a recall inside the handler is too late to save the fetch. With preRecall the SDK
   * wraps `crawler.addRequests()` (which `run(requests)` also goes through), recalls the
   * whole batch in one API call, marks known requests with `skipNavigation` so Crawlee
   * never fetches them, and stashes the result so the handler does no second recall.
   *
   * Scope: applies to ARRAY input passed to `crawler.addRequests()` / `run(requests)`.
   * Crawlee's context-level `enqueueLinks()` and context `addRequests()` reach the queue
   * via other paths and are not pre-recalled (they still get handler-time recall) — in a
   * handler, enqueue follow-ups with `context.crawler.addRequests([...])` instead.
   * Note recall usage is metered at enqueue time, so requests the queue later dedups
   * still count as queries. The recall result is a snapshot as of enqueue: data learned
   * between enqueue and execution is not picked up (the request is simply scraped and
   * re-learned). If a request skipped its fetch but its remembered data expired before
   * execution (e.g. across a process restart), it fails once without retries and lands
   * in your `failedRequestHandler`; it will be re-scraped on a future run. A transient
   * API outage during that restore is retried normally instead.
   * On crawlers with `retryOnBlocked` the fetch is never skipped (Crawlee's blocked-check
   * needs a response); recalled data still replaces the handler.
   * Set to false to restore handler-time recall only.
   */
  preRecall?: boolean;

  /**
   * Called whenever recalled data is delivered in place of a live scrape — the handler
   * was auto-skipped and the remembered data pushed, or your handler called
   * `context.brain.use()`. Use it for per-record bookkeeping that normally lives in your
   * handler — e.g. platform billing events. Errors are swallowed: a hook failure never
   * breaks the crawl.
   */
  onRecalled?: (event: RecalledEvent) => void | Promise<void>;

  /** Custom data extractor for learning */
  extractForLearning?: (data: unknown) => Record<string, unknown>;

  /**
   * If true, scope both learn and recall to the current build version.
   * Recall only returns known data from the same build; learn stores new
   * data tagged with it. When a scraper updates, it will re-scrape instead
   * of using stale data, and freshly learned data won't be masked by an
   * older build's memory.
   * Uses the platform's native build identifier, auto-detected from the environment.
   * Default: false
   */
  refreshOnRebuild?: boolean;

  /** Request timeout in ms (default: 500ms for fast degradation) */
  timeout?: number;

  /** Enable debug logging */
  debug?: boolean;

  /**
   * Field name to use as URL for learning
   * Useful when request URL is an API endpoint but data contains the actual page URL
   */
  learnUrlField?: string;

  /**
   * Batching configuration for high-performance crawling
   */
  batch?: Partial<BatchConfig>;

  /**
   * Circuit breaker configuration for stability
   */
  circuitBreaker?: Partial<CircuitBreakerConfig>;

  /**
   * Telemetry configuration - opt-in anonymous data sharing
   * Helps improve proxy recommendations, detect blocks, optimize configs
   * Default: disabled
   */
  telemetry?: TelemetryConfig;
}

/** Info passed to `onRecalled` when remembered data is delivered in place of a live scrape */
export interface RecalledEvent {
  url: string;
  label?: string;
  userData?: Record<string, unknown>;
  data: Record<string, unknown>;
}

/** The raw request the SDK forwards; the API derives identity from a subset. */
export interface RawRequest {
  url: string;
  method?: string;
  uniqueKey?: string;
  body?: string;
  headers?: Record<string, string>;
  userData?: Record<string, unknown>;
  label?: string;
}

/** Recall request to the API */
export interface RecallRequest {
  items: { ref: string; request: RawRequest }[];
  memory: MemoryDepth;
  build?: string;
}

/** Single recall result (matched by ref) */
export interface RecallResultItem {
  ref: string;
  data?: Record<string, unknown>;
}

/** Recall response from the API */
export interface RecallResponse {
  known: { ref: string; data: Record<string, unknown> }[];
  unknown: string[]; // refs
}

/** Learn request to the API */
export interface LearnRequest {
  entries: { request: RawRequest; data: Record<string, unknown> }[];
  build?: string;
}

/** Learn response from the API */
export interface LearnResponse {
  learned: number;
  status: "success" | "partial" | "rejected";
  errors?: string[];
}

/** Stats response from the API */
export interface StatsResponse {
  queries: number;
  known: number;
  recallRate: number;
  learned: number;
  period: string;
}

/** Result from AI knowledge recall */
export interface RecallResult {
  known: boolean;
  data?: Record<string, unknown>;
  // Note: No learnedAt
  fallback?: boolean; // True if circuit breaker triggered fallback
}

/** Response from a natural-language ask against learned knowledge */
export interface AskResponse {
  sources: { score: number; url?: string; data: unknown }[];
  answer?: string;
  /**
   * "ok" — answered; "rejected" — the API refused this request (bad input,
   * unknown model slug, byok not linked — see `error`); "unavailable" — the
   * API is degraded or unreachable.
   */
  status: "ok" | "unavailable" | "rejected";
  /** Why the request was rejected (only when status is "rejected"). */
  error?: string;
  /** Slug of the generation model actually used (answer mode; reveals fallbacks). */
  model?: string;
}

/** Circuit breaker states */
export type CircuitState = "closed" | "open" | "half-open";

/** Circuit breaker configuration */
export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time to wait before trying half-open state (ms) */
  resetTimeout: number;
  /** Number of successful calls to close circuit from half-open */
  successThreshold: number;
}

/** Batch configuration */
export interface BatchConfig {
  /** Max items per batch */
  maxSize: number;
  /** Max wait time before flushing (ms) */
  maxWait: number;
}

/** SDK internal state */
export interface FetchBrainState {
  circuitState: CircuitState;
  failures: number;
  successes: number;
  lastFailure: number;
  lastSuccess: number;
}

/** Log levels */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Logger interface */
export interface Logger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

// =============================================================================
// TELEMETRY TYPES
// =============================================================================

/**
 * Telemetry configuration - opt-in data sharing for AI improvements
 */
export interface TelemetryConfig {
  /** Enable telemetry collection (default: false — opt in to join the access-intelligence network) */
  enabled: boolean;

  /** Share performance metrics: response times, retries, status codes */
  sharePerformance?: boolean;

  /** Share proxy info: country, type (never IP addresses) */
  shareProxyInfo?: boolean;

  /** Share site patterns: block rates, rate limits detected */
  shareSitePatterns?: boolean;
}

/**
 * Telemetry data collected from Crawlee context
 * All data is sanitized - no PII, no credentials, no raw content
 */
export interface TelemetryData {
  // Request identification (hashed, not raw)
  domain: string; // e.g., "walmart.com"
  urlHash: string; // SHA256 of full URL
  urlPattern?: string; // e.g., "/ip/*" (generalized path)

  // Performance metrics
  responseTimeMs?: number; // Time to first byte
  totalTimeMs?: number; // Total request time
  statusCode?: number; // HTTP status
  contentSize?: number; // Response size in bytes
  retryCount?: number; // Number of retries for this request

  // Proxy information (anonymized)
  proxyCountry?: string; // e.g., "US"
  proxyType?: string; // "datacenter" | "residential" | "mobile"
  proxySuccess?: boolean; // Did this proxy work?

  // Session state (aggregates only)
  sessionAge?: number; // Requests in current session
  sessionErrorScore?: number; // Error rate 0-1
  cookieCount?: number; // Number of cookies (not values)

  // Blocking indicators
  blocked?: boolean; // Request was blocked
  blockType?: string; // "captcha" | "403" | "429" | "timeout"

  // Crawler metadata
  crawlerType?: string; // "cheerio" | "playwright" | "puppeteer"
  requestLabel?: string; // Developer-defined label

  // Timestamps
  timestamp: string; // ISO timestamp
}

/**
 * Telemetry request to the API
 */
export interface TelemetryRequest {
  entries: TelemetryData[];
}

/**
 * Telemetry response from the API
 */
export interface TelemetryResponse {
  received: number;
  status: "success" | "partial" | "error";
}
