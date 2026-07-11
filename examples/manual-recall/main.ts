/**
 * Manual Recall Example
 *
 * This example shows how to use FetchBrain directly without
 * wrapping a crawler - useful for custom integrations.
 *
 * Run: npx tsx examples/manual-recall/main.ts
 *
 * Note: Start the mock server first with: npm run mock-server
 */

import { FetchBrain } from '../../src';

async function main() {
  // Create a standalone FetchBrain client
  const brain = new FetchBrain({
    apiKey: 'test_demo_key',
    baseUrl: 'http://localhost:3456',
    memory: 'recent',
    learning: true,
    debug: true,
  });

  const testUrl = 'https://example.com/product/manual-test';

  // First recall - brain doesn't know yet
  console.log('\n=== First Recall (brain learning) ===');
  const result1 = await brain.recall({ url: testUrl });
  console.log('Known:', result1.known);
  console.log('Data:', result1.data);

  // Teach the brain some data
  console.log('\n=== Teaching brain ===');
  const learnResult = await brain.learn({
    url: testUrl,
    data: {
      title: 'Test Product',
      price: 29.99,
      currency: 'USD',
      inStock: true,
    },
  });
  console.log('Learn result:', learnResult);

  // Second recall - brain knows now
  console.log('\n=== Second Recall (brain knows) ===');
  const result2 = await brain.recall({ url: testUrl });
  console.log('Known:', result2.known);
  console.log('Data:', result2.data);

  // Get stats
  console.log('\n=== Stats ===');
  const stats = await brain.stats();
  console.log(stats);
}

main().catch(console.error);
