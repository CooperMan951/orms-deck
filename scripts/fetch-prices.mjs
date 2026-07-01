// scripts/fetch-prices.mjs
// Runs server-side (GitHub Actions) where there's no browser CORS restriction.
// Extracts every /products/<handle> URL referenced in drones/index.html and
// gimbals/index.html, fetches each product's Shopify JSON from Orms Direct,
// and writes a combined snapshot to prices-snapshot.json at the repo root.
//
// This snapshot acts as a reliable daily fallback layer for the client-side
// pages, in case a visitor's browser is ever blocked from fetching
// ormsdirect.co.za directly (e.g. future CORS policy changes).

import { readFileSync, writeFileSync } from 'node:fs';

const ORIGIN = 'https://www.ormsdirect.co.za';
const SOURCE_FILES = ['drones/index.html', 'gimbals/index.html'];
const OUT_FILE = 'prices-snapshot.json';

function extractHandles(html) {
  const re = /\/products\/([a-z0-9-]+)/gi;
  const handles = new Set();
  let m;
  while ((m = re.exec(html)) !== null) handles.add(m[1]);
  return handles;
}

async function fetchProductJson(handle) {
  const url = `${ORIGIN}/products/${handle}.json?_=${Date.now()}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'orms-deck-price-sync/1.0' } });
  if (!res.ok) {
    console.warn(`  ✗ ${handle} — HTTP ${res.status}`);
    return null;
  }
  const data = await res.json();
  const variants = (data.product && data.product.variants) || [];
  if (!variants.length) {
    console.warn(`  ✗ ${handle} — no variants in response`);
    return null;
  }
  return {
    variants: variants.map(v => ({
      title: v.title || '',
      price: v.price,
      available: v.available !== false
    }))
  };
}

async function main() {
  const allHandles = new Set();
  for (const file of SOURCE_FILES) {
    const html = readFileSync(file, 'utf8');
    for (const h of extractHandles(html)) allHandles.add(h);
  }

  console.log(`Found ${allHandles.size} unique product handles across ${SOURCE_FILES.join(', ')}`);

  const products = {};
  let ok = 0, failed = 0;

  // Fetch with light concurrency to be a polite citizen of Orms' server.
  const handleList = [...allHandles];
  const CONCURRENCY = 5;
  for (let i = 0; i < handleList.length; i += CONCURRENCY) {
    const batch = handleList.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async h => {
      try {
        const entry = await fetchProductJson(h);
        return [h, entry];
      } catch (e) {
        console.warn(`  ✗ ${h} — ${e.message}`);
        return [h, null];
      }
    }));
    for (const [h, entry] of results) {
      if (entry) { products[h] = entry; ok++; }
      else { failed++; }
    }
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: ORIGIN,
    ok,
    failed,
    products
  };

  writeFileSync(OUT_FILE, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`\nWrote ${OUT_FILE}: ${ok} products synced, ${failed} failed.`);

  if (ok === 0) {
    console.error('No products synced successfully — failing the run so it is visible.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
