import { describe, it, expect, beforeEach } from 'vitest';
import { MockFetchBrain, createMockConfig } from '../src/mock';

describe('MockFetchBrain', () => {
  let mock: MockFetchBrain;

  beforeEach(() => {
    mock = new MockFetchBrain();
  });

  describe('recall', () => {
    it('should return unknown for URLs the brain does not know', async () => {
      const result = await mock.recall({ url: 'https://example.com/unknown' });

      expect(result.known).toBe(false);
      expect(result.data).toBeUndefined();
    });

    it('should return data for keys the brain knows, with no confidence field', async () => {
      // First learn the data
      await mock.learn({ url: 'https://example.com/product' }, { title: 'Test Product', price: 9.99 });

      // Then recall by request
      const result = await mock.recall({ url: 'https://example.com/product' });

      expect(result.known).toBe(true);
      expect(result.data).toEqual({ title: 'Test Product', price: 9.99 });
      expect(result).not.toHaveProperty('confidence');
    });

    it("keys by (url, method, uniqueKey) — same url, distinct uniqueKey are distinct", async () => {
      const mock = new MockFetchBrain();
      await mock.learn({ url: "https://gql", method: "POST", uniqueKey: "op:A" }, { which: "A" });
      await mock.learn({ url: "https://gql", method: "POST", uniqueKey: "op:B" }, { which: "B" });
      expect((await mock.recall({ url: "https://gql", method: "POST", uniqueKey: "op:A" })).data).toEqual({ which: "A" });
      expect((await mock.recall({ url: "https://gql", method: "POST", uniqueKey: "op:B" })).data).toEqual({ which: "B" });
    });
  });

  describe('recallBulk', () => {
    it('should recall multiple items at once', async () => {
      await mock.learn({ url: 'https://example.com/1' }, { id: 1 });

      const results = await mock.recallBulk([
        { url: 'https://example.com/1' },
        { url: 'https://example.com/2' },
      ]);

      expect(results[0].known).toBe(true);
      expect(results[1].known).toBe(false);
    });
  });

  describe('learn', () => {
    it('should teach AI new data', async () => {
      const response = await mock.learn({ url: 'https://example.com/new' }, { foo: 'bar' });

      expect(response.status).toBe('success');
      expect(response.learned).toBe(1);
      expect(mock.has('https://example.com/new')).toBe(true);
    });
  });

  describe('stats', () => {
    it('should track usage statistics', async () => {
      await mock.recall({ url: 'https://example.com/1' });
      await mock.learn({ url: 'https://example.com/1' }, { data: 'test' });
      await mock.recall({ url: 'https://example.com/1' });

      const stats = await mock.stats();

      expect(stats.queries).toBe(2);
      expect(stats.known).toBe(1); // Second recall is known
      expect(stats.learned).toBe(1);
      expect(stats.recallRate).toBe(0.5);
    });
  });

  describe('seed', () => {
    it('should pre-populate AI knowledge', () => {
      mock.seed([
        { url: 'https://example.com/1', data: { id: 1 } },
        { url: 'https://example.com/2', data: { id: 2 } },
      ]);

      expect(mock.getKnowledgeSize()).toBe(2);
      expect(mock.has('https://example.com/1')).toBe(true);
      expect(mock.has('https://example.com/2')).toBe(true);
    });
  });

  describe('ask', () => {
    it('mock ask answers from seeded memory with sources', async () => {
      const brain = new MockFetchBrain();
      await brain.seed("https://x.com/p1", { title: "Blue Widget", price: 49 });
      const res = await brain.ask("blue widget");
      expect(res.status).toBe("ok");
      expect(res.sources.length).toBeGreaterThan(0);
      expect(res.sources[0].data).toMatchObject({ title: "Blue Widget" });
    });

    it('caps returned sources at the requested limit (default 10 / max 20)', async () => {
      const brain = new MockFetchBrain();
      await brain.seed([
        { url: "https://x.com/p1", data: { title: "Blue Widget" } },
        { url: "https://x.com/p2", data: { title: "Blue Widget XL" } },
        { url: "https://x.com/p3", data: { title: "Blue Widget Mini" } },
      ]);
      const res = await brain.ask("blue widget", { limit: 2 });
      expect(res.sources.length).toBe(2);
    });

    it('floors the limit at 1 (rejects 0 / negative limits)', async () => {
      const brain = new MockFetchBrain();
      await brain.seed("https://x.com/p1", { title: "Blue Widget" });
      const res = await brain.ask("blue widget", { limit: 0 });
      expect(res.sources.length).toBe(1);
    });

    it('sources carry the real learned/seeded URL, not the internal identity string', async () => {
      const brain = new MockFetchBrain();
      await brain.seed("https://x.com/p1?b=2&a=1", { title: "Blue Widget" });
      const res = await brain.ask("blue widget");
      expect(res.sources[0].url).toBe("https://x.com/p1?b=2&a=1");
    });

    it('returns a canned answer string when opts.answer is truthy', async () => {
      const brain = new MockFetchBrain();
      await brain.seed("https://x.com/p1", { title: "Blue Widget" });
      const res = await brain.ask("blue widget", { answer: true });
      expect(typeof res.answer).toBe("string");
      expect(res.answer).toContain("Blue Widget");
    });

    it('omits answer when opts.answer is falsy', async () => {
      const brain = new MockFetchBrain();
      await brain.seed("https://x.com/p1", { title: "Blue Widget" });
      const res = await brain.ask("blue widget");
      expect(res.answer).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should clear knowledge and stats', async () => {
      await mock.learn({ url: 'https://example.com/1' }, { data: 'test' });
      await mock.recall({ url: 'https://example.com/1' });

      mock.clear();

      expect(mock.getKnowledgeSize()).toBe(0);
      const stats = await mock.stats();
      expect(stats.queries).toBe(0);
    });
  });

  describe('initialKnowledge option', () => {
    it('should initialize with provided knowledge', async () => {
      const initialKnowledge = new Map([
        ['https://example.com/preset', { preset: true }],
      ]);

      const mockWithKnowledge = new MockFetchBrain({ initialKnowledge });
      const result = await mockWithKnowledge.recall({ url: 'https://example.com/preset' });

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

      await expect(failingMock.recall({ url: 'https://example.com/any' }))
        .rejects.toThrow('Simulated API failure');
    });
  });

  describe('latency option', () => {
    it('should add latency to requests', async () => {
      const slowMock = new MockFetchBrain({ latency: 100 });

      const start = Date.now();
      await slowMock.recall({ url: 'https://example.com/slow' });
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
    expect(config.memory).toBe('recent');
    expect(config.learning).toBe(true);
  });

  it('should allow overrides', () => {
    const config = createMockConfig({
      apiKey: 'custom_key',
      memory: 'fresh',
    });

    expect(config.apiKey).toBe('custom_key');
    expect(config.memory).toBe('fresh');
  });
});
