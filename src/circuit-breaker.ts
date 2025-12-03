import type { CircuitBreakerConfig, CircuitState, Logger } from './types';

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeout: 30000, // 30 seconds
  successThreshold: 1,
};

/**
 * Circuit Breaker Pattern Implementation
 * 
 * Protects scrapers from API failures:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: API failing, skip all requests (scraper continues normally)
 * - HALF-OPEN: Testing if API recovered
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private lastFailureTime = 0;
  private config: CircuitBreakerConfig;
  private logger: Logger;

  constructor(config: Partial<CircuitBreakerConfig> = {}, logger: Logger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * Check if requests should be allowed through
   */
  isOpen(): boolean {
    if (this.state === 'closed') {
      return false;
    }

    if (this.state === 'open') {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.config.resetTimeout) {
        this.logger.info('Circuit transitioning to half-open, testing API...');
        this.state = 'half-open';
        this.successes = 0;
        return false;
      }
      return true;
    }

    // half-open: allow requests through for testing
    return false;
  }

  /**
   * Record a successful API call
   */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.config.successThreshold) {
        this.logger.info('API recovered, circuit closed');
        this.reset();
      }
    } else if (this.state === 'closed') {
      // Reset failure count on success in closed state
      this.failures = 0;
    }
  }

  /**
   * Record a failed API call
   */
  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.logger.warn('API still failing, circuit reopened');
      this.state = 'open';
      return;
    }

    if (this.failures >= this.config.failureThreshold) {
      this.logger.warn(
        `Circuit opened after ${this.failures} failures. ` +
        'Scraper will continue without optimization.'
      );
      this.state = 'open';
    }
  }

  /**
   * Reset the circuit breaker to closed state
   */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = 0;
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get statistics about the circuit breaker
   */
  getStats(): { state: CircuitState; failures: number; successes: number } {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
    };
  }
}
