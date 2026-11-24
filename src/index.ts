/**
 * FetchBrain SDK
 *
 * Memory for your scrapers — recall before you fetch, teach what you learn.
 *
 * @example
 * ```typescript
 * import { FetchBrain } from '@fetchbrain.com/sdk';
 * import { CheerioCrawler } from 'crawlee';
 *
 * const crawler = FetchBrain.enhance(new CheerioCrawler({
 *   requestHandler: async ({ $, pushData }) => {
 *     // Runs only when the brain doesn't know this request yet
 *     const data = { title: $('h1').text() };
 *     await pushData(data); // context.pushData — the brain learns from it
 *   },
 * }), {
 *   apiKey: process.env.FETCHBRAIN_API_KEY,
 *   memory: 'recent',      // How far back the brain recalls
 *   learning: true,        // Teach the brain from scraped data
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
  // Change detection types
  ChangeDetectionConfig,
  ChangeStats,
  DriftItem,
  RunFlag,
  RunReport,
  // Telemetry types
  TelemetryConfig,
  TelemetryData,
  TelemetryRequest,
  TelemetryResponse,
} from "./types";
