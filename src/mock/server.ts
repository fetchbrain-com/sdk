/**
 * Mock FetchBrain API Server
 *
 * Local development server that simulates the FetchBrain API.
 * Useful for testing the SDK without connecting to production.
 *
 * Run: npm run mock-server
 */

import express from "express";
import { deriveIdentity } from "./derive-identity";
import type {
  RecallRequest,
  RecallResponse,
  LearnRequest,
  LearnResponse,
  StatsResponse,
  AskResponse,
  MemoryDepth,
} from "../types";

const app = express();
app.use(express.json());

const ALL_MEMORY_DEPTHS: MemoryDepth[] = ["fresh", "recent", "standard", "deep"];

// Remembered data (the brain's memory)
const knowledge = new Map<
  string,
  { url: string; data: Record<string, unknown>; learnedAt: string }
>();

// Stats tracking
const stats = {
  queries: 0,
  known: 0,
  learned: 0,
};

/**
 * Authentication middleware
 */
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid API key" });
  }

  const apiKey = authHeader.slice(7);

  // Accept any key starting with 'test_' or 'fb_' for development
  if (!apiKey.startsWith("test_") && !apiKey.startsWith("fb_")) {
    return res.status(401).json({ error: "Invalid API key format" });
  }

  next();
});

/**
 * POST /v1/recall - Check if the brain knows the items
 * (POST /v1/query is kept as an alias, mirroring the real API's alias window)
 */
const handleRecall: express.RequestHandler = (req, res) => {
  const body = req.body as RecallRequest;
  const items = body.items;

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: "items array is required" });
  }

  if (body.memory !== undefined && !ALL_MEMORY_DEPTHS.includes(body.memory)) {
    return res.status(400).json({ error: `Invalid memory depth: ${body.memory}` });
  }

  stats.queries += items.length;

  const known: RecallResponse["known"] = [];
  const unknown: string[] = [];

  for (const item of items) {
    const k = knowledge.get(deriveIdentity(item.request));
    if (k) {
      stats.known++;
      known.push({ ref: item.ref, data: k.data });
    } else {
      unknown.push(item.ref);
    }
  }

  console.log(
    `[Recall] ${items.length} items → ${known.length} known, ${unknown.length} new`
  );

  res.json({ known, unknown } satisfies RecallResponse);
};

app.post("/v1/recall", handleRecall);
app.post("/v1/query", handleRecall); // deprecated alias

/**
 * POST /v1/ask - Naive natural-language ask against learned knowledge.
 * Substring-matches the query's words against stored data. When `answer`
 * is truthy, also returns a canned `answer` string built from the top
 * source — it is NOT a real synthesized answer, just enough of the shape
 * for callers to test against.
 */
app.post("/v1/ask", (req, res) => {
  const body = req.body as {
    query?: unknown;
    limit?: unknown;
    answer?: unknown;
    model?: unknown;
  };
  const query = body.query;

  if (typeof query !== "string" || query.trim() === "") {
    return res.status(400).json({ error: "query string is required" });
  }

  const limit =
    typeof body.limit === "number" ? body.limit : undefined;
  const cap = Math.min(Math.max(1, limit ?? 10), 20);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const sources = [...knowledge.values()]
    .map((entry) => {
      const haystack = JSON.stringify(entry.data).toLowerCase();
      const score =
        words.filter((w) => haystack.includes(w)).length /
        Math.max(words.length, 1);
      return { score, url: entry.url, data: entry.data };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap);

  console.log(`[Ask] query matched ${sources.length} sources`);

  const response: AskResponse = { sources, status: "ok" };
  if (body.answer) {
    response.answer =
      sources.length > 0
        ? `Based on ${sources.length} remembered page${sources.length === 1 ? "" : "s"}: ${JSON.stringify(sources[0].data)}`
        : "Nothing remembered yet for that question.";
    // Echo the requested model slug like the real API reports what it used.
    response.model = typeof body.model === "string" ? body.model : "llama-3.3-70b";
  }

  res.json(response);
});

/**
 * POST /v1/learn - Teach AI new data
 */
app.post("/v1/learn", (req, res) => {
  const body = req.body as LearnRequest;
  const entries = body.entries;

  if (!entries || !Array.isArray(entries)) {
    return res.status(400).json({ error: "entries array is required" });
  }

  let learned = 0;

  for (const entry of entries) {
    if (entry.request?.url && entry.data) {
      knowledge.set(deriveIdentity(entry.request), {
        url: entry.request.url,
        data: entry.data,
        learnedAt: new Date().toISOString(),
      });
      learned++;
      stats.learned++;
    }
  }

  res.status(201).json({ learned, status: "success" } satisfies LearnResponse);

  console.log(`[Learn] brain learned ${learned} entries`);
});

/**
 * GET /v1/stats - Usage statistics
 */
app.get("/v1/stats", (req, res) => {
  const response: StatsResponse = {
    queries: stats.queries,
    known: stats.known,
    recallRate: stats.queries > 0 ? stats.known / stats.queries : 0,
    learned: stats.learned,
    period: new Date().toISOString().slice(0, 7), // YYYY-MM
  };

  res.json(response);
});

/**
 * GET /health - Health check
 */
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    knowledgeSize: knowledge.size,
    stats,
  });
});

/**
 * POST /reset - Reset knowledge and stats (testing only)
 */
app.post("/reset", (req, res) => {
  knowledge.clear();
  stats.queries = 0;
  stats.known = 0;
  stats.learned = 0;

  console.log("[Reset] memory and stats cleared");

  res.json({ status: "reset" });
});

// Start server
const PORT = process.env.PORT || 3456;

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                   FetchBrain Mock Server                      ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║   Running at: http://localhost:${PORT}                          ║
║                                                               ║
║   Endpoints:                                                  ║
║     POST /v1/recall - Recall from the brain                   ║
║     POST /v1/query  - Deprecated alias for /v1/recall         ║
║     POST /v1/ask    - Ask the brain a question                ║
║     POST /v1/learn  - Teach the brain (learn)                 ║
║     GET  /v1/stats  - Usage statistics                        ║
║     GET  /health    - Health check                            ║
║     POST /reset     - Reset the brain (testing)               ║
║                                                               ║
║   Auth: Use API key starting with 'test_' or 'fb_'            ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

export { app };
