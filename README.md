# @fetchbrain/sdk

> **The AI That Already Knows The Web** - AI-powered scraping optimization for Crawlee

[![npm version](https://badge.fury.io/js/@fetchbrain%2Fsdk.svg)](https://www.npmjs.com/package/@fetchbrain/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

FetchBrain uses a neural network continuously trained on millions of web pages. Ask first → Get instant results. AI doesn't know? → We fetch & learn for next time.

## Features

- 🚀 **Instant Results** - Skip redundant HTTP requests with pre-trained knowledge
- 🔄 **Auto-Learning** - AI automatically learns from scraped pages
- 🛡️ **Graceful Degradation** - Circuit breaker ensures your scraper never fails
- 📦 **Request Batching** - Optimized for high-concurrency scrapers
- 🔌 **Crawlee Compatible** - Works with CheerioCrawler, PlaywrightCrawler, and more

## Installation

```bash
npm install @fetchbrain/sdk
```

## Quick Start

```typescript
import { FetchBrain } from '@fetchbrain/sdk';
import { CheerioCrawler } from 'crawlee';

const crawler = FetchBrain.enhance(
  new CheerioCrawler({
    requestHandler: async ({ $, request, pushData }) => {
      // This only runs when AI needs to "learn" (new page)
      const data = {
        title: $('h1').text(),
        price: $('.price').text(),
      };
      await pushData(data);
    },
  }),
  {
    apiKey: process.env.FETCHBRAIN_API_KEY,
    intelligence: 'high', // High confidence AI responses
    learning: true,       // AI learns from scraped pages
  }
);

await crawler.run(urls);
```

## How It Works

1. **Before each request**, FetchBrain queries the AI if it "knows" the URL
2. **AI knows**: Return data instantly from neural inference, skip HTTP request
3. **AI learning**: Run your scraper normally, then teach the AI

```
Your Scraper → FetchBrain SDK → AI knows? → YES → Return AI knowledge (skip request)
                              → NO  → Run scraper → AI learns for next time
```

## Configuration

```typescript
interface FetchBrainConfig {
  // Required
  apiKey: string;
  
  // Optional
  baseUrl?: string;           // API URL (default: production)
  intelligence?: IntelligenceLevel;  // AI accuracy level
  learning?: boolean;         // Enable AI learning (default: true)
  alwaysRun?: boolean | string | string[];  // Which handlers to run (default: false)
  timeout?: number;           // Request timeout in ms (default: 500)
  debug?: boolean;            // Enable debug logging
}
```

### Intelligence Levels

| Level | Description |
|-------|-------------|
| `realtime` | Live AI inference, highest accuracy |
| `high` | High confidence responses |
| `standard` | Balanced accuracy and speed |
| `deep` | Deep knowledge, broader coverage |

### Always Run Mode

Control which handlers run when AI knows the page. Useful for routers with multiple handlers:

```typescript
// Skip all handlers when AI knows (default)
FetchBrain.enhance(crawler, { alwaysRun: false });

// Always run all handlers
FetchBrain.enhance(crawler, { alwaysRun: true });

// Only run 'listing' handler (skip 'detail' when AI knows)
FetchBrain.enhance(crawler, { alwaysRun: 'listing' });

// Run multiple specific handlers
FetchBrain.enhance(crawler, { alwaysRun: ['listing', 'category'] });
```

| Value | Behavior |
|-------|----------|
| `false` (default) | Auto-skip all handlers when AI knows |
| `true` | Always run all handlers |
| `'listing'` | Only run handler with label 'listing' |
| `['listing', 'category']` | Run handlers with these labels |

## AI Context in Handler

Access AI data directly in your handler via `context.ai`:

```typescript
const crawler = FetchBrain.enhance(
  new CheerioCrawler({
    requestHandler: async ({ $, request, ai, pushData }) => {
      // Check if AI already knows this page
      if (ai?.known && ai.confidence! > 0.9) {
        console.log('AI knows this page with high confidence');
        
        // Option 1: Use AI data directly (skip scraping)
        await ai.useAIData();
        return;
        
        // Option 2: Compare AI data with scraped data
        // const scraped = { title: $('h1').text() };
        // console.log('AI:', ai.data, 'Scraped:', scraped);
      }
      
      // Scrape normally if AI doesn't know
      const data = { title: $('h1').text() };
      await pushData(data);
    },
  }),
  { apiKey: 'your-api-key', alwaysRun: true }
);
```

### `context.ai` Properties

| Property | Type | Description |
|----------|------|-------------|
| `known` | boolean | Whether AI knows this URL |
| `data` | object | AI data (if known) |
| `confidence` | number | Confidence score 0-1 |
| `learnedAt` | string | When AI learned this |
| `useAIData()` | function | Push AI data and skip scraping |

## Using Dataset.pushData

If you use `Dataset.pushData()` instead of `context.pushData()`, use our wrapper for automatic AI learning:

```typescript
import { FetchBrain, pushData } from '@fetchbrain/sdk';
import { Dataset } from 'crawlee';

const crawler = FetchBrain.enhance(
  new CheerioCrawler({
    requestHandler: async ({ $, request }) => {
      const data = { title: $('h1').text() };
      
      // Use pushData wrapper for AI learning
      await pushData(data, Dataset);
      
      // Or with named dataset
      await pushData(data, Dataset, 'products');
    },
  }),
  { apiKey: 'your-api-key' }
);
```

## Manual API

For custom integrations without Crawlee:

```typescript
import { FetchBrain } from '@fetchbrain/sdk';

const ai = new FetchBrain({
  apiKey: 'your-api-key',
  intelligence: 'high',
});

// Check if AI knows a URL
const result = await ai.query({ url: 'https://example.com/product/123' });

if (result.known) {
  console.log('AI knows:', result.data);
  console.log('Confidence:', result.confidence);
} else {
  // Fetch and teach
  const data = await scrapeUrl('https://example.com/product/123');
  await ai.learn({ url: 'https://example.com/product/123', data });
}
```

## Graceful Degradation

FetchBrain includes a circuit breaker that ensures your scraper continues even if the API is unavailable:

- **API healthy**: Normal operation with AI optimization
- **API slow (>500ms)**: Timeout, continue without AI
- **API down**: Circuit opens, scraper runs standalone
- **API recovers**: Circuit closes, AI optimization resumes

Your scraper will **never fail** due to FetchBrain issues.

## Local Development

### Mock Server

For local testing without the production API:

```bash
# Start mock server
npm run mock-server

# In your code, use localhost
const crawler = FetchBrain.enhance(crawler, {
  apiKey: 'test_local_key',
  baseUrl: 'http://localhost:3456',
});
```

### Mock Client for Testing

```typescript
import { MockFetchBrain } from '@fetchbrain/sdk/mock';

const mock = new MockFetchBrain({
  initialKnowledge: new Map([
    ['https://example.com/product', { title: 'Known Product' }],
  ]),
});

// Use in tests
const result = await mock.query('https://example.com/product');
expect(result.known).toBe(true);
```

## Examples

See the [examples](./examples) directory:

- **basic-cheerio** - CheerioCrawler with FetchBrain
- **manual-query** - Direct API usage without Crawlee
- **with-mock** - Unit testing with MockFetchBrain

## API Reference

### `FetchBrain.enhance(crawler, config)`

Wraps a Crawlee crawler with FetchBrain optimization.

### `FetchBrain.query({ url, intelligence? })`

Check if FetchBrain knows a URL.

### `FetchBrain.learn({ url, data })`

Teach FetchBrain new data.

### `FetchBrain.stats()`

Get usage statistics.

## License

MIT © FetchBrain

---

**Need help?** [Open an issue](https://github.com/fetchbrain-com/fetchbrain-sdk/issues) or check our [documentation](https://docs.fetchbrain.com).