# FetchBrain

<!-- TODO: logo image once brand CDN URL is confirmed -->

**The AI that already knows the web.**

`@fetchbrain.com/sdk` — AI-powered scraping optimization for Crawlee. Recall before you fetch; teach what you learn.

[![CI](https://github.com/fetchbrain-com/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/fetchbrain-com/sdk/actions/workflows/ci.yml) [![npm version](https://badge.fury.io/js/@fetchbrain.com%2Fsdk.svg)](https://www.npmjs.com/package/@fetchbrain.com/sdk) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

FetchBrain is an AI-powered brain for scrapers. Ask first — if the AI already knows the URL, you get the data instantly and the HTTP request is skipped entirely. If it doesn't, your scraper runs as normal and teaches FetchBrain for next time.

## Features

- 🚀 **Instant Results** - Skip redundant HTTP requests with memory it has already learned
- 🔄 **Auto-Learning** - AI automatically learns from scraped pages
- 🛡️ **Graceful Degradation** - Circuit breaker ensures your scraper never fails
- 📦 **Request Batching** - Optimized for high-concurrency scrapers
- 🔌 **Crawlee Compatible** - Works with CheerioCrawler, PlaywrightCrawler, and more

## Installation

```bash
npm install @fetchbrain.com/sdk
```

## Quick Start

```typescript
import { FetchBrain } from "@fetchbrain.com/sdk";
import { CheerioCrawler } from "crawlee";

const crawler = FetchBrain.enhance(
  new CheerioCrawler({
    requestHandler: async ({ $, request, pushData }) => {
      // This only runs when AI needs to "learn" (new page)
      const data = {
        title: $("h1").text(),
        price: $(".price").text(),
      };
      await pushData(data);
    },
  }),
  {
    apiKey: process.env.FETCHBRAIN_API_KEY,
    memory: "recent", // How far back the brain recalls
    learning: true, // AI learns from scraped pages
  },
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
  baseUrl?: string; // API URL (default: production)
  memory?: MemoryDepth; // How far back the brain recalls
  learning?: boolean; // Enable AI learning (default: true)
  alwaysRun?: boolean | string | string[]; // Which handlers to run (default: false)
  timeout?: number; // Request timeout in ms (default: 500)
  debug?: boolean; // Enable debug logging
}
```

### Memory Depth

| Depth      | Window | Description                               |
| ---------- | ------ | ------------------------------------------ |
| `fresh`    | 1h     | Only the most recent knowledge             |
| `recent`   | 24h    | Default — balanced recall window           |
| `standard` | 7d     | Broader recall for slower-changing pages   |
| `deep`     | 30d    | Deepest recall, broadest coverage          |

### Always Run Mode

Control which handlers run when AI knows the page. Useful for routers with multiple handlers:

```typescript
// Skip all handlers when AI knows (default)
FetchBrain.enhance(crawler, { alwaysRun: false });

// Always run all handlers
FetchBrain.enhance(crawler, { alwaysRun: true });

// Only run 'listing' handler (skip 'detail' when AI knows)
FetchBrain.enhance(crawler, { alwaysRun: "listing" });

// Run multiple specific handlers
FetchBrain.enhance(crawler, { alwaysRun: ["listing", "category"] });
```

| Value                     | Behavior                              |
| ------------------------- | ------------------------------------- |
| `false` (default)         | Auto-skip all handlers when AI knows  |
| `true`                    | Always run all handlers               |
| `'listing'`               | Only run handler with label 'listing' |
| `['listing', 'category']` | Run handlers with these labels        |

## Brain Context in Handler

Access brain data directly in your handler via `context.brain`:

```typescript
const crawler = FetchBrain.enhance(
  new CheerioCrawler({
    requestHandler: async ({ $, request, brain, pushData }) => {
      // Check if the brain already knows this page
      if (brain?.known) {
        console.log("Brain knows this page");

        // Option 1: Use brain data directly (skip scraping)
        await brain.use();
        return;

        // Option 2: Compare brain data with scraped data
        // const scraped = { title: $('h1').text() };
        // console.log('Brain:', brain.data, 'Scraped:', scraped);
      }

      // Scrape normally if the brain doesn't know
      const data = { title: $("h1").text() };
      await pushData(data);
    },
  }),
  { apiKey: "your-api-key", alwaysRun: true },
);
```

### `context.brain` Properties

| Property  | Type     | Description                       |
| --------- | -------- | ---------------------------------- |
| `known`   | boolean  | Whether the brain knows this URL   |
| `data`    | object   | Brain data (if known)              |
| `use()`   | function | Push brain data and skip scraping  |

## Using Dataset.pushData

> ⚠️ **Important**: AI learning **only happens** when you use `context.pushData()` or the SDK's `pushData()` wrapper below. Direct calls to `Dataset.pushData()` **will not trigger learning**, and the AI won't recognize these URLs in future runs.

If you use `Dataset.pushData()` instead of `context.pushData()`, use our wrapper for automatic AI learning:

```typescript
import { FetchBrain, pushData } from "@fetchbrain.com/sdk";
import { Dataset } from "crawlee";

const crawler = FetchBrain.enhance(
  new CheerioCrawler({
    requestHandler: async ({ $, request }) => {
      const data = { title: $("h1").text() };

      // ✅ Use pushData wrapper for AI learning
      await pushData(data, Dataset);

      // ✅ Or with named dataset
      await pushData(data, Dataset, "products");

      // ❌ This will NOT learn:
      // await Dataset.pushData(data);
    },
  }),
  { apiKey: "your-api-key" },
);
```

## Manual API

For custom integrations without Crawlee:

```typescript
import { FetchBrain } from "@fetchbrain.com/sdk";

const brain = new FetchBrain({
  apiKey: "your-api-key",
  memory: "recent",
});

// Check if the brain knows a URL
const result = await brain.recall({ url: "https://example.com/product/123" });

if (result.known) {
  console.log("Brain knows:", result.data);
} else {
  // Fetch and teach
  const data = await scrapeUrl("https://example.com/product/123");
  await brain.learn({ url: "https://example.com/product/123", data });
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
import { MockFetchBrain } from "@fetchbrain.com/sdk/mock";

const mock = new MockFetchBrain({
  initialKnowledge: new Map([
    ["https://example.com/product", { title: "Known Product" }],
  ]),
});

// Use in tests
const result = await mock.recall({ url: "https://example.com/product" });
expect(result.known).toBe(true);

// Ask a natural-language question against seeded knowledge
const answer = await mock.ask("what is the price?");
console.log(answer.sources);
```

## Examples

See the [examples](./examples) directory:

- **basic-cheerio** - CheerioCrawler with FetchBrain
- **manual-recall** - Direct API usage without Crawlee
- **with-mock** - Unit testing with MockFetchBrain

## API Reference

### `FetchBrain.enhance(crawler, config)`

Wraps a Crawlee crawler with FetchBrain optimization.

### `FetchBrain.recall({ url, memory? })`

Check if FetchBrain knows a URL.

### `FetchBrain.learn({ url, data })`

Teach FetchBrain new data.

### `FetchBrain.stats()`

Get usage statistics.

## License

MIT © FetchBrain

---

**Need help?** [Open an issue](https://github.com/fetchbrain-com/sdk/issues) or check our [documentation](https://docs.fetchbrain.com).
