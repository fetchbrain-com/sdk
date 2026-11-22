<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logo/fetchbrain-logo-reversed.svg">
  <img src="logo/fetchbrain-logo-primary.svg" alt="FetchBrain" width="340">
</picture>

**Make your scrapers smarter with every run.**

*Your crawler teaches it once. It recalls it on every run after.*

[![CI](https://github.com/fetchbrain-com/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/fetchbrain-com/sdk/actions/workflows/ci.yml) [![npm version](https://badge.fury.io/js/@fetchbrain.com%2Fsdk.svg)](https://www.npmjs.com/package/@fetchbrain.com/sdk) [![TypeScript](https://img.shields.io/badge/TypeScript-first-3178C6.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Docs](https://docs.fetchbrain.com) · [Examples](./examples) · [Changelog](./CHANGELOG.md)

</div>

---

Every scraping run re-fetches thousands of pages you already scraped last
time — paying for proxies, browsers, retries, and CAPTCHAs to learn things
you already know.

FetchBrain gives each of your scrapers a **memory**. Before each request, a
crawler asks *"do I already know this request?"* — known requests come back
**in milliseconds** without your scraper fetching the page; unknown ones run
normally and are learned. Memory grows run after run, and `ask()` answers
plain-English questions from what you've learned — a data asset that
compounds instead of costs. **Learning is always free.**

```text
$ node scraper.js                      # first run — the brain learns
INFO  FetchBrain: 🧠 Finished! recalled: 0/3 (0.0%), learned: 3, scraped: 3, duration: 6.4s

$ node scraper.js                      # every run after that
INFO  FetchBrain: Recalled: https://example.com/p/1042 [default]
INFO  FetchBrain: Recalled: https://example.com/p/1043 [default]
INFO  FetchBrain: Recalled: https://example.com/p/1044 [default]
INFO  FetchBrain: 🧠 Finished! recalled: 3/3 (100.0%), learned: 0, scraped: 0, duration: 0.3s
```

### Try it

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
// Run 1: your scraper fetches the page and teaches your brain
// Run 2: recalled from memory in milliseconds, no HTTP request to example.com
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
| **Repeat requests** | Full fetch, every run | Recalled in milliseconds |
| **Proxy & compute spend** | Pay per fetch, every run | Pay only for what it knows |
| **Blocks & CAPTCHAs** | Every run risks them | Pre-recalled known requests skip the fetch |
| **When the service is down** | — | Your crawl runs normally (circuit breaker, 500ms timeout) |
| **Testing** | Mock it yourself | `MockFetchBrain` ships in the box |

- **Recall before you fetch** — known requests are answered from memory; when they're recalled at enqueue time, the page is never fetched ([caveats](#recall-at-enqueue-time-prerecall))
- **Any request, not just pages** — HTML, JSON APIs, POSTs with bodies; identity is derived from the full request
- **Auto-learning** — every successful scrape teaches the brain, free
- **Never breaks your crawl** — the circuit breaker degrades gracefully; an outage costs you optimization, not your crawl (one deliberate exception: [expired memory](#recall-at-enqueue-time-prerecall))
- **Built for scale** — request batching and deduping for high-concurrency crawlers
- **Crawlee-native** — CheerioCrawler, PlaywrightCrawler, and friends
- **Transparent** — see exactly [what leaves your process](#what-leaves-your-process). Telemetry is **opt-in** and pseudonymous ([details](#telemetry-opt-in))
- **TypeScript-first** — full types, ESM + CJS; an API key is the only required option

## Who is it for?

FetchBrain pays off wherever a scraper makes the **same expensive request more
than once** — across runs, scheduled jobs, or the users it serves. It won't
speed up a first-ever fetch of a brand-new URL, and it's not for
freshness-critical monitoring where you always need the live value.
Everywhere else, it compounds:

**Data-service teams & aggregators** — each scraper fetches an expensive
request once and recalls it on every run after, so per-run proxy and compute
cost falls as coverage grows — and `ask()` turns what they've collected into
memory you can ask questions of, with no warehouse to run.

**Product teams & AI agents** — apps and browsing agents that re-hit the same
requests get them back in milliseconds, straight from memory: no fetch, no
proxy, no block. The more often a scraper revisits the same requests, the more
its memory pays off.

**Recurring crawls of stable data** — catalogs, specs, listings, company and
reference data barely change between runs, so recall skips the fetch and each
scheduled run costs less. Keep volatile fields on `memory: "fresh"` so you
never trade accuracy for speed.

**Solo scraper developers** — start free: learning never costs anything, and
the requests you've already made come back from memory instead of getting
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
Your crawler ──▶ FetchBrain ──▶ knows this request? ──▶ YES ──▶ data in milliseconds, no fetch
                                      │
                                      └──▶ NO ──▶ your handler runs ──▶ brain learns, free
```

1. **Recall** — before each request (at enqueue time by default), the SDK asks if the brain knows it
2. **Known** — the remembered data is pushed for you and your handler is skipped; requests recalled at enqueue also skip the fetch
3. **Learning** — unknown requests run through your handler as normal, and the result teaches the brain for that scraper's future runs

Memory is always private to your account. Within it, scoping depends on
where the scraper runs ([details](#do-my-scrapers-share-memory)): on Apify
each actor has its own memory; everywhere else, all scrapers under one API
key share one memory.

### Memory depth

How old is too old? You decide, per crawler:

| Depth | Window | Use for |
| --- | --- | --- |
| `fresh` | 1 hour | prices, stock, anything volatile |
| `recent` | 24 hours | **default** — daily crawl cycles |
| `standard` | 7 days | listings, catalogs |
| `deep` | 30 days | slow-changing reference data |

## Brain context in handler

With the default `alwaysRun: false`, known requests skip your handler
entirely. Set `alwaysRun` (see [below](#choosing-which-handlers-run)) and
`context.brain` puts the recall decision in your hands:

```typescript
import { FetchBrain, type FetchBrainContext } from "@fetchbrain.com/sdk";
import { CheerioCrawler } from "crawlee";

const crawler = FetchBrain.enhance(
  new CheerioCrawler({
    requestHandler: async (context) => {
      const { $, pushData } = context;
      // Crawlee's context types don't declare `brain`; FetchBrainContext describes it
      const brain = (context as { brain?: FetchBrainContext }).brain;
      if (brain?.known) {
        // Option 1: push the remembered data and skip scraping
        await brain.use();
        return;
      }
      await pushData({ title: $("h1").text() }); // scrape + learn
    },
  }),
  { apiKey: process.env.FETCHBRAIN_API_KEY, alwaysRun: true },
);
```

Or compare what the brain remembers with what the page says now:

```typescript
requestHandler: async (context) => {
  const { $, pushData } = context;
  const brain = (context as { brain?: FetchBrainContext }).brain;
  const scraped = { title: $("h1").text() };
  if (brain?.known) {
    console.log("Remembered:", brain.data, "Scraped:", scraped);
  }
  await pushData(scraped); // learned only if the request was unknown
},
```

### `context.brain` properties

| Property | Type | Description |
| --- | --- | --- |
| `known` | `boolean` | whether the brain knows this request |
| `data` | `object` | the remembered data (if known) |
| `use()` | `function` | push the remembered data and skip scraping |

## Configuration options

```typescript
interface FetchBrainConfig {
  // Required
  apiKey: string;

  // Optional
  baseUrl?: string; // API URL (default: https://api.fetchbrain.com)
  memory?: MemoryDepth; // How far back the brain recalls (default: "recent")
  learning?: boolean; // Teach the brain from scraped data (default: true)
  alwaysRun?: boolean | string | string[]; // Handlers that still run when a request is known (default: false)
  skipLabels?: string[]; // Labels that bypass FetchBrain entirely (default: none)
  preRecall?: boolean; // Recall requests in bulk as they're enqueued (default: true)
  onRecalled?: (event: RecalledEvent) => void | Promise<void>; // Per-record hook when recalled data is delivered
  extractForLearning?: (data: unknown) => Record<string, unknown>; // Transform each record before it is learned
  refreshOnRebuild?: boolean; // Scope learn, recall and ask to the current build (*_BUILD_ID env var) (default: false)
  timeout?: number; // Handler-time recall, stats and telemetry timeout in ms (default: 500)
  batch?: { maxSize?: number; maxWait?: number }; // Request batching (default: 50 items / 50ms)
  circuitBreaker?: {
    failureThreshold?: number; // Failures before the circuit opens (default: 3)
    resetTimeout?: number; // ms before a retry is allowed (default: 30000)
    successThreshold?: number; // Successes to close it again (default: 1)
  };
  telemetry?: TelemetryConfig; // Opt-in telemetry (default: { enabled: false })
  learnUrlField?: string; // Accepted but not currently applied
  debug?: boolean; // Enable debug logging (default: false)
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
  pre-recalled (they still get handler-time recall, but the fetch has
  already happened). Inside a handler, enqueue follow-ups through the
  crawler to keep the benefit:

  ```typescript
  requestHandler: async ({ $, request, crawler }) => {
    const urls = $("a.product")
      .map((_, a) => new URL($(a).attr("href") ?? "", request.url).href)
      .get();
    await crawler.addRequests(urls.map((url) => ({ url, label: "product" })));
  },
  ```
- **Metering** — known recalls are counted at enqueue time, so a known
  duplicate that the queue later drops still counts.
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
in that handler (metrics, counters, follow-up enqueues). `onRecalled`
runs once per recalled record with `{ url, label, userData, data }` — both
when the handler is auto-skipped and when your own handler calls
`context.brain.use()`:

```typescript
const recalledByLabel = new Map<string, number>();

FetchBrain.enhance(crawler, {
  apiKey: process.env.FETCHBRAIN_API_KEY,
  onRecalled: ({ label = "default" }) => {
    recalledByLabel.set(label, (recalledByLabel.get(label) ?? 0) + 1);
  },
});
```

Hook errors are swallowed (logged at debug) — they never break the crawl.

### Choosing which handlers run

Fine-grained routing control with `alwaysRun` — run every handler, none, or
only specific labels when a request is known:

```typescript
FetchBrain.enhance(crawler, {
  apiKey: process.env.FETCHBRAIN_API_KEY,
  alwaysRun: ["listing", "category"],
});
```

For dynamic requests that must always run live and aren't worth remembering
(search results, pagination), use `skipLabels` instead: where `alwaysRun`
still recalls (and can learn), `skipLabels` bypasses FetchBrain entirely —
no recall round-trip, no learn, no telemetry — so those requests run at
native speed:

```typescript
FetchBrain.enhance(crawler, {
  apiKey: process.env.FETCHBRAIN_API_KEY,
  skipLabels: ["search", "pagination"],
});
```

## Ask your brain anything

`ask()` answers from what's been learned — one question, no exact URLs, no
warehouse. From the SDK it uses the same scope as recall (see
[Do my scrapers share memory?](#do-my-scrapers-share-memory)); Ask Your Brain
in the dashboard answers across your whole account:

```typescript
import { FetchBrainClient } from "@fetchbrain.com/sdk";

const client = new FetchBrainClient({ apiKey: process.env.FETCHBRAIN_API_KEY });
const res = await client.ask("blue widgets under $50", { answer: true });

console.log(res.answer);   // synthesized answer
console.log(res.sources);  // scored sources
```

Pick the model that writes the answer with `model` — the default is
`"llama-3.3-70b"`, included on every plan. Premium models like
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

## Learning with `Dataset.pushData`

> **Important:** the brain learns only from `context.pushData()` or the
> SDK's `pushData()` wrapper below. Data written with `Dataset.pushData()`
> directly is not learned, so those requests stay unknown on future runs.

If you write with `Dataset.pushData()` instead of `context.pushData()`, use
the wrapper so the brain learns from it:

```typescript
import { FetchBrain, pushData } from "@fetchbrain.com/sdk";
import { CheerioCrawler, Dataset } from "crawlee";

const crawler = FetchBrain.enhance(
  new CheerioCrawler({
    requestHandler: async ({ $ }) => {
      const data = { title: $("h1").text() };

      // Learned: the SDK wrapper
      await pushData(data, Dataset);

      // Learned: the wrapper with a named dataset
      await pushData(data, Dataset, "products");

      // Not learned:
      // await Dataset.pushData(data);
    },
  }),
  { apiKey: process.env.FETCHBRAIN_API_KEY },
);
```

## No Crawlee? No problem

```typescript
import { FetchBrain } from "@fetchbrain.com/sdk";

const brain = new FetchBrain({
  apiKey: process.env.FETCHBRAIN_API_KEY,
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
- **Slow** → the call times out and your crawl continues without it
- **Down** → after 3 consecutive failures the circuit opens and your scraper runs standalone
- **Recovered** → after 30 seconds the SDK tries again; on success the circuit closes and optimization resumes

Timeouts per call type:

| Call | Timeout |
| --- | --- |
| Recall in the handler (batched) | `timeout` option, default 500ms |
| Recall at enqueue (`preRecall`, bulk) | 3s per chunk of up to 100 requests |
| Learn (batched, sent in the background) | 5s |
| `ask()` | 10s |
| `stats()` and telemetry | `timeout` option, default 500ms |

A FetchBrain outage costs you *optimization*, not your crawl: SDK calls
degrade gracefully instead of throwing into it. The one deliberate
exception is [expired memory](#recall-at-enqueue-time-prerecall): a request
that skipped its fetch at enqueue and whose remembered data is gone fails
into your `failedRequestHandler` rather than disappearing silently.

## What leaves your process

Every API call (recall, learn, ask, stats, telemetry) sends these headers:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <your API key>` |
| `X-FB-SDK` | `js` |
| `X-FB-Node` | your Node.js version (e.g. `v20.11.0`) |
| `X-FB-Platform` | your OS platform (e.g. `linux`) |
| `X-FB-Env` | the value of `NODE_ENV`, if set |
| `X-FB-Context` | JSON of environment variables named `*_ID`, plus `NODE_ENV`, `REGION` and `CI` (see below) |
| `X-FB-Crawler` | the crawler class name (e.g. `CheerioCrawler`), while a request is being handled |
| `X-FB-Label` | the request's Crawlee label, while a request is being handled |

`X-FB-Context` carries your platform identifiers; the API uses
`APIFY_ACTOR_ID` from it to scope memory per Apify actor (other `*_ID`
variables do not affect scoping) and `*BUILD_ID` for `refreshOnRebuild`. It includes
every environment variable whose name ends in `_ID`, plus `NODE_ENV`,
`REGION` and `CI`, except names containing `TOKEN`, `SECRET`, `PASSWORD`,
`CREDENTIAL`, `KEY`, `AUTH` or `COOKIE`, values that look like a JWT or a
URL with embedded `user:pass`, and values over 256 characters (2 KB total).
No other environment variables are sent. If you keep something private in
a variable ending in `_ID`, it will be sent.

Recall and learn also send the request itself: the full URL (including
query string), method, `uniqueKey`, label, string POST body, your
`userData` (minus the SDK's own keys), and the request headers **except**
`Authorization`, `Cookie` and `Set-Cookie`. Recall also sends your `memory`
depth; learn also sends the record you pushed (after `extractForLearning`).

With `refreshOnRebuild`, recall, learn and `ask()` also send a build ID: the
value of the first environment variable whose name ends in `BUILD_ID`. This
value is sent as-is — it does **not** go through the name, credential or
length filters `X-FB-Context` uses.

Other headers (for example
`Proxy-Authorization` or `X-API-Key`), `userData` values and POST bodies are
forwarded as-is — keep secrets out of them on requests FetchBrain handles,
or route those requests through `skipLabels`, which sends nothing for them.

`ask()` sends your question and options. Telemetry sends nothing unless you
[opt in](#telemetry-opt-in).

## Telemetry (opt-in)

Telemetry is **off by default.** Nothing in this section is collected or
sent unless you opt in:

```typescript
FetchBrain.enhance(crawler, {
  apiKey: process.env.FETCHBRAIN_API_KEY,
  telemetry: { enabled: true },
});
```

**It's pseudonymous, not anonymous.** Entries are sent to the FetchBrain
API with your API key and the [headers above](#what-leaves-your-process),
so they're linked to your account. They're used to improve FetchBrain's
recommendations (proxy recommendations, block detection, configuration
tuning); aggregated statistics may inform recommendations for other users.

**When it's collected:** one entry per request FetchBrain handles
(`skipLabels` requests are excluded), after your handler finishes — or
whenever the request fails inside the SDK's wrapper, including failures
before your handler runs (e.g. [expired memory](#recall-at-enqueue-time-prerecall))
and on known requests. Known requests that are skipped successfully produce
no entry. A failure entry carries only the "always" fields (minus session),
`retryCount`, timing, and `blocked: true` with a `blockType` if one matches.
Entries are buffered in your process and sent in batches (every 50 entries,
every 30 seconds, and when the crawl finishes); send failures are ignored and
never affect your crawl.

**What's sent:**

| Field | Sent when | What it is |
| --- | --- | --- |
| `domain` | always | the URL's hostname, in plain text (e.g. `shop.example.com`) |
| `urlHash` | always | first 16 hex characters of an **unsalted** SHA-256 of the full URL, including the query string. Anyone with a candidate URL can compute the same hash, so it identifies URLs that are guessable. |
| `urlPattern` | always | the URL path with numeric segments, UUIDs and alphanumeric tokens of 20+ characters replaced by `*`; the query string is dropped. Everything else — slugs, usernames, words — is sent as-is (e.g. `/users/jane-doe/orders/*`). |
| `timestamp` | always | when the entry was collected |
| `crawlerType` | always | crawler class name, lowercased, without `Crawler` (e.g. `cheerio`) |
| `requestLabel` | always | the request's Crawlee label, if set |
| `sessionAge`, `sessionErrorScore` | on success, if the request has a Crawlee session | the session's usage count and error score |
| `statusCode` | `sharePerformance`, on success | HTTP status |
| `retryCount` | `sharePerformance` | Crawlee retry count |
| `responseTimeMs`, `totalTimeMs` | `sharePerformance` | time in ms from when the SDK starts handling the request (including recall) until your handler finishes or the request fails |
| `contentSize` | `sharePerformance`, on success | response body length, when the crawler exposes it |
| `blocked`, `blockType` | `shareSitePatterns` | `blocked` is true for status 403, 429 or 5xx, or when the request failed inside the SDK wrapper for any reason; `blockType` is the status code (4xx/5xx) or a category matched in the error message (`captcha`, `timeout`, `blocked`, `429` for "rate limit") — the message itself isn't sent |
| `proxyCountry`, `proxyType`, `proxySuccess` | `shareProxyInfo`, on success, if the request used a Crawlee proxy | the proxy's country code; `residential`, `mobile` or `datacenter`, guessed in your process from the proxy URL; and whether the status was below 400. The proxy URL, hostname, IP and credentials are not sent. |

**Sub-flags** — each defaults to `true` once telemetry is enabled; set one
to `false` to stop sending its fields. The "always" fields above are sent
whenever telemetry is enabled.

```typescript
telemetry: {
  enabled: true,            // default: false
  sharePerformance: false,  // default: true
  shareSitePatterns: true,  // default: true
  shareProxyInfo: false,    // default: true
}
```

**Never sent by telemetry:** the raw URL or query string, request or response
bodies, your scraped requests' headers or cookies, error messages, or proxy
URLs and IPs.

## Testing

`MockFetchBrain` ships with the SDK — seed it, run your tests, no network:

```typescript
import { MockFetchBrain } from "@fetchbrain.com/sdk/mock";

const mock = new MockFetchBrain({
  initialMemory: new Map([
    ["https://example.com/product", { title: "Known Product" }],
  ]),
});

// Use in tests
const result = await mock.recall({ url: "https://example.com/product" });
expect(result.known).toBe(true);

// Ask a natural-language question against seeded memory
const answer = await mock.ask("known product");
expect(answer.sources.length).toBeGreaterThan(0);
console.log(answer.sources);
```

`initialMemory` replaces the older `initialKnowledge` option (still
accepted, deprecated), and `getMemorySize()` replaces `getKnowledgeSize()`.

If you clone this repository, there's also a local mock **server**
(`npm run mock-server`) for running real crawlers against
`http://localhost:3456` without an API key. It isn't included in the npm
package.

## Examples

| Example | Shows |
| --- | --- |
| [`basic-cheerio`](./examples/basic-cheerio) | CheerioCrawler + FetchBrain in ~40 lines |
| [`manual-recall`](./examples/manual-recall) | recall/learn without Crawlee |
| [`with-mock`](./examples/with-mock) | unit testing with `MockFetchBrain` |

## FAQ

**Do my scrapers share memory?**
It depends on where they run. Memory is always private to your account.
- **On Apify**, each actor (`APIFY_ACTOR_ID`) has its own memory: recall and
  SDK `ask()` calls from inside an actor only see what that actor learned.
- **Everywhere else**, all scrapers using the same API key share one memory —
  scraper A can recall what scraper B learned.
- **Ask Your Brain in the dashboard** (and `ask()` calls with no platform
  context) answers across everything your account has indexed.

**What leaves my process?**
Your requests (minus `Authorization`, `Cookie` and `Set-Cookie` headers),
the data you choose to learn, your API key, and a small set of `X-FB-*`
headers including platform identifiers (env vars ending in `_ID`, plus
`NODE_ENV`/`REGION`/`CI`). The full list is in
[What leaves your process](#what-leaves-your-process). If you opt into
telemetry, the fields in [Telemetry](#telemetry-opt-in) too.

**What does learning cost?**
Nothing. Learning is always free — you pay only for known recalls.

**What if the data changed since the brain learned it?**
That's what memory depth is for: pick `fresh` (1h) for volatile data, or
set `refreshOnRebuild` to re-learn whenever you ship a new scraper build.

## Contributing

Issues and PRs welcome — see [open issues](https://github.com/fetchbrain-com/sdk/issues).
If FetchBrain saves your crawler time or money, a GitHub star helps other
scraper developers find it.

## License

MIT © [FetchBrain](https://fetchbrain.com)

---

**Need help?** [Open an issue](https://github.com/fetchbrain-com/sdk/issues) · [Read the docs](https://docs.fetchbrain.com)
