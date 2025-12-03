import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestBatcher } from '../src/batch';
import { createLogger } from '../src/logger';
import type { AIResult } from '../src/types';

describe('RequestBatcher', () => {
  const logger = createLogger('error', false);
  
  const createMockExecutor = () => {
    return vi.fn(async (urls: string[]): Promise<Map<string, AIResult>> => {
      const results = new Map<string, AIResult>();
      for (const url of urls) {
        if (url.includes('known')) {
          results.set(url, { known: true, data: { title: 'Known Product' }, confidence: 0.95 });
        } else {
          results.set(url, { known: false });
        }
      }
      return results;
    });
  };

  describe('batching behavior', () => {
    it('should batch requests within wait time', async () => {
      const executor = createMockExecutor();
      const batcher = new RequestBatcher(executor, { maxSize: 50, maxWait: 50 }, logger);
      
      // Fire multiple requests simultaneously
      const promises = [
        batcher.query('https://example.com/1'),
        batcher.query('https://example.com/2'),
        batcher.query('https://example.com/3'),
      ];
      
      const results = await Promise.all(promises);
      
      // Should have been batched into single call
      expect(executor).toHaveBeenCalledTimes(1);
      expect(executor).toHaveBeenCalledWith([
        'https://example.com/1',
        'https://example.com/2',
        'https://example.com/3',
      ]);
      
      expect(results).toHaveLength(3);
    });

    it('should flush immediately when batch is full', async () => {
      const executor = createMockExecutor();
      const batcher = new RequestBatcher(executor, { maxSize: 2, maxWait: 5000 }, logger);
      
      const promises = [
        batcher.query('https://example.com/1'),
        batcher.query('https://example.com/2'),
      ];
      
      await Promise.all(promises);
      
      // Should flush immediately due to maxSize
      expect(executor).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple batches', async () => {
      const executor = createMockExecutor();
      const batcher = new RequestBatcher(executor, { maxSize: 2, maxWait: 10 }, logger);
      
      // First batch
      const batch1 = Promise.all([
        batcher.query('https://example.com/1'),
        batcher.query('https://example.com/2'),
      ]);
      
      await batch1;
      
      // Second batch
      const batch2 = Promise.all([
        batcher.query('https://example.com/3'),
        batcher.query('https://example.com/4'),
      ]);
      
      await batch2;
      
      expect(executor).toHaveBeenCalledTimes(2);
    });
  });

  describe('result handling', () => {
    it('should return correct results for each URL', async () => {
      const executor = createMockExecutor();
      const batcher = new RequestBatcher(executor, { maxSize: 50, maxWait: 50 }, logger);
      
      const [known, unknown] = await Promise.all([
        batcher.query('https://example.com/known'),
        batcher.query('https://example.com/new-page'),
      ]);
      
      expect(known.known).toBe(true);
      expect(known.data).toEqual({ title: 'Known Product' });
      
      expect(unknown.known).toBe(false);
      expect(unknown.data).toBeUndefined();
    });

    it('should handle missing URLs in response', async () => {
      const executor = vi.fn(async () => new Map<string, AIResult>());
      const batcher = new RequestBatcher(executor, { maxSize: 50, maxWait: 50 }, logger);
      
      const result = await batcher.query('https://example.com/missing');
      
      expect(result.known).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should reject all pending requests on executor error', async () => {
      const executor = vi.fn(async () => {
        throw new Error('API error');
      });
      const batcher = new RequestBatcher(executor, { maxSize: 50, maxWait: 50 }, logger);
      
      await expect(batcher.query('https://example.com/1')).rejects.toThrow('API error');
    });
  });

  describe('clear', () => {
    it('should resolve pending requests with fallback', async () => {
      const executor = vi.fn(async () => {
        // Delay to allow clear to be called
        await new Promise(resolve => setTimeout(resolve, 100));
        return new Map<string, AIResult>();
      });
      const batcher = new RequestBatcher(executor, { maxSize: 50, maxWait: 5000 }, logger);
      
      const promise = batcher.query('https://example.com/1');
      
      // Clear before executor completes
      batcher.clear();
      
      const result = await promise;
      expect(result.known).toBe(false);
      expect(result.fallback).toBe(true);
    });
  });

  describe('getQueueSize', () => {
    it('should return current queue size', () => {
      const executor = createMockExecutor();
      const batcher = new RequestBatcher(executor, { maxSize: 50, maxWait: 5000 }, logger);
      
      expect(batcher.getQueueSize()).toBe(0);
      
      // Add to queue without awaiting
      batcher.query('https://example.com/1');
      batcher.query('https://example.com/2');
      
      expect(batcher.getQueueSize()).toBe(2);
    });
  });
});
