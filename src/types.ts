/**
 * FetchBrain SDK Types
 * 
 * Type definitions for the FetchBrain AI-powered scraping optimization SDK.
 */

/** Intelligence level for AI inference accuracy */
export type IntelligenceLevel = 'realtime' | 'high' | 'standard' | 'deep';

/** AI memory depth levels - deeper memory may have minor hallucinations */
export enum AIMemoryDepth {
  REALTIME = 1,
  HIGH = 2,
  STANDARD = 3,
  DEEP = 4,
}

/** Configuration for FetchBrain SDK */
export interface FetchBrainConfig {
  /** API key for authentication */
  apiKey: string;
  
  /** Base URL for API (defaults to production) */
  baseUrl?: string;
  
  /** Intelligence level for AI responses */
  intelligence?: IntelligenceLevel;
  
  /** Whether AI should learn from new pages */
  learning?: boolean;
  
  /** 
   * Control which handlers run when AI knows the page.
   * - false: Auto-skip all handlers when AI knows (default)
   * - true: Always run all handlers
   * - string[]: Only run handlers with these labels (e.g., ['listing', 'category'])
   * - 'default': Only run the default handler
   * 
   * AI data always available via context.ai
   */
  alwaysRun?: boolean | string | string[];
  
  /** Custom data extractor for learning */
  extractForLearning?: (data: unknown) => Record<string, unknown>;
  
  /** 
   * If true, only return cached data from the same build version.
   * When a scraper updates, it will re-scrape instead of using stale data.
   * Uses APIFY_ACTOR_BUILD_ID environment variable.
   * Default: false
   */
  strictBuildMatch?: boolean;
  
  /** Request timeout in ms (default: 500ms for fast degradation) */
  timeout?: number;
  
  /** Enable debug logging */
  debug?: boolean;
  
  /**
   * Telemetry configuration - opt-in anonymous data sharing
   * Helps improve proxy recommendations, detect blocks, optimize configs
   * Default: disabled
   */
  telemetry?: TelemetryConfig;
}

/** Query request to the API */
export interface QueryRequest {
  urls: string[];
  actorId?: string;
  intelligence: IntelligenceLevel;
  /** If specified, only return data from this build version */
  build?: string;
}

/** Single query result */
export interface QueryResultItem {
  url: string;
  known: boolean;
  data?: Record<string, unknown>;
  confidence?: number;
  // Note: learnedAt is internal - API returns pure AI response
}

/** Query response from the API */
export interface QueryResponse {
  known: QueryResultItem[];
  unknown: string[];
}

/** Learn request to the API */
export interface LearnRequest {
  actorId?: string;
  entries: Array<{
    url: string;
    data: Record<string, unknown>;
  }>;
}

/** Learn response from the API */
export interface LearnResponse {
  status: 'accepted' | 'rejected' | 'flagged';
  learned: number;
  verification?: {
    schemaValid: boolean;
    valuesValid: boolean;
    duplicate: boolean;
    warnings: string[];
  };
}

/** Stats response from the API */
export interface StatsResponse {
  queries: number;
  recognized: number;
  recognitionRate: number;
  learned: number;
  period: string;
}

/** Result from AI knowledge query */
export interface AIResult {
  known: boolean;
  data?: Record<string, unknown>;
  confidence?: number;
  // Note: No learnedAt - API returns pure AI response
  fallback?: boolean;  // True if circuit breaker triggered fallback
}

/** Circuit breaker states */
export type CircuitState = 'closed' | 'open' | 'half-open';

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
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
  /** Enable telemetry collection (default: false) */
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
  domain: string;              // e.g., "walmart.com"
  urlHash: string;             // SHA256 of full URL
  urlPattern?: string;         // e.g., "/ip/*" (generalized path)
  
  // Performance metrics
  responseTimeMs?: number;     // Time to first byte
  totalTimeMs?: number;        // Total request time
  statusCode?: number;         // HTTP status
  contentSize?: number;        // Response size in bytes
  retryCount?: number;         // Number of retries for this request
  
  // Proxy information (anonymized)
  proxyCountry?: string;       // e.g., "US"
  proxyType?: string;          // "datacenter" | "residential" | "mobile"
  proxySuccess?: boolean;      // Did this proxy work?
  
  // Session state (aggregates only)
  sessionAge?: number;         // Requests in current session
  sessionErrorScore?: number;  // Error rate 0-1
  cookieCount?: number;        // Number of cookies (not values)
  
  // Blocking indicators
  blocked?: boolean;           // Request was blocked
  blockType?: string;          // "captcha" | "403" | "429" | "timeout"
  
  // Crawler metadata
  crawlerType?: string;        // "cheerio" | "playwright" | "puppeteer"
  requestLabel?: string;       // Developer-defined label
  
  // Timestamps
  timestamp: string;           // ISO timestamp
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
  status: 'success' | 'partial' | 'error';
}
