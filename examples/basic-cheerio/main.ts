/**
 * Basic CheerioCrawler Example
 * 
 * This example shows how to enhance a CheerioCrawler with FetchBrain
 * for AI-powered optimization.
 * 
 * Run: npx tsx examples/basic-cheerio/main.ts
 * 
 * Note: Start the mock server first with: npm run mock-server
 */

import { CheerioCrawler, Dataset } from 'crawlee';
import { FetchBrain } from '../../src';

// URLs to scrape
const urls = [
  'https://example.com/product/1',
  'https://example.com/product/2',
  'https://example.com/product/3',
];

async function main() {
  // Create a CheerioCrawler with FetchBrain enhancement
  const crawler = FetchBrain.enhance(
    new CheerioCrawler({
      requestHandler: async ({ $, request }) => {
        // This only runs when the AI needs to learn
        // (AI doesn't know this page yet)
        
        console.log(`[Scraping] ${request.url}`);
        
        const data = {
          url: request.url,
          title: $('title').text() || 'Example Domain',
          heading: $('h1').text() || 'Example',
          scrapedAt: new Date().toISOString(),
        };
        
        // pushData is intercepted - FetchBrain will "learn" this data
        await Dataset.pushData(data);
      },
    }),
    {
      // Use mock server for local testing
      apiKey: 'test_demo_key',
      baseUrl: 'http://localhost:3456',
      
      // High confidence AI responses
      intelligence: 'high',
      
      // Enable AI learning
      learning: true,
      
      // Enable debug logging
      debug: true,
    }
  );

  console.log('\n=== First Run ===');
  console.log('All requests will need AI learning (new pages)\n');
  await crawler.run(urls);

  console.log('\n=== Second Run ===');
  console.log('All requests should use AI knowledge (instant)\n');
  await crawler.run(urls);

  // Get stats from the client
  const stats = await crawler.fetchBrain.stats();
  console.log('\n=== Stats ===');
  console.log(stats);
}

main().catch(console.error);
