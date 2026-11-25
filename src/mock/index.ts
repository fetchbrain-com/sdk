/**
 * Mock FetchBrain for unit testing
 *
 * Use this to create a mock client that doesn't make real API calls.
 */

import type {
  RecallResult,
  LearnResponse,
  StatsResponse,
  AskResponse,
  FetchBrainConfig,
  RawRequest,
} from "../types";
import { deriveIdentity } from "./derive-identity";

export interface MockFetchBrainOptions {
  /** Seed memory: Map<url, data> the mock already knows at construction */
  initialMemory?: Map<string, Record<string, unknown>>;
  /** @deprecated Use `initialMemory`. Still honored; on a URL in both, `initialMemory` wins. */
  initialKnowledge?: Map<string, Record<string, unknown>>;
  /** Simulate API failures */
  simulateFailures?: boolean;
  /** Failure rate (0-1) */
  failureRate?: number;
  /** Simulated latency in ms */
  latency?: number;
  /**
   * Simulate the monthly fair-use learn cap: once this many entries are
   * learned, further learns are rejected (like the real client after a
   * LEARN_CAP_EXCEEDED response) while recall keeps working.
   */
  learnCap?: number;
}

/**
 * Mock FetchBrain client for testing — an in-memory brain, no network
 */
export class MockFetchBrain {
  private memory: Map<
    string,
    { url: string; data: Record<string, unknown>; learnedAt: string }
  >;
  private options: MockFetchBrainOptions;
  private _stats = { queries: 0, known: 0, learned: 0 };

  constructor(options: MockFetchBrainOptions = {}) {
    this.memory = new Map();
    this.options = {
      simulateFailures: false,
      failureRate: 0,
      latency: 0,
      ...options,
    };

    // Seed memory (Map<url, data>). The deprecated initialKnowledge alias still works;
    // it is applied first so initialMemory wins on a URL present in both.
    for (const seed of [options.initialKnowledge, options.initialMemory]) {
      if (!seed) continue;
      for (const [url, data] of seed) {
        this.memory.set(deriveIdentity({ url }), {
          url,
          data,
          learnedAt: new Date().toISOString(),
        });
      }
    }
  }

  private async simulateLatency(): Promise<void> {
    if (this.options.latency && this.options.latency > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.latency));
    }
  }

  private shouldFail(): boolean {
    if (!this.options.simulateFailures) return false;
    return Math.random() < (this.options.failureRate || 0.1);
  }

  async recall(request: RawRequest): Promise<RecallResult> {
    await this.simulateLatency();

    if (this.shouldFail()) {
      throw new Error("Simulated API failure");
    }

    this._stats.queries++;
    const known = this.memory.get(deriveIdentity(request));

    if (known) {
      this._stats.known++;
      return {
        known: true,
        data: known.data,
      };
    }

    return { known: false };
  }

  async recallBulk(requests: RawRequest[]): Promise<RecallResult[]> {
    return Promise.all(requests.map((r) => this.recall(r)));
  }

  async learn(
    request: RawRequest,
    data: Record<string, unknown>,
  ): Promise<LearnResponse> {
    await this.simulateLatency();

    if (this.shouldFail()) {
      throw new Error("Simulated API failure");
    }

    if (this.options.learnCap !== undefined && this._stats.learned >= this.options.learnCap) {
      return { learned: 0, status: "rejected" };
    }

    this.memory.set(deriveIdentity(request), {
      url: request.url,
      data,
      learnedAt: new Date().toISOString(),
    });
    this._stats.learned++;

    return {
      learned: 1,
      status: "success",
    };
  }

  async stats(): Promise<StatsResponse> {
    return {
      queries: this._stats.queries,
      known: this._stats.known,
      recallRate:
        this._stats.queries > 0
          ? this._stats.known / this._stats.queries
          : 0,
      learned: this._stats.learned,
      period: new Date().toISOString().slice(0, 7),
    };
  }

  /**
   * Naive ask(): substring-match the query's words against seeded data.
   * When `opts.answer` is truthy, also returns a canned `answer` string
   * built from the top source — it is NOT a real synthesized answer, just
   * enough of the shape for callers to test against.
   */
  async ask(
    query: string,
    opts?: { answer?: boolean; limit?: number; model?: string; timeout?: number },
  ): Promise<AskResponse> {
    const cap = Math.min(Math.max(1, opts?.limit ?? 10), 20);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const sources = [...this.memory.values()]
      .map((entry) => {
        const haystack = JSON.stringify(entry.data).toLowerCase();
        const score =
          words.filter((w) => haystack.includes(w)).length /
          Math.max(words.length, 1);
        return { score, url: entry.url, data: entry.data };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, cap);

    if (!opts?.answer) {
      return { sources, status: "ok" };
    }

    const answer =
      sources.length > 0
        ? `Based on ${sources.length} remembered page${sources.length === 1 ? "" : "s"}: ${JSON.stringify(sources[0].data)}`
        : "Nothing remembered yet for that question.";

    // Echo the requested model slug like the real API reports what it used.
    return {
      sources,
      status: "ok",
      answer,
      model: opts?.model ?? "llama-3.3-70b",
    };
  }

  /**
   * Seed the brain with test data (url-keyed convenience API).
   * Accepts a single (url, data) pair or an array of entries.
   */
  seed(url: string, data: Record<string, unknown>): void;
  seed(entries: Array<{ url: string; data: Record<string, unknown> }>): void;
  seed(
    urlOrEntries: string | Array<{ url: string; data: Record<string, unknown> }>,
    data?: Record<string, unknown>,
  ): void {
    const entries =
      typeof urlOrEntries === "string"
        ? [{ url: urlOrEntries, data: data ?? {} }]
        : urlOrEntries;
    for (const entry of entries) {
      this.memory.set(deriveIdentity({ url: entry.url }), {
        url: entry.url,
        data: entry.data,
        learnedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Clear all remembered data
   */
  clear(): void {
    this.memory.clear();
    this._stats = { queries: 0, known: 0, learned: 0 };
  }

  /**
   * Number of entries currently in the mock's memory
   */
  getMemorySize(): number {
    return this.memory.size;
  }

  /**
   * @deprecated Use `getMemorySize()`.
   */
  getKnowledgeSize(): number {
    return this.getMemorySize();
  }

  /**
   * Check if the brain knows a URL (keys by deriveIdentity({ url }))
   */
  has(url: string): boolean {
    return this.memory.has(deriveIdentity({ url }));
  }
}

/**
 * Create a mock configuration for testing
 */
export function createMockConfig(
  overrides: Partial<FetchBrainConfig> = {}
): FetchBrainConfig {
  return {
    apiKey: "test_mock_key",
    baseUrl: "http://localhost:3456",
    memory: "recent",
    learning: true,
    timeout: 5000,
    debug: false,
    ...overrides,
  };
}
