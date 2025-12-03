/**
 * Manual Query Example
 * 
 * This example shows how to use FetchBrain directly without
 * wrapping a crawler - useful for custom integrations.
 * 
 * Run: npx tsx examples/manual-query/main.ts
 * 
 * Note: Start the mock server first with: npm run mock-server
 */

import { FetchBrain } from '../../src';

async function main() {
  // Create a standalone FetchBrain client
  const ai = new FetchBrain({
    apiKey: 'test_demo_key',
    baseUrl: 'http://localhost:3456',
    intelligence: 'high',
    learning: true,
    debug: true,
  });

  const testUrl = 'https://example.com/product/manual-test';

  // First query - AI doesn't know yet
  console.log('\n=== First Query (AI learning) ===');
  const result1 = await ai.query({ url: testUrl });
  console.log('Known:', result1.known);
  console.log('Data:', result1.data);

  // Teach the AI some data
  console.log('\n=== Teaching AI ===');
  const learnResult = await ai.learn({
    url: testUrl,
    data: {
      title: 'Test Product',
      price: 29.99,
      currency: 'USD',
      inStock: true,
    },
  });
  console.log('Learn result:', learnResult);

  // Second query - AI knows now
  console.log('\n=== Second Query (AI knows) ===');
  const result2 = await ai.query({ url: testUrl });
  console.log('Known:', result2.known);
  console.log('Data:', result2.data);
  console.log('Confidence:', result2.confidence);
  console.log('Learned at:', result2.learnedAt);

  // Get stats
  console.log('\n=== Stats ===');
  const stats = await ai.stats();
  console.log(stats);
}

main().catch(console.error);
