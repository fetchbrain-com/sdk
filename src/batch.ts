import type { BatchConfig, AIResult, Logger, LearnResponse } from "./types";

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
    logger: Logger,
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

// =============================================================================
// LEARN BATCHER
// =============================================================================

interface LearnEntry {
  url: string;
  data: Record<string, unknown>;
}

interface PendingLearnRequest {
  entry: LearnEntry;
  resolve: (result: LearnResponse) => void;
  reject: (error: Error) => void;
}

type LearnBatchExecutor = (entries: LearnEntry[]) => Promise<LearnResponse>;

/**
 * Learn Request Batcher
 *
 * Batches individual learn calls into bulk API calls to reduce connections.
 * Critical for high-concurrency scrapers that push data frequently.
 */
export class LearnBatcher {
  private queue: PendingLearnRequest[] = [];
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;
  private config: BatchConfig;
  private executor: LearnBatchExecutor;
  private logger: Logger;

  constructor(
    executor: LearnBatchExecutor,
    config: Partial<BatchConfig> = {},
    logger: Logger,
  ) {
    this.executor = executor;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * Add a learn entry to the batch queue
   */
  async learn(
    url: string,
    data: Record<string, unknown>,
  ): Promise<LearnResponse> {
    return new Promise((resolve, reject) => {
      this.queue.push({ entry: { url, data }, resolve, reject });

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
    const entries = batch.map((r) => r.entry);

    this.logger.debug(`Flushing learn batch of ${entries.length} entries`);

    try {
      const result = await this.executor(entries);

      // Resolve all pending requests with the batch result
      for (const request of batch) {
        request.resolve(result);
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
   * Force flush and wait for completion (for cleanup/shutdown)
   */
  async forceFlush(): Promise<void> {
    if (this.queue.length > 0) {
      await this.flush();
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

    // Resolve all pending with rejected status
    for (const request of this.queue) {
      request.resolve({ status: "rejected", learned: 0 });
    }
    this.queue = [];
  }
}
