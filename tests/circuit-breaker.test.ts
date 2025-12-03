import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker } from '../src/circuit-breaker';
import { createLogger } from '../src/logger';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;
  const logger = createLogger('error', false); // Silent logger for tests

  beforeEach(() => {
    circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeout: 1000,
      successThreshold: 1,
    }, logger);
  });

  describe('initial state', () => {
    it('should start in closed state', () => {
      expect(circuitBreaker.getState()).toBe('closed');
      expect(circuitBreaker.isOpen()).toBe(false);
    });
  });

  describe('failure handling', () => {
    it('should remain closed after fewer failures than threshold', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      
      expect(circuitBreaker.getState()).toBe('closed');
      expect(circuitBreaker.isOpen()).toBe(false);
    });

    it('should open after reaching failure threshold', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      
      expect(circuitBreaker.getState()).toBe('open');
      expect(circuitBreaker.isOpen()).toBe(true);
    });

    it('should reset failure count on success', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordSuccess();
      circuitBreaker.recordFailure();
      
      // Should need 3 more failures, not 1
      expect(circuitBreaker.getState()).toBe('closed');
    });
  });

  describe('recovery', () => {
    it('should transition to half-open after reset timeout', async () => {
      // Open the circuit
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getState()).toBe('open');
      
      // Wait for reset timeout
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      // Check should trigger half-open transition
      expect(circuitBreaker.isOpen()).toBe(false);
      expect(circuitBreaker.getState()).toBe('half-open');
    });

    it('should close after success in half-open state', async () => {
      // Open the circuit
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      
      // Wait for reset timeout
      await new Promise(resolve => setTimeout(resolve, 1100));
      circuitBreaker.isOpen(); // Triggers half-open
      
      // Success in half-open should close
      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getState()).toBe('closed');
    });

    it('should reopen on failure in half-open state', async () => {
      // Open the circuit
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      
      // Wait for reset timeout
      await new Promise(resolve => setTimeout(resolve, 1100));
      circuitBreaker.isOpen(); // Triggers half-open
      
      // Failure in half-open should reopen
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getState()).toBe('open');
    });
  });

  describe('reset', () => {
    it('should fully reset circuit breaker', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getState()).toBe('open');
      
      circuitBreaker.reset();
      
      expect(circuitBreaker.getState()).toBe('closed');
      expect(circuitBreaker.getStats().failures).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return current statistics', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordSuccess();
      
      const stats = circuitBreaker.getStats();
      expect(stats.state).toBe('closed');
      expect(stats.failures).toBe(0); // Reset on success
      expect(stats.successes).toBe(0); // Only tracked in half-open
    });
  });
});
