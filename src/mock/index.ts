/**
 * Mock FetchBrain for unit testing
 * 
 * Use this to create a mock client that doesn't make real API calls.
 */

import type { 
  AIResult, 
  LearnResponse, 
  StatsResponse,
  FetchBrainConfig,
} from '../types';

export interface MockFetchBrainOptions {
  /** Pre-trained AI knowledge */
  initialKnowledge?: Map<string, Record<string, unknown>>;
  /** Simulate API failures */
  simulateFailures?: boolean;
  /** Failure rate (0-1) */
  failureRate?: number;
  /** Simulated latency in ms */
  latency?: number;
}

/**
 * Mock FetchBrain client for testing
 */
export class MockFetchBrain {
  private knowledge: Map<string, { data: Record<string, unknown>; learnedAt: string }>;
  private options: MockFetchBrainOptions;
  private _stats = { queries: 0, recognized: 0, learned: 0 };

  constructor(options: MockFetchBrainOptions = {}) {
    this.knowledge = new Map();
    this.options = {
      simulateFailures: false,
      failureRate: 0,
      latency: 0,
      ...options,
    };

    // Initialize with provided knowledge
    if (options.initialKnowledge) {
      for (const [url, data] of options.initialKnowledge) {
        this.knowledge.set(url, { data, learnedAt: new Date().toISOString() });
      }
    }
  }

  private async simulateLatency(): Promise<void> {
    if (this.options.latency && this.options.latency > 0) {
      await new Promise(resolve => setTimeout(resolve, this.options.latency));
    }
  }

  private shouldFail(): boolean {
    if (!this.options.simulateFailures) return false;
    return Math.random() < (this.options.failureRate || 0.1);
  }

  async query(url: string): Promise<AIResult> {
    await this.simulateLatency();
    
    if (this.shouldFail()) {
      throw new Error('Simulated API failure');
    }

    this._stats.queries++;
    const known = this.knowledge.get(url);

    if (known) {
      this._stats.recognized++;
      return {
        known: true,
        data: known.data,
        confidence: 0.97,
        learnedAt: known.learnedAt,
      };
    }

    return { known: false };
  }

  async queryBulk(urls: string[]): Promise<Map<string, AIResult>> {
    const results = new Map<string, AIResult>();
    
    for (const url of urls) {
      results.set(url, await this.query(url));
    }
    
    return results;
  }

  async learn(url: string, data: Record<string, unknown>): Promise<LearnResponse> {
    await this.simulateLatency();
    
    if (this.shouldFail()) {
      throw new Error('Simulated API failure');
    }

    this.knowledge.set(url, { data, learnedAt: new Date().toISOString() });
    this._stats.learned++;

    return {
      status: 'accepted',
      learned: 1,
      verification: {
        schemaValid: true,
        valuesValid: true,
        duplicate: false,
        warnings: [],
      },
    };
  }

  async stats(): Promise<StatsResponse> {
    return {
      queries: this._stats.queries,
      recognized: this._stats.recognized,
      recognitionRate: this._stats.queries > 0 ? this._stats.recognized / this._stats.queries : 0,
      learned: this._stats.learned,
      period: new Date().toISOString().slice(0, 7),
    };
  }

  /**
   * Seed the AI with test data
   */
  seed(entries: Array<{ url: string; data: Record<string, unknown> }>): void {
    for (const entry of entries) {
      this.knowledge.set(entry.url, { 
        data: entry.data, 
        learnedAt: new Date().toISOString() 
      });
    }
  }

  /**
   * Clear all AI knowledge
   */
  clear(): void {
    this.knowledge.clear();
    this._stats = { queries: 0, recognized: 0, learned: 0 };
  }

  /**
   * Get current knowledge base size
   */
  getKnowledgeSize(): number {
    return this.knowledge.size;
  }

  /**
   * Check if AI knows a URL
   */
  has(url: string): boolean {
    return this.knowledge.has(url);
  }
}

/**
 * Create a mock configuration for testing
 */
export function createMockConfig(overrides: Partial<FetchBrainConfig> = {}): FetchBrainConfig {
  return {
    apiKey: 'test_mock_key',
    baseUrl: 'http://localhost:3456',
    intelligence: 'high',
    learning: true,
    timeout: 5000,
    debug: false,
    ...overrides,
  };
}
