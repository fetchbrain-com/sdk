/**
 * FetchBrain SDK
 *
 * AI-powered scraping optimization for Crawlee crawlers.
 * "The AI That Already Knows The Web"
 *
 * @example
 * ```typescript
 * import { FetchBrain } from '@fetchbrain.com/sdk';
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
 *   memory: 'recent',      // How far back the brain recalls
 *   learning: true,        // AI learns from scraped pages
 * });
 *
 * await crawler.run(urls);
 * ```
 */

// Main exports
export {
  FetchBrain,
  createFetchBrain,
  pushData,
  getCurrentContext,
} from "./enhance";
export type { FetchBrainContext } from "./enhance";
export { FetchBrainClient } from "./client";

// Supporting modules
export { CircuitBreaker } from "./circuit-breaker";
export { RequestBatcher } from "./batch";
export { createLogger } from "./logger";

// Telemetry
export { collectTelemetry, TelemetryBuffer } from "./telemetry";
export type { CrawleeContext, RequestTiming } from "./telemetry";

// Types
export type {
  FetchBrainConfig,
  MemoryDepth,
  RawRequest,
  RecallRequest,
  RecallResponse,
  RecallResultItem,
  LearnRequest,
  LearnResponse,
  StatsResponse,
  RecallResult,
  RecalledEvent,
  AskResponse,
  CircuitState,
  CircuitBreakerConfig,
  BatchConfig,
  Logger,
  LogLevel,
  // Telemetry types
  TelemetryConfig,
  TelemetryData,
  TelemetryRequest,
  TelemetryResponse,
} from "./types";
