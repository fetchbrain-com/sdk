import type { BatchConfig, AIResult, Logger } from './types';

const DEFAULT_CONFIG: BatchConfig = {
  maxSize: 50,
  maxWait: 50, // 50ms
};

interface PendingRequest {
  url: string;
  resolve: (result: AIResult) => void;
  reject: (error: Error) => void;
}

type BatchExecutor = (urls: string[]) => Promise<Map<string, AIResult>>;

/**
 * Request Batcher
 * 
 * Batches individual URL queries into bulk API calls to reduce connections.
 * Important for high-concurrency scrapers (50-100+ concurrent requests).
 */
export class RequestBatcher {
  private queue: PendingRequest[] = [];
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;
  private config: BatchConfig;
  private executor: BatchExecutor;
  private logger: Logger;

  constructor(
    executor: BatchExecutor,
    config: Partial<BatchConfig> = {},
    logger: Logger
  ) {
    this.executor = executor;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * Add a URL to the batch queue
   */
  async query(url: string): Promise<AIResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ url, resolve, reject });

      // Flush immediately if batch is full
      if (this.queue.length >= this.config.maxSize) {
        this.flush();
        return;
      }

      // Schedule flush if not already scheduled
      if (!this.flushTimeout) {
        this.flushTimeout = setTimeout(() => {
          this.flush();
        }, this.config.maxWait);
      }
    });
  }

  /**
   * Flush the current batch
   */
  private async flush(): Promise<void> {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    if (this.queue.length === 0) {
      return;
    }

    // Take current queue and reset
    const batch = this.queue.splice(0, this.config.maxSize);
    const urls = batch.map((r) => r.url);

    this.logger.debug(`Flushing batch of ${urls.length} URLs`);

    try {
      const results = await this.executor(urls);

      // Resolve all pending requests
      for (const request of batch) {
        const result = results.get(request.url);
        if (result) {
          request.resolve(result);
        } else {
          // URL not in results = unknown
          request.resolve({ known: false });
        }
      }
    } catch (error) {
      // Reject all pending requests
      for (const request of batch) {
        request.reject(error as Error);
      }
    }

    // If there are more items in queue, schedule another flush
    if (this.queue.length > 0) {
      this.flushTimeout = setTimeout(() => {
        this.flush();
      }, this.config.maxWait);
    }
  }

  /**
   * Get current queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Clear the queue (for cleanup)
   */
  clear(): void {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    
    // Resolve all pending with fallback
    for (const request of this.queue) {
      request.resolve({ known: false, fallback: true });
    }
    this.queue = [];
  }
}
