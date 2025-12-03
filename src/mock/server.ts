/**
 * Mock FetchBrain API Server
 * 
 * Local development server that simulates the FetchBrain API.
 * Useful for testing the SDK without connecting to production.
 * 
 * Run: npm run mock-server
 */

import express from 'express';
import type { 
  QueryRequest, 
  QueryResponse, 
  LearnRequest, 
  LearnResponse,
  StatsResponse,
} from '../types';

const app = express();
app.use(express.json());

// AI knowledge base
const knowledge = new Map<string, { data: Record<string, unknown>; learnedAt: string }>();

// Stats tracking
const stats = {
  queries: 0,
  recognized: 0,
  learned: 0,
};

/**
 * Authentication middleware
 */
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid API key' });
  }
  
  const apiKey = authHeader.slice(7);
  
  // Accept any key starting with 'test_' or 'fb_' for development
  if (!apiKey.startsWith('test_') && !apiKey.startsWith('fb_')) {
    return res.status(401).json({ error: 'Invalid API key format' });
  }
  
  next();
});

/**
 * POST /v1/query - Check if AI knows the URL
 */
app.post('/v1/query', (req, res) => {
  const body = req.body as QueryRequest;
  const { urls } = body;
  
  if (!urls || !Array.isArray(urls)) {
    return res.status(400).json({ error: 'urls array is required' });
  }
  
  stats.queries += urls.length;
  
  const known: QueryResponse['known'] = [];
  const unknown: string[] = [];
  
  for (const url of urls) {
    const aiKnowledge = knowledge.get(url);
    
    if (aiKnowledge) {
      stats.recognized++;
      known.push({
        url,
        known: true,
        data: aiKnowledge.data,
        confidence: 0.95 + Math.random() * 0.04, // 0.95-0.99
        learnedAt: aiKnowledge.learnedAt,
      });
    } else {
      unknown.push(url);
    }
  }
  
  const response: QueryResponse = { known, unknown };
  
  console.log(`[Query] ${urls.length} URLs → ${known.length} recognized, ${unknown.length} new`);
  
  res.json(response);
});

/**
 * POST /v1/learn - Teach AI new data
 */
app.post('/v1/learn', (req, res) => {
  const body = req.body as LearnRequest;
  const { entries } = body;
  
  if (!entries || !Array.isArray(entries)) {
    return res.status(400).json({ error: 'entries array is required' });
  }
  
  let learned = 0;
  
  for (const entry of entries) {
    if (entry.url && entry.data) {
      knowledge.set(entry.url, {
        data: entry.data,
        learnedAt: new Date().toISOString(),
      });
      learned++;
      stats.learned++;
    }
  }
  
  const response: LearnResponse = {
    status: 'accepted',
    learned,
    verification: {
      schemaValid: true,
      valuesValid: true,
      duplicate: false,
      warnings: [],
    },
  };
  
  console.log(`[Learn] AI learned ${learned} entries`);
  
  res.json(response);
});

/**
 * GET /v1/stats - Usage statistics
 */
app.get('/v1/stats', (req, res) => {
  const response: StatsResponse = {
    queries: stats.queries,
    recognized: stats.recognized,
    recognitionRate: stats.queries > 0 ? stats.recognized / stats.queries : 0,
    learned: stats.learned,
    period: new Date().toISOString().slice(0, 7), // YYYY-MM
  };
  
  res.json(response);
});

/**
 * GET /health - Health check
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    knowledgeSize: knowledge.size,
    stats,
  });
});

/**
 * POST /reset - Reset knowledge and stats (testing only)
 */
app.post('/reset', (req, res) => {
  knowledge.clear();
  stats.queries = 0;
  stats.recognized = 0;
  stats.learned = 0;
  
  console.log('[Reset] AI knowledge and stats cleared');
  
  res.json({ status: 'reset' });
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
║     POST /v1/query  - Ask AI (query)                          ║
║     POST /v1/learn  - Teach AI (learn)                        ║
║     GET  /v1/stats  - Usage statistics                        ║
║     GET  /health    - Health check                            ║
║     POST /reset     - Reset AI (testing)                      ║
║                                                               ║
║   Auth: Use API key starting with 'test_' or 'fb_'            ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

export { app };
