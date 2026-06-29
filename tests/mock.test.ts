import { describe, it, expect, beforeEach } from 'vitest';
import { MockFetchBrain, createMockConfig } from '../src/mock';

describe('MockFetchBrain', () => {
  let mock: MockFetchBrain;

  beforeEach(() => {
    mock = new MockFetchBrain();
  });

  describe('query', () => {
    it('should return unknown for URLs AI does not know', async () => {
      const result = await mock.query('https://example.com/unknown');

      expect(result.known).toBe(false);
      expect(result.data).toBeUndefined();
    });

    it('should return data for keys AI knows', async () => {
      // First learn the data (key-based)
      await mock.learn('https://example.com/product', { title: 'Test Product', price: 9.99 });

      // Then query by key
      const result = await mock.query('https://example.com/product');

      expect(result.known).toBe(true);
      expect(result.data).toEqual({ title: 'Test Product', price: 9.99 });
      expect(result.confidence).toBe(0.97);
    });
  });

  describe('queryBulk', () => {
    it('should query multiple items at once', async () => {
      await mock.learn('https://example.com/1', { id: 1 }, 'https://example.com/1');

      const results = await mock.queryBulk([
        { key: 'https://example.com/1' },
        { key: 'https://example.com/2' },
      ]);

      expect(results.get('https://example.com/1')?.known).toBe(true);
      expect(results.get('https://example.com/2')?.known).toBe(false);
    });
  });

  describe('learn', () => {
    it('should teach AI new data keyed by key', async () => {
      const response = await mock.learn('https://example.com/new', { foo: 'bar' }, 'https://example.com/new');

      expect(response.status).toBe('success');
      expect(response.learned).toBe(1);
      expect(mock.has('https://example.com/new')).toBe(true);
    });
  });

  describe('stats', () => {
    it('should track usage statistics', async () => {
      await mock.query('https://example.com/1');
      await mock.learn('https://example.com/1', { data: 'test' }, 'https://example.com/1');
      await mock.query('https://example.com/1');
      
      const stats = await mock.stats();
      
      expect(stats.queries).toBe(2);
      expect(stats.recognized).toBe(1); // Second query is recognized
      expect(stats.learned).toBe(1);
      expect(stats.recognitionRate).toBe(0.5);
    });
  });

  describe('seed', () => {
    it('should pre-populate AI knowledge', () => {
      mock.seed([
        { key: 'https://example.com/1', data: { id: 1 } },
        { key: 'https://example.com/2', data: { id: 2 } },
      ]);

      expect(mock.getKnowledgeSize()).toBe(2);
      expect(mock.has('https://example.com/1')).toBe(true);
      expect(mock.has('https://example.com/2')).toBe(true);
    });
  });

  describe('clear', () => {
    it('should clear knowledge and stats', async () => {
      await mock.learn('https://example.com/1', { data: 'test' }, 'https://example.com/1');
      await mock.query('https://example.com/1');
      
      mock.clear();
      
      expect(mock.getKnowledgeSize()).toBe(0);
      const stats = await mock.stats();
      expect(stats.queries).toBe(0);
    });
  });

  describe('two-argument query (key vs url)', () => {
    it('should query by key when key differs from url', async () => {
      const key = 'product-abc-123';
      const url = 'https://example.com/p/1';

      // Learn is now key-based — store under key, not url
      const mock2 = new MockFetchBrain();
      await mock2.learn(key, { id: 'abc-123', title: 'Product' }, url);

      // Query with key and url as separate arguments — should find by key
      const result = await mock2.query(key, url);

      expect(result.known).toBe(true);
      expect(result.data).toEqual({ id: 'abc-123', title: 'Product' });
    });
  });

  describe('initialKnowledge option', () => {
    it('should initialize with provided knowledge', async () => {
      const initialKnowledge = new Map([
        ['https://example.com/preset', { preset: true }],
      ]);

      const mockWithKnowledge = new MockFetchBrain({ initialKnowledge });
      const result = await mockWithKnowledge.query('https://example.com/preset');

      expect(result.known).toBe(true);
      expect(result.data).toEqual({ preset: true });
    });
  });

  describe('simulateFailures option', () => {
    it('should simulate failures when enabled', async () => {
      const failingMock = new MockFetchBrain({
        simulateFailures: true,
        failureRate: 1, // 100% failure rate
      });
      
      await expect(failingMock.query('https://example.com/any'))
        .rejects.toThrow('Simulated API failure');
    });
  });

  describe('latency option', () => {
    it('should add latency to requests', async () => {
      const slowMock = new MockFetchBrain({ latency: 100 });
      
      const start = Date.now();
      await slowMock.query('https://example.com/slow');
      const duration = Date.now() - start;
      
      expect(duration).toBeGreaterThanOrEqual(90); // Allow some variance
    });
  });
});

describe('createMockConfig', () => {
  it('should return default config', () => {
    const config = createMockConfig();
    
    expect(config.apiKey).toBe('test_mock_key');
    expect(config.baseUrl).toBe('http://localhost:3456');
    expect(config.intelligence).toBe('high');
    expect(config.learning).toBe(true);
  });

  it('should allow overrides', () => {
    const config = createMockConfig({
      apiKey: 'custom_key',
      intelligence: 'realtime',
    });
    
    expect(config.apiKey).toBe('custom_key');
    expect(config.intelligence).toBe('realtime');
  });
});
