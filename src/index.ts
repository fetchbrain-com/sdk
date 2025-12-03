/**
 * FetchBrain SDK
 * 
 * AI-powered scraping optimization for Crawlee crawlers.
 * "The AI That Already Knows The Web"
 * 
 * @example
 * ```typescript
 * import { FetchBrain } from '@fetchbrain/sdk';
 * import { CheerioCrawler } from 'crawlee';
 * 
 * const crawler = FetchBrain.enhance(new CheerioCrawler({
 *   requestHandler: async ({ $, request }) => {
 *     // This only runs when AI needs to "learn" (new page)
 *     const data = { title: $('h1').text() };
 *     await Dataset.pushData(data);
 *   },
 * }), {
 *   apiKey: process.env.FETCHBRAIN_API_KEY,
 *   intelligence: 'high',  // High confidence AI responses
 *   learning: true,        // AI learns from scraped pages
 * });
 * 
 * await crawler.run(urls);
 * ```
 */

// Main exports
export { FetchBrain, createFetchBrain } from './enhance';
export { FetchBrainClient } from './client';

// Supporting modules
export { CircuitBreaker } from './circuit-breaker';
export { RequestBatcher } from './batch';
export { createLogger } from './logger';

// Types
export type {
  FetchBrainConfig,
  IntelligenceLevel,
  QueryRequest,
  QueryResponse,
  QueryResultItem,
  LearnRequest,
  LearnResponse,
  StatsResponse,
  AIResult,
  CircuitState,
  CircuitBreakerConfig,
  BatchConfig,
  Logger,
  LogLevel,
} from './types';

// Enums
export { AIMemoryDepth } from './types';
