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
  status: "ok" | "unavailable";
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
