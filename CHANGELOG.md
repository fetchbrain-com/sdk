# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (breaking)
- For a page that pushed several records, `context.brain.data` and `RecalledEvent.data`
  (`onRecalled`) are now an **array** of those records; a single-record page is still a
  plain object. The type is `LearnedData` (object or array). Code that reads fields
  directly, e.g. `brain.data.price`, needs `Array.isArray(brain.data)` first. Older SDKs
  that recall a page a newer SDK learned see the array too.

### Fixed
- Pages that push several records (listings) are now learned as all of their records and
  recalled as all of them, in order. Previously only one record per request survived.
- `pushData` no longer waits for the learn round-trip; learns are sent in the background and
  `run()` still delivers every one before it resolves (no learns lost at shutdown).
- A request whose handler throws after pushing data is no longer learned.
- Default `timeout` raised from 500ms to 1500ms. Measured recall answers are 0.2-0.5s plus
  network, so under concurrency the old value timed out healthy calls and opened the breaker.
- Account-level 4xx answers (e.g. 403 hard cap) no longer open the circuit breaker, so
  learns the API would accept still reach it. 5xx and network errors still open it.
- Seed lists over 500 requests are pre-recalled slice by slice as the crawl runs, so the
  first request starts immediately and large lists (6000+) no longer evict pre-recalled
  answers into a second, double-billed recall.
  On Crawlee older than 3.13.9 (no lazy request lists) the SDK detects this and pre-recalls
  the first 5000 requests up front instead; the rest are recalled when they run.
- A page whose data is over the API's 100KB limit is refused on its own, instead of failing
  its whole batch. The limit covers the page's records together, so the SDK warns the first time
  a page is not learned, and the run summary's `learned` counts only accepted pages.
- Background learns are capped at 3 requests in flight and a 500-entry backlog. When the API
  falls behind, request handlers wait up to 5s for room, so the crawl slows to the API's pace
  instead of growing memory without limit.
- Pre-recalled pages waiting for their requests to run are capped at 64MB as well as 5000
  pages, so large records can't exhaust a memory-limited actor.
- A 401 (API key invalid or revoked) now switches FetchBrain off for the run with one
  warning, instead of every request paying a failing round-trip. A 429 on recall pauses
  recalls for the API's `Retry-After` (30s if none, at most 5 min); the crawl continues.
- Bulk recalls are sent 90 at a time (was 100), which also works on API versions that
  failed a recall with 97+ unknown items, so the SDK and API can deploy in either order.

## [0.6.0] - 2026-11-22

### Added
- `scraper` option (or the `FETCHBRAIN_SCRAPER_ID` env var) names a scraper so it gets
  its own memory; outside Apify, unnamed scrapers keep sharing the account's default
  memory. Names are lowercased; 1-64 of `a-z 0-9 . _ -`, starting with a letter or
  digit. A valid option wins; an empty or invalid option falls back to the env var.
  Invalid names are ignored with a warning, never thrown.

### Changed
- `FETCHBRAIN_SCRAPER_ID` is now validated, normalized and always sent first in the
  context header (0.3.0-0.5.1 forwarded it raw and could drop it when many other
  `*_ID` vars were set). Requires the matching API release.
- On Apify, a scraper name replaces the actor id as the memory scope, so that actor's
  existing memory goes cold.

## [0.5.1] - 2026-11-22

### Fixed
- Hitting the monthly learning limit (or any other learn rejection) no longer trips the
  circuit breaker, so recall keeps working for the rest of the crawl. The SDK pauses
  learning until the 1st (UTC) and logs one warning; learn 429s back off learns only.
  `MockFetchBrain` gains a `learnCap` option (and the mock server `FB_MOCK_LEARN_CAP`).

### Docs
- README telemetry disclosure corrected to match the code: telemetry is pseudonymous
  (sent with your API key), the hostname is sent in plain text, the URL hash is a
  truncated unsalted SHA-256, and every field, sub-flag and default is listed. Added a
  "What leaves your process" section listing every request header and what is forwarded
  with recall/learn (only `Authorization`, `Cookie` and `Set-Cookie` headers are stripped).
- README and docs now state memory scoping accurately: per actor on Apify, shared per API key elsewhere; dashboard Ask spans the whole account.

### Added
- `MockFetchBrain`: `initialMemory` option and `getMemorySize()`. `initialKnowledge` and
  `getKnowledgeSize()` keep working and are marked `@deprecated`.

## [0.3.1] - 2026-08-02

- `refreshOnRebuild` now scopes learn, recall, and ask symmetrically. Previously, a platform
  build id (e.g. on CI) could scope stored memory while recall (and ask) read build-agnostic
  memory, causing permanent unknowns. Default behavior: memory persists across rebuilds.
- If you set `refreshOnRebuild: true`, update to this version — v0.3.0 opt-in
  scoping does not round-trip against the current API.

## [0.3.0] - 2026-07-11

Breaking release: the public API is renamed to one consistent taxonomy.
Use the migration table below to update your code.

### Changed
- `memory` config replaces `intelligence` — depths `fresh`, `recent`,
  `standard`, `deep` (default `recent`).
- `recall()` / `recallBulk()` replace `query()` / `queryBulk()`.
- `context.brain.use()` replaces `context.ai.useAIData()`.
- `stats()` returns `known` and `recallRate`.
- Telemetry is **opt-in** and consistent across all client paths (a stray
  default-on in the direct client is fixed). Enable `telemetry: { enabled:
  true }` to join the anonymized access-intelligence network (proxy
  recommendations, block early-warning); off otherwise.
- Types renamed to match (`MemoryDepth`, `RecallResult`, `Recall*`);
  `confidence` and `AIMemoryDepth` removed.
- HTTP endpoints are now `/v1/recall` and `/v1/ask` (old paths remain as
  deprecated aliases for now). Invalid `memory` values return `400`.
- Legacy per-field `X-FB-*` request headers are replaced by a single
  `X-FB-Context` header — a JSON object containing only platform-identity
  env vars (names ending in `_ID`, plus `NODE_ENV`, `REGION`, `CI`);
  nothing else ever leaves your process. Update any proxy or firewall
  rules that matched the old headers.

### Added
- `client.ask(question, options?)` — ask a natural-language question over
  everything learned; returns scored `sources` and an optional `answer`.
  Also available on `MockFetchBrain`.

### Migration

| Before                                                | After                                    |
| ----------------------------------------------------- | ---------------------------------------- |
| `intelligence: "realtime" \| "high" \| "standard" \| "deep"` | `memory: "fresh" \| "recent" \| "standard" \| "deep"` |
| `client.query()` / `client.queryBulk()`               | `client.recall()` / `client.recallBulk()` |
| `context.ai` / `useAIData()`                          | `context.brain` / `use()`                |
| `AIResult`, `IntelligenceLevel`, `Query*` types       | `RecallResult`, `MemoryDepth`, `Recall*` |
| `result.confidence`, `AIMemoryDepth`                  | removed                                  |
| `stats().recognized` / `recognitionRate`              | `stats().known` / `recallRate`           |
| `userData.fetchBrainKnown`                            | `userData.fetchBrainRecalled`            |
| legacy `X-FB-*` headers                               | `X-FB-Context` (JSON)                    |

## [0.1.0] - 2024-12-03

### Added
- Initial release
- `FetchBrain.enhance()` for CheerioCrawler
- Circuit breaker for graceful degradation
- Request batching for high-concurrency scrapers
- Mock server for local development
- `MockFetchBrain` for unit testing
- TypeScript support with full type definitions
- Examples for basic usage

### Intelligence Levels
- `realtime` - Live AI inference
- `high` - High confidence
- `standard` - Balanced mode
- `deep` - Deep knowledge
