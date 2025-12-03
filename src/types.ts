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
  
  /** Request timeout in ms (default: 500ms for fast degradation) */
  timeout?: number;
  
  /** Enable debug logging */
  debug?: boolean;
}

/** Query request to the API */
export interface QueryRequest {
  urls: string[];
  actorId?: string;
  intelligence: IntelligenceLevel;
}

/** Single query result */
export interface QueryResultItem {
  url: string;
  known: boolean;
  data?: Record<string, unknown>;
  confidence?: number;
  learnedAt?: string;
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
  learnedAt?: string;
  fallback?: boolean;
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
