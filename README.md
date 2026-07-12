<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logo/fetchbrain-logo-reversed.svg">
  <img src="logo/fetchbrain-logo-primary.svg" alt="FetchBrain" width="340">
</picture>

**Make your scrapers smarter with every run.**

`@fetchbrain.com/sdk` — AI-powered scraping optimization for Crawlee. Recall before you fetch; teach what you learn.

[![CI](https://github.com/fetchbrain-com/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/fetchbrain-com/sdk/actions/workflows/ci.yml) [![npm version](https://badge.fury.io/js/@fetchbrain.com%2Fsdk.svg)](https://www.npmjs.com/package/@fetchbrain.com/sdk) [![TypeScript](https://img.shields.io/badge/TypeScript-first-3178C6.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Docs](https://docs.fetchbrain.com) · [Examples](./examples) · [Changelog](./CHANGELOG.md)

</div>

- 🚀 **Instant Results** - Skip redundant HTTP requests with memory it has already learned
- 🔄 **Auto-Learning** - AI automatically learns from scraped pages
- 🛡️ **Graceful Degradation** - Circuit breaker ensures your scraper never fails
- 📦 **Request Batching** - Optimized for high-concurrency scrapers
- 🔌 **Crawlee Compatible** - Works with CheerioCrawler, PlaywrightCrawler, and more

---

Every scraping run re-fetches thousands of pages you already scraped last
time — paying for proxies, browsers, retries, and CAPTCHAs to learn things
you already know.

FetchBrain gives your scrapers a **shared memory pool**. Before each
request, a crawler asks *"do I already know this request?"* — known
requests come back in **~50ms** without touching the network; unknown ones
run normally and are learned. Everything every scraper learns accumulates under
your API key, run after run, scraper after scraper — a data asset that
compounds instead of costs. **Learning is always free.**

```text
$ node scraper.js                      # first run — the brain learns
  ● learned   example.com/p/1042        1.9s
  ● learned   example.com/p/1043        2.3s
  ● learned   example.com/p/1044        2.1s

$ node scraper.js                      # every run after that
  ● known     example.com/p/1042        0.05s   ⚡ no fetch
  ● known     example.com/p/1043        0.04s   ⚡ no fetch
  ● known     example.com/p/1044        0.05s   ⚡ no fetch

  🧠 Finished! recalled: 3/3 (100%), learned: 0, duration: 0.3s
```

## One line to adopt

FetchBrain wraps your existing [Crawlee](https://crawlee.dev) crawler — no
rewrites, no new framework, no pipeline changes:

```diff
+ import { FetchBrain } from "@fetchbrain.com/sdk";
  import { CheerioCrawler } from "crawlee";

- const crawler = new CheerioCrawler({
+ const crawler = FetchBrain.enhance(new CheerioCrawler({
    requestHandler: async ({ $, pushData }) => {
      await pushData({ title: $("h1").text(), price: $(".price").text() });
    },
- });
+ }), { apiKey: process.env.FETCHBRAIN_API_KEY });

  await crawler.run(urls);
```

That's it. Your handler only runs when there's something new to learn.

## Why FetchBrain

|  | Without | With FetchBrain |
| --- | --- | --- |
| **Repeat requests** | Full fetch, every run | Recalled in ~50ms, zero HTTP |
| **Proxy & compute spend** | Pay per fetch, every run | Pay only for what it knows |
| **Blocks & CAPTCHAs** | Every run risks them | Known requests never touch the site |
| **When the service is down** | — | Your crawl runs normally — guaranteed |
| **Testing** | Mock it yourself | `MockFetchBrain` ships in the box |

- ⚡ **Instant recall** — known requests skip the network entirely
- 🌐 **Any request, not just pages** — HTML, JSON APIs, POSTs with bodies; identity is derived from the full request
- 🎓 **Auto-learning** — every successful scrape teaches the brain, free
- 🛡️ **Never breaks your crawl** — circuit breaker degrades gracefully; a FetchBrain outage costs you optimization, never data
- 📦 **Built for scale** — request batching and deduping for high-concurrency crawlers
- 🔌 **Crawlee-native** — CheerioCrawler, PlaywrightCrawler, and friends
- 🔒 **Private by design** — only platform identifiers (`*_ID` env vars) ever leave your process; your data is scoped to your key
- 🧪 **TypeScript-first** — full types, ESM + CJS, zero config

## Who is it for?

**Solo scraper developers** — stop paying twice for the same request. Your
daily product crawl, your price monitor, your side-project spider: they
all deposit into one brain, your proxy bill shrinks every run, and you can
`ask()` questions across everything you've ever collected.

**Data-service and scraping companies** — fetch once, serve many. Repeat
crawls across pipelines and clients amortize against the same pool,
per-run costs fall as coverage grows, and the brain doubles as a
natural-language query layer over your whole corpus — without building a
warehouse first.

**Teams running scheduled crawls** — daily and hourly re-runs are where
the savings explode: after the first pass, a stable site costs almost
nothing to keep monitoring, and volatile data stays fresh with `memory:
"fresh"`.

## Quick start

```bash
npm install @fetchbrain.com/sdk
```

```typescript
import { FetchBrain } from "@fetchbrain.com/sdk";
import { CheerioCrawler } from "crawlee";

const crawler = FetchBrain.enhance(
  new CheerioCrawler({
    requestHandler: async ({ $, pushData }) => {
      // Runs only when the brain needs to learn (new request)
      await pushData({
        title: $("h1").text(),
        price: $(".price").text(),
      });
    },
  }),
  {
    apiKey: process.env.FETCHBRAIN_API_KEY,
    memory: "recent", // How far back the brain recalls (see below)
    learning: true, // AI learns from scraped pages
  },
);

await crawler.run(urls);
```

## How it works

```
Your crawler ──▶ FetchBrain ──▶ knows this request? ──▶ YES ──▶ data in ~50ms, no fetch
                                      │
                                      └──▶ NO ──▶ your handler runs ──▶ brain learns, free
```

1. **Recall** — before each request, the SDK asks if the brain knows it
2. **Known** — data returns instantly and the fetch is skipped
3. **Learning** — unknown requests run through your handler as normal, and the result teaches the brain for every future run

### Memory depth

How old is too old? You decide, per crawler:

| Depth | Window | Use for |
| --- | --- | --- |
| `fresh` | 1 hour | prices, stock, anything volatile |
| `recent` | 24 hours | **default** — daily crawl cycles |
| `standard` | 7 days | listings, catalogs |
| `deep` | 30 days | slow-changing reference data |

## Take control in your handler

`context.brain` puts the recall decision in your hands:

```typescript
requestHandler: async ({ $, brain, pushData }) => {
  if (brain?.known) {
    await brain.use(); // push the brain's data, skip scraping
    return;
  }
  await pushData({ title: $("h1").text() }); // scrape + learn
},
```

| Property | Type | Description |
| --- | --- | --- |
| `known` | `boolean` | whether the brain knows this request |
| `data` | `object` | the remembered data (if known) |
| `use()` | `function` | push the brain's data and skip scraping |

### Configuration Options

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

Fine-grained routing control with `alwaysRun` — run every handler, none, or
only specific labels when a request is known:

```typescript
FetchBrain.enhance(crawler, { alwaysRun: ["listing", "category"] });
```

## Ask your brain anything

This is where the pool pays off twice: `ask()` searches across everything
**all** your scrapers have ever learned — one question, your whole corpus,
no exact URLs, no warehouse:

```typescript
import { FetchBrainClient } from "@fetchbrain.com/sdk";

const client = new FetchBrainClient({ apiKey: process.env.FETCHBRAIN_API_KEY });
const res = await client.ask("blue widgets under $50", { answer: true });

console.log(res.answer);   // synthesized answer
console.log(res.sources);  // scored sources
```

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

## No Crawlee? No problem

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
  const data = await scrapeYourWay("https://example.com/product/123");
  await brain.learn({ url: "https://example.com/product/123", data }); // free
}
```

## It will never break your crawl

The circuit breaker is not an afterthought — it's the core design contract:

- **Healthy** → full optimization
- **Slow** (>500ms) → time out, continue without recall
- **Down** → circuit opens, your scraper runs standalone
- **Recovered** → circuit closes, optimization resumes

A FetchBrain problem can cost you *optimization*, never *data*. Every SDK
call degrades gracefully; none of them throw into your crawl.

## Testing

`MockFetchBrain` ships with the SDK — seed it, run your tests, no network:

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
expect(answer.sources.length).toBeGreaterThan(0);
console.log(answer.sources);
```

There's also a local mock **server** (`npm run mock-server`) for running
real crawlers against `http://localhost:3456` without an API key.

## Examples

| Example | Shows |
| --- | --- |
| [`basic-cheerio`](./examples/basic-cheerio) | CheerioCrawler + FetchBrain in ~40 lines |
| [`manual-recall`](./examples/manual-recall) | recall/learn without Crawlee |
| [`with-mock`](./examples/with-mock) | unit testing with `MockFetchBrain` |

- **basic-cheerio** - CheerioCrawler with FetchBrain
- **manual-recall** - Direct API usage without Crawlee
- **with-mock** - Unit testing with MockFetchBrain

## FAQ

**Does my scraped data train anyone else's brain?**
No. Everything your scrapers teach is scoped to your API key. Your data
answers only your recalls.

**Do my scrapers share memory?**
Yes — that's the point. Everything learned under your API key accumulates
in one brain, and `ask()` searches across all of it. Recall is namespaced
per scraper identity, so one scraper's responses never pollute
another's results.

**What leaves my process?**
Your requests, the data you choose to learn, and platform identifiers only
(env vars ending in `_ID`, plus `NODE_ENV`/`REGION`/`CI`). Never your
environment, credentials, or anything credential-shaped — [see the changelog](./CHANGELOG.md).

**What does learning cost?**
Nothing. Learning is always free — you pay only for known queries.

**What if the data changed since the brain learned it?**
That's what memory depth is for: pick `fresh` (1h) for volatile data, or
set `refreshOnRebuild` to re-learn whenever you ship a new scraper build.

## Contributing

Issues and PRs welcome — see [open issues](https://github.com/fetchbrain-com/sdk/issues).
If FetchBrain saves your crawler time or money, **a ⭐ helps other scraper
developers find it**.

## License

MIT © [FetchBrain](https://fetchbrain.com)

---

**Need help?** [Open an issue](https://github.com/fetchbrain-com/sdk/issues) · [Read the docs](https://docs.fetchbrain.com)
