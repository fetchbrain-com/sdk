import type { BatchConfig, LearnedData, RecallResult, Logger, LearnResponse, RawRequest } from "./types";

/**
 * Learns are sent in the background, so nothing ties their rate to the crawl's
 * own concurrency. These caps keep a slow API from piling up open requests
 * (each up to 50 entries x 100KB) and unbounded memory in the scraper.
 */
export const MAX_CONCURRENT_LEARN_FLUSHES = 3;
export const MAX_QUEUED_LEARNS = 500;

const DEFAULT_CONFIG: BatchConfig = {
  maxSize: 50,
  maxWait: 50, // 50ms
};

interface PendingRequest {
  ref: string;
  request: RawRequest;
  resolve: (result: RecallResult) => void;
  reject: (error: Error) => void;
}

type BatchExecutor = (items: { ref: string; request: RawRequest }[]) => Promise<Map<string, RecallResult>>;

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
  private refSeq = 0;

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
   * Add a request to the batch queue
   */
  async query(request: RawRequest): Promise<RecallResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ ref: String(this.refSeq++), request, resolve, reject });

      // Flush immediately if batch is full
      if (this.queue.length >= this.config.maxSize) {
        this.flush();
        return;
      }

      // Schedule flush if not already scheduled
      if (!this.flushTimeout) {
        this.flushTimeout = setTimeout(() => this.flush(), this.config.maxWait);
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
    const items = batch.map((r) => ({ ref: r.ref, request: r.request }));

    this.logger.debug(`Flushing batch of ${items.length} requests`);

    try {
      const results = await this.executor(items);

      // Resolve all pending requests, fallback to {known:false} if ref missing
      for (const r of batch) {
        r.resolve(results.get(r.ref) ?? { known: false });
      }
    } catch (error) {
      // Reject all pending requests
      for (const r of batch) {
        r.reject(error as Error);
      }
    }

    // If there are more items in queue, schedule another flush
    if (this.queue.length > 0) {
      this.flushTimeout = setTimeout(() => this.flush(), this.config.maxWait);
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
    for (const r of this.queue) {
      r.resolve({ known: false, fallback: true });
    }
    this.queue = [];
  }
}

// =============================================================================
// LEARN BATCHER
// =============================================================================

interface LearnEntry {
  request: RawRequest;
  data: LearnedData;
}

interface PendingLearnRequest {
  entry: LearnEntry;
  resolve: (result: LearnResponse) => void;
  reject: (error: Error) => void;
}

type LearnBatchExecutor = (entries: { request: RawRequest; data: LearnedData }[]) => Promise<LearnResponse>;

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
  /** Flushes whose API call has not settled yet (awaited by forceFlush). */
  private inFlight = new Set<Promise<void>>();
  /** Callers of waitForRoom(), woken whenever a flush settles. */
  private roomWaiters: (() => void)[] = [];

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
    request: RawRequest,
    data: LearnedData,
  ): Promise<LearnResponse> {
    // Bounded backlog: past the cap the entry is dropped (not learned) rather
    // than held in memory without limit. Callers that can wait use waitForRoom().
    if (this.queue.length >= MAX_QUEUED_LEARNS) {
      this.logger.debug("Learn backlog full; not learning this entry");
      return { status: "rejected", learned: 0, errors: ["backlog_full"] };
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ entry: { request, data }, resolve, reject });

      // Flush immediately if batch is full
      if (this.queue.length >= this.config.maxSize) {
        this.flush();
        return;
      }

      // Schedule flush if not already scheduled
      if (!this.flushTimeout) {
        this.flushTimeout = setTimeout(() => this.flush(), this.config.maxWait);
      }
    });
  }

  /** True when another learn() would be dropped for lack of backlog room. */
  isBacklogFull(): boolean {
    return this.queue.length >= MAX_QUEUED_LEARNS;
  }

  /**
   * Wait until the backlog has room, at most `timeoutMs`. Resolves true when
   * there is room. Bounded so a slow API slows the crawl but never stalls it.
   */
  async waitForRoom(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.isBacklogFull()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, remaining);
        function done() {
          clearTimeout(timer);
          resolve();
        }
        this.roomWaiters.push(done);
      });
    }
    return true;
  }

  /**
   * Start sending the next batch, unless MAX_CONCURRENT_LEARN_FLUSHES are
   * already in flight — a settling flush starts the next one.
   */
  private flush(): void {
    if (this.inFlight.size >= MAX_CONCURRENT_LEARN_FLUSHES) {
      if (this.flushTimeout) {
        clearTimeout(this.flushTimeout);
        this.flushTimeout = null;
      }
      return;
    }
    const run = this.flushOnce();
    this.inFlight.add(run);
    void run.finally(() => {
      this.inFlight.delete(run);
      const waiters = this.roomWaiters.splice(0);
      for (const wake of waiters) wake();
      if (this.queue.length >= this.config.maxSize) {
        this.flush();
      } else if (this.queue.length > 0 && !this.flushTimeout) {
        this.flushTimeout = setTimeout(() => this.flush(), this.config.maxWait);
      }
    });
  }

  private async flushOnce(): Promise<void> {
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
      for (const r of batch) {
        r.resolve(result);
      }
    } catch (error) {
      // Reject all pending requests
      for (const r of batch) {
        r.reject(error as Error);
      }
    }
    // The next batch is started by flush()'s settle handler (concurrency-capped).
  }

  /**
   * Force flush and wait for completion (for cleanup/shutdown)
   */
  async forceFlush(): Promise<void> {
    // Drain everything queued (possibly several batches) AND wait for flushes
    // started earlier — otherwise learns still in flight are lost at shutdown.
    while (this.queue.length > 0 || this.inFlight.size > 0) {
      if (this.queue.length > 0) this.flush();
      await Promise.allSettled([...this.inFlight]);
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
    for (const r of this.queue) {
      r.resolve({ status: "rejected", learned: 0 });
    }
    this.queue = [];
  }
}
