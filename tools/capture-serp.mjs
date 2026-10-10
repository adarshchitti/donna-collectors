#!/usr/bin/env node
/**
 * One-shot fixture capture: run a SERP query through the Bright Data SERP
 * zone and save the parsed-JSON body to fixtures/. Costs 1 credit per call.
 * The API key is read from the environment and never printed.
 *
 * Usage: node tools/capture-serp.mjs "<query>" <out-file>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [query, outFile] = process.argv.slice(2);
if (!query || !outFile) {
  console.error('usage: capture-serp.mjs "<query>" <out-file>');
  process.exit(2);
}
const apiKey = process.env.BRIGHTDATA_API_KEY;
const zone = process.env.BRIGHTDATA_SERP_ZONE;
if (!apiKey || !zone) {
  console.error('BRIGHTDATA_API_KEY / BRIGHTDATA_SERP_ZONE not set');
  process.exit(2);
}

const target = `https://www.google.com/search?q=${encodeURIComponent(query)}&gl=us&hl=en`;
const res = await fetch('https://api.brightdata.com/request', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ zone, url: target, format: 'raw' }),
});
const body = await res.text();
console.log(`HTTP ${res.status}, ${body.length} bytes`);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, body);
console.log(`wrote ${outFile}`);
