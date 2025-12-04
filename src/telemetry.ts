/**
 * Telemetry Collection Module
 * 
 * Collects anonymized performance and behavior data from Crawlee contexts.
 * All data is sanitized - no PII, credentials, or raw content is ever collected.
 */

import type { TelemetryData, TelemetryConfig } from './types';

// Simple hash function for URLs (browser-compatible)
async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * Generalize URL path to a pattern (remove IDs, keep structure)
 * Example: /product/12345/details becomes /product/star/details
 */
function generalizeUrlPath(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    
    // Replace numeric IDs with *
    // Replace UUIDs with *
    // Replace long alphanumeric strings with *
    return path
      .replace(/\/\d+/g, '/*')                          // /123 -> /*
      .replace(/\/[a-f0-9-]{36}/gi, '/*')              // UUIDs
      .replace(/\/[a-zA-Z0-9]{20,}/g, '/*')            // Long IDs
      .replace(/\?.*$/, '');                            // Remove query string
  } catch {
    return '/*';
  }
}

/**
 * Detect if request was blocked and what type
 */
function detectBlockType(statusCode?: number, errorMessage?: string): string | undefined {
  if (!statusCode && !errorMessage) return undefined;
  
  if (statusCode === 403) return '403';
  if (statusCode === 429) return '429';
  if (statusCode === 503) return '503';
  if (statusCode && statusCode >= 400) return `${statusCode}`;
  
  const msg = errorMessage?.toLowerCase() || '';
  if (msg.includes('captcha')) return 'captcha';
  if (msg.includes('timeout')) return 'timeout';
  if (msg.includes('blocked')) return 'blocked';
  if (msg.includes('rate limit')) return '429';
  
  return undefined;
}

/**
 * Extract proxy type from proxy URL or info
 */
function extractProxyType(proxyUrl?: string): string | undefined {
  if (!proxyUrl) return undefined;
  
  const url = proxyUrl.toLowerCase();
  if (url.includes('residential')) return 'residential';
  if (url.includes('mobile')) return 'mobile';
  if (url.includes('datacenter') || url.includes('dc')) return 'datacenter';
  
  // Default based on common patterns
  if (url.includes('bright') || url.includes('oxylabs') || url.includes('smartproxy')) {
    return 'residential'; // Common residential providers
  }
  
  return 'datacenter';
}

/**
 * Crawlee-like context interface (subset of what we need)
 * This allows the telemetry to work with any Crawlee crawler type
 */
export interface CrawleeContext {
  request: {
    url: string;
    retryCount?: number;
    label?: string;
    userData?: Record<string, unknown>;
  };
  response?: {
    status?: number;
    statusCode?: number;
    headers?: Record<string, string> | Headers;
  };
  proxyInfo?: {
    url?: string;
    hostname?: string;
    countryCode?: string;
  };
  session?: {
    errorScore?: number;
    usageCount?: number;
  };
  crawler?: {
    constructor?: { name?: string };
  };
}

/**
 * Additional timing info that can be passed separately
 */
export interface RequestTiming {
  startTime?: number;
  endTime?: number;
  responseTime?: number;
  contentSize?: number;
}

/**
 * Collect telemetry from a Crawlee context
 * Returns sanitized data safe for transmission
 */
export async function collectTelemetry(
  context: CrawleeContext,
  timing?: RequestTiming,
  config?: TelemetryConfig,
  error?: Error
): Promise<TelemetryData | null> {
  // If telemetry disabled, return null
  if (!config?.enabled) {
    return null;
  }
  
  const url = context.request.url;
  const statusCode = context.response?.status || context.response?.statusCode;
  
  // Base telemetry - always collected when enabled
  const telemetry: TelemetryData = {
    domain: extractDomain(url),
    urlHash: await hashString(url),
    urlPattern: generalizeUrlPath(url),
    timestamp: new Date().toISOString(),
  };
  
  // Performance metrics (opt-in)
  if (config.sharePerformance !== false) {
    telemetry.statusCode = statusCode;
    telemetry.retryCount = context.request.retryCount;
    
    if (timing) {
      telemetry.responseTimeMs = timing.responseTime;
      telemetry.totalTimeMs = timing.endTime && timing.startTime 
        ? timing.endTime - timing.startTime 
        : undefined;
      telemetry.contentSize = timing.contentSize;
    }
  }
  
  // Proxy info (opt-in, anonymized)
  if (config.shareProxyInfo !== false && context.proxyInfo) {
    telemetry.proxyCountry = context.proxyInfo.countryCode;
    telemetry.proxyType = extractProxyType(context.proxyInfo.url);
    telemetry.proxySuccess = statusCode ? statusCode < 400 : undefined;
  }
  
  // Site patterns / blocking (opt-in)
  if (config.shareSitePatterns !== false) {
    const isBlocked = statusCode && (statusCode === 403 || statusCode === 429 || statusCode >= 500);
    telemetry.blocked = isBlocked || !!error;
    telemetry.blockType = detectBlockType(statusCode, error?.message);
  }
  
  // Session info (always anonymized)
  if (context.session) {
    telemetry.sessionAge = context.session.usageCount;
    telemetry.sessionErrorScore = context.session.errorScore;
  }
  
  // Crawler metadata
  telemetry.crawlerType = context.crawler?.constructor?.name?.replace('Crawler', '').toLowerCase();
  telemetry.requestLabel = context.request.label;
  
  return telemetry;
}

/**
 * Telemetry buffer for batching before send
 */
export class TelemetryBuffer {
  private buffer: TelemetryData[] = [];
  private readonly maxSize: number;
  private readonly flushInterval: number;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushCallback?: (entries: TelemetryData[]) => Promise<void>;
  
  constructor(
    options: {
      maxSize?: number;
      flushInterval?: number;
      onFlush?: (entries: TelemetryData[]) => Promise<void>;
    } = {}
  ) {
    this.maxSize = options.maxSize ?? 50;
    this.flushInterval = options.flushInterval ?? 30000; // 30 seconds
    this.flushCallback = options.onFlush;
    
    this.startFlushTimer();
  }
  
  /**
   * Add telemetry entry to buffer
   */
  add(entry: TelemetryData | null): void {
    if (!entry) return;
    
    this.buffer.push(entry);
    
    if (this.buffer.length >= this.maxSize) {
      this.flush();
    }
  }
  
  /**
   * Flush buffer and send telemetry
   */
  async flush(): Promise<TelemetryData[]> {
    if (this.buffer.length === 0) return [];
    
    const entries = [...this.buffer];
    this.buffer = [];
    
    if (this.flushCallback) {
      try {
        await this.flushCallback(entries);
      } catch (err) {
        // Telemetry failures should be silent
        console.debug('Telemetry flush failed:', err);
      }
    }
    
    return entries;
  }
  
  /**
   * Get current buffer size
   */
  get size(): number {
    return this.buffer.length;
  }
  
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.flushInterval);
  }
  
  /**
   * Stop the flush timer and flush remaining entries
   */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    await this.flush();
  }
}
