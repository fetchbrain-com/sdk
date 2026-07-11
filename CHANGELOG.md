# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-11

Breaking release: the public API is renamed to one consistent taxonomy.
Use the migration table below to update your code.

### Changed
- `memory` config replaces `intelligence` — depths `fresh`, `recent`,
  `standard`, `deep` (default `recent`).
- `recall()` / `recallBulk()` replace `query()` / `queryBulk()`.
- `context.brain.use()` replaces `context.ai.useAIData()`.
- `stats()` returns `known` and `recallRate`.
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
