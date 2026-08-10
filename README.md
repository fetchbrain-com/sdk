<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logo/fetchbrain-logo-reversed.svg">
  <img src="logo/fetchbrain-logo-primary.svg" alt="FetchBrain" width="340">
</picture>

**Make your scrapers smarter with every run.**

*Your crawler teaches it once. It recognizes forever.*

[![CI](https://github.com/fetchbrain-com/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/fetchbrain-com/sdk/actions/workflows/ci.yml) [![npm version](https://badge.fury.io/js/@fetchbrain.com%2Fsdk.svg)](https://www.npmjs.com/package/@fetchbrain.com/sdk) [![TypeScript](https://img.shields.io/badge/TypeScript-first-3178C6.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Docs](https://docs.fetchbrain.com) · [Examples](./examples) · [Changelog](./CHANGELOG.md)

</div>

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

### Try it in 60 seconds

```ts
// scraper.mjs — run this twice and watch the second run skip the fetch
import { CheerioCrawler } from "crawlee";
import { FetchBrain } from "@fetchbrain.com/sdk";

const crawler = new CheerioCrawler({
  async requestHandler({ request, $, pushData }) {
    await pushData({ url: request.url, title: $("title").text() });
  },
});

FetchBrain.enhance(crawler, { apiKey: process.env.FETCHBRAIN_API_KEY });

await crawler.run(["https://example.com/"]);
// Run 1:  ● learned   example.com/          — your scraper fetched it and taught your brain
// Run 2:  ● known     example.com/   ~50ms  — recalled from memory, no HTTP request made
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
- 🔒 **Private by design** — your data is scoped to your key; only your requests, what you choose to learn, and platform identifiers (`*_ID` env vars) leave your process. Anonymized telemetry is **opt-in** ([opt-in telemetry](#telemetry-opt-in))
- 🧪 **TypeScript-first** — full types, ESM + CJS, zero config

## Who is it for?

FetchBrain pays off wherever the **same expensive request gets made more
than once** — across a fleet, across users, or across runs. It won't speed
up a first-ever fetch of a brand-new URL, and it's not for freshness-critical
monitoring where you always need the live value. Everywhere else, it compounds:

**Data-service teams & aggregators** — fetch an expensive request once, serve
it to every client and job. Overlapping crawls draw from one shared pool, so
per-run proxy and compute cost falls as coverage grows — and `ask()` turns
everything you've collected into a queryable corpus, with no warehouse to run.

**Product teams & AI agents** — apps and browsing agents that re-hit popular
requests get them back in milliseconds, straight from memory: no fetch, no
proxy, no block. The more your users (or agents) converge on the same
requests, the more the pool pays off.

**Recurring crawls of stable data** — catalogs, specs, listings, company and
reference data barely change between runs, so recall skips the fetch and each
scheduled run costs less. Keep volatile fields on `memory: "fresh"` so you
never trade accuracy for speed.

**Solo scraper developers** — start free: learning never costs anything, and
the requests you've already made come back instantly instead of getting
blocked or throttled. One line to add, one brain that grows with everything
you scrape.

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
    memory: "recent", // how far back the brain recalls (see below)
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
  skipLabels?: string[]; // Labels that bypass FetchBrain entirely (default: none)
  preRecall?: boolean; // Recall requests in bulk as they're enqueued (default: true)
  onRecalled?: (event: RecalledEvent) => void | Promise<void>; // Per-record hook when known data is delivered
  timeout?: number; // Request timeout in ms (default: 500)
  debug?: boolean; // Enable debug logging
}
```

### Recall at enqueue time (`preRecall`)

In `HttpCrawler`/`CheerioCrawler`, Crawlee performs the HTTP request *before*
your request handler runs — so a recall inside the handler is too late to
save the fetch. With `preRecall` (on by default), the SDK checks the brain
the moment requests enter the queue: each `crawler.addRequests()` array
becomes a single bulk recall, known requests are enqueued with Crawlee's
`skipNavigation` so their fetch never happens, and unknown requests carry
their recall result with them so the handler doesn't ask twice. Enqueue in
batches (one `addRequests` call per page of discovered items) to get the
most out of it. If the brain is unreachable, requests are enqueued unchanged
and your crawl proceeds at native speed — same graceful degradation as
everywhere else.

Things to know:

- **Scope** — pre-recall applies to arrays passed to `crawler.addRequests()`
  or `crawler.run(requests)`. Crawlee's context-level `enqueueLinks()` and
  context `addRequests()` reach the queue by other paths and are not
  pre-recalled (they still get handler-time recall). Inside a handler,
  enqueue follow-ups with `context.crawler.addRequests([...])` to keep the
  benefit — as in the example above.
- **Metering** — recall queries are counted when requests are enqueued, so
  duplicates the queue later drops still count as queries.
- **Snapshot semantics** — the recall result is as of enqueue time. Anything
  learned between enqueue and execution isn't picked up; the request is
  simply scraped and re-learned.
- **Expired memory** — if a request skipped its fetch at enqueue but its
  remembered data genuinely expired before it executed (e.g. across a process
  restart), it fails once without retries and lands in your
  `failedRequestHandler`, so the missing record is visible to your error
  tooling. It will be re-scraped on a future run. (If the data merely couldn't
  be restored because the API was briefly unreachable, the request fails
  retryable and the next attempt restores it.)
- **`retryOnBlocked` crawlers** — Crawlee's blocked-request detection needs a
  fetched response, so on these crawlers known requests keep their fetch;
  recalled data still replaces the handler (no second recall, no re-scrape).

### Reacting to recalled records (`onRecalled`)

When the brain knows a request, your handler is skipped and the remembered
data is pushed for you — which also skips any per-record bookkeeping living
in that handler (billing events, counters, follow-up enqueues). `onRecalled`
runs once per recalled record with `{ url, label, userData, data }` — both
when the handler is auto-skipped and when your own handler calls
`context.brain.use()`:

```typescript
FetchBrain.enhance(crawler, {
  onRecalled: async ({ userData }) => {
    await Actor.charge({ eventName: "product-detail", count: 1 });
  },
});
```

Hook errors are swallowed (logged at debug) — they never break the crawl.

Fine-grained routing control with `alwaysRun` — run every handler, none, or
only specific labels when a request is known:

```typescript
FetchBrain.enhance(crawler, { alwaysRun: ["listing", "category"] });
```

For dynamic requests that must always run live and aren't worth remembering
(search results, pagination), use `skipLabels` instead: where `alwaysRun`
still recalls (and can learn), `skipLabels` bypasses FetchBrain entirely —
no recall round-trip, no learn — so those requests run at native speed:

```typescript
FetchBrain.enhance(crawler, { skipLabels: ["search", "pagination"] });
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

Pick the model that writes the answer with `model` — the default is Llama 3.3
70B (`"llama-3.3-70b"`, included on every plan). Premium models like
`"kimi-k2.5"` and `"kimi-k2.6"` use extra ask credits and need a paid plan,
and `"byok"` answers with your own linked provider model (configured in the
dashboard, billed to your provider):

```typescript
const res = await client.ask("blue widgets under $50", {
  answer: true,
  model: "llama-3.3-70b", // or "kimi-k2.5" / "byok" on paid plans
});
console.log(res.model); // slug actually used (reveals fallbacks)
```

Every plan includes a monthly ask allowance (100 free → 60,000 on Scale);
asks never consume your recall quota.

If the API refuses a request — unknown model slug, a premium model without a
paid plan, `"byok"` with no linked provider — the response comes back with
`status: "rejected"` and an `error` explaining why. That's distinct from
`status: "unavailable"`, which means the API itself is degraded or
unreachable.

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

| Property | Type     | Description                       |
| -------- | -------- | --------------------------------- |
| `known`  | boolean  | Whether the brain knows this URL  |
| `data`   | object   | Brain data (if known)             |
| `use()`  | function | Push brain data and skip scraping |

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

## Telemetry (opt-in)

Telemetry is **off by default.** You can opt in to send anonymized
operational diagnostics that help improve FetchBrain:

```typescript
FetchBrain.enhance(crawler, {
  apiKey: process.env.FETCHBRAIN_API_KEY,
  telemetry: { enabled: true },
});
```

**What's sent** (all anonymized): domain (e.g. `walmart.com`), a SHA-256
**hash** of the full URL, a generalized path pattern, timing and status
codes, retry counts, proxy **country/type** and success, coarse session
aggregates (age, error rate, cookie *count*), block indicators, and crawler
type. **Never:** raw URLs, request/response bodies, cookies or their values,
proxy IPs, credentials, or any PII.

Share selectively with the sub-flags — e.g.
`telemetry: { enabled: true, shareProxyInfo: false }`. Collection is
buffered, best-effort, and never blocks or fails your crawl.

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
By default: your requests, the data you choose to learn, and platform
identifiers (env vars ending in `_ID`, plus `NODE_ENV`/`REGION`/`CI`). Never
your general environment, credentials, or anything credential-shaped. If you
opt into telemetry, anonymized access signal too — [see what](#telemetry-opt-in).

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
