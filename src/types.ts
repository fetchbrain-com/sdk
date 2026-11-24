/**
 * FetchBrain SDK Types
 *
 * Type definitions for the FetchBrain SDK — memory for your scrapers.
 */

/** How far back the brain recalls: fresh=1h, recent=24h, standard=7d, deep=30d */
export type MemoryDepth = "fresh" | "recent" | "standard" | "deep";

/** Options for change detection. */
export interface ChangeDetectionConfig {
  /** Relearn known `alwaysRun` pages and report what changed (default: false). */
  enabled?: boolean;
  /** Field names to ignore when comparing versions (e.g. "scrapedAt"). */
  ignoreFields?: string[];
}

/** A scraper-drift finding: a field whose fill rate or type shifted. */
export interface DriftItem {
  label: string;
  field: string;
  kind: "fill_drop" | "missing" | "type_changed";
  /** Fill rate 0..1 (or a type name for type_changed). */
  from: number | string;
  to: number | string;
}

/** A run-level flag returned by the run report. */
export interface RunFlag {
  label: string;
  kind: "empty_pages" | "failed_pages";
  rate: number;
}

/** Per-label page counts in a run report. */
export interface RunLabelCounts {
  scraped: number;
  empty: number;
  failed: number;
}

/** End-of-run report body (counts and labels only). */
export interface RunReport {
  runId: string;
  build?: string;
  startedAt?: string;
  endedAt?: string;
  scraped: number;
  learned: number;
  recalled: number;
  labels?: Record<string, RunLabelCounts>;
}

/** Change counts accumulated by a client, once per learn HTTP batch. */
export interface ChangeStats {
  changed: number;
  unchanged: number;
  firstSeen: number;
  drift: DriftItem[];
}

/** Configuration for FetchBrain SDK */
export interface FetchBrainConfig {
  /** API key for authentication */
  apiKey: string;

  /**
   * Name this scraper so it gets its own memory (otherwise every scraper on
   * your account outside Apify shares one default memory). Same as setting the
   * FETCHBRAIN_SCRAPER_ID env var; a valid option wins, an empty or invalid one
   * falls back to the env var. Lowercase letters, digits, '.', '_' and '-',
   * max 64, starting with a letter or digit. Invalid names are ignored with a
   * warning. On Apify a name overrides the actor id.
   */
  scraper?: string;

  /**
   * Change detection: relearn known pages your `alwaysRun` handlers re-scrape so
   * FetchBrain can tell what changed since last time. Off by default. Relearning
   * counts toward your learn usage.
   */
  changeDetection?: ChangeDetectionConfig;

  /**
   * Send a small end-of-run report so FetchBrain can flag runs where many pages
   * came back empty or failed. It contains exactly: the run id, start and end
   * timestamps, scraped/learned/recalled counts, per-label page counts
   * (scraped/empty/failed), and the build id only with `refreshOnRebuild`.
   * No URLs or data. Default: true. Set false to disable. Separate from telemetry.
   */
  reportRuns?: boolean;

  /** Base URL for API (defaults to production) */
  baseUrl?: string;

  /** How far back the brain recalls: fresh=1h, recent=24h, standard=7d, deep=30d */
  memory?: MemoryDepth;

  /** Teach the brain from scraped data (default: true) */
  learning?: boolean;

  /**
   * Control which handlers run when the brain knows the request.
   * - false: Auto-skip all handlers when the request is known (default)
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
   * Note known recalls are counted at enqueue time, so known requests the queue later
   * dedups still count as recalls. The recall result is a snapshot as of enqueue: data learned
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
   * handler — e.g. metrics or counters. Errors are swallowed: a hook failure never
   * breaks the crawl.
   */
  onRecalled?: (event: RecalledEvent) => void | Promise<void>;

  /** Transform each pushed record before the brain learns it */
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

  /** Request timeout in ms (default: 1500ms; see DEFAULT_TIMEOUT in client.ts) */
  timeout?: number;

  /** Enable debug logging */
  debug?: boolean;

  /**
   * Field name to use as URL for learning.
   * Note: accepted and stored, but not currently applied by the SDK.
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
   * Telemetry configuration — opt-in, pseudonymous (sent with your API key).
   * Helps improve proxy recommendations, detect blocks, optimize configs.
   * Default: disabled. See the README "Telemetry (opt-in)" section for every field sent.
   */
  telemetry?: TelemetryConfig;
}

/**
 * What one remembered request holds: the record the page pushed, or every
 * record when the page pushed several (a listing page). Recalled arrays are
 * pushed as-is — Crawlee's pushData accepts both shapes.
 */
export type LearnedData = Record<string, unknown> | Record<string, unknown>[];

/** Info passed to `onRecalled` when remembered data is delivered in place of a live scrape */
export interface RecalledEvent {
  url: string;
  label?: string;
  userData?: Record<string, unknown>;
  data: LearnedData;
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
  data?: LearnedData;
}

/** Recall response from the API */
export interface RecallResponse {
  known: { ref: string; data: LearnedData }[];
  unknown: string[]; // refs
}

/** Learn request to the API */
export interface LearnRequest {
  entries: { request: RawRequest; data: LearnedData }[];
  build?: string;
  ignore?: string[];
}

/** Learn response from the API */
export interface LearnResponse {
  learned: number;
  status: "success" | "partial" | "rejected";
  errors?: string[];
  changed?: number;
  unchanged?: number;
  firstSeen?: number;
  changedByLabel?: Record<string, number>;
  drift?: DriftItem[];
}

/** Stats response from the API */
export interface StatsResponse {
  queries: number;
  known: number;
  recallRate: number;
  learned: number;
  period: string;
}

/** Result of a recall */
export interface RecallResult {
  known: boolean;
  data?: LearnedData;
  // Note: No learnedAt
  fallback?: boolean; // True if circuit breaker triggered fallback
}

/** Response from a natural-language ask, answered from everything the account has learned */
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
 * Telemetry configuration — opt-in, pseudonymous diagnostics sent with your API key.
 * When enabled, each sub-flag defaults to true.
 */
export interface TelemetryConfig {
  /** Enable telemetry collection (default: false — opt-in) */
  enabled: boolean;

  /** Share performance metrics: timings, retries, status codes, content size (default: true) */
  sharePerformance?: boolean;

  /** Share proxy info: country, locally-derived type, success (never proxy URL/IP) (default: true) */
  shareProxyInfo?: boolean;

  /** Share block indicators derived from status codes and error categories (default: true) */
  shareSitePatterns?: boolean;
}

/**
 * Telemetry data collected from Crawlee context.
 * No raw URLs, bodies, proxy URLs/IPs or error messages. The hostname, generalized
 * path and request label are sent as-is, linked to your API key.
 */
export interface TelemetryData {
  // Request identification
  domain: string; // URL hostname, plain text, e.g. "shop.example.com"
  urlHash: string; // First 16 hex chars of an unsalted SHA-256 of the full URL (incl. query)
  urlPattern?: string; // e.g. "/product/*" — numeric/UUID/20+ char segments replaced; other segments as-is

  // Performance metrics
  responseTimeMs?: number; // ms from when the SDK starts handling the request (incl. recall) until the handler finishes or the request fails
  totalTimeMs?: number; // Same span as responseTimeMs
  statusCode?: number; // HTTP status
  contentSize?: number; // Response size in bytes
  retryCount?: number; // Number of retries for this request

  // Proxy information (no proxy URL or IP)
  proxyCountry?: string; // e.g., "US"
  proxyType?: string; // "datacenter" | "residential" | "mobile"
  proxySuccess?: boolean; // Did this proxy work?

  // Session state
  sessionAge?: number; // Crawlee session usage count (success entries only)
  sessionErrorScore?: number; // Crawlee session error score
  cookieCount?: number; // Not currently collected (never populated)

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
