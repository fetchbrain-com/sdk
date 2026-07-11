/**
 * Mock Testing Example
 * 
 * This example shows how to use MockFetchBrain for unit testing
 * without any network calls.
 * 
 * Run: npx tsx examples/with-mock/main.ts
 */

import { MockFetchBrain } from '../../src/mock';

async function main() {
  // Create a mock with pre-trained knowledge
  const mock = new MockFetchBrain({
    initialKnowledge: new Map([
      ['https://example.com/known', { title: 'Known Product', price: 19.99 }],
    ]),
    // Optional: simulate latency
    latency: 50,
  });

  // Seed more data
  mock.seed([
    { url: 'https://example.com/product/1', data: { title: 'Product 1', price: 9.99 } },
    { url: 'https://example.com/product/2', data: { title: 'Product 2', price: 14.99 } },
  ]);

  console.log('Knowledge base size after seeding:', mock.getKnowledgeSize());

  // Test recall
  console.log('\n=== Recall known URL ===');
  const known = await mock.recall({ url: 'https://example.com/known' });
  console.log('Result:', known);

  console.log('\n=== Recall unknown URL ===');
  const unknown = await mock.recall({ url: 'https://example.com/new-page' });
  console.log('Result:', unknown);

  console.log('\n=== Learn new data ===');
  await mock.learn({ url: 'https://example.com/new' }, { title: 'New Product' });
  console.log('Knowledge base size after learning:', mock.getKnowledgeSize());

  console.log('\n=== Recall newly learned URL ===');
  const newData = await mock.recall({ url: 'https://example.com/new' });
  console.log('Result:', newData);

  console.log('\n=== Bulk recall ===');
  const urls = [
    'https://example.com/product/1',
    'https://example.com/product/2',
    'https://example.com/product/unknown',
  ];
  const bulk = await mock.recallBulk(urls.map((url) => ({ url })));
  console.log('Bulk results:');
  bulk.forEach((result, i) => {
    console.log(`  ${urls[i]}: ${result.known ? 'KNOWN' : 'UNKNOWN'}`);
  });

  console.log('\n=== Ask a question ===');
  const answer = await mock.ask('what is the price of product 1');
  console.log('Sources:', answer.sources);

  console.log('\n=== Stats ===');
  const stats = await mock.stats();
  console.log(stats);
}

main().catch(console.error);
