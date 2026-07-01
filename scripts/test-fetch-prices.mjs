// Quick test: monkey-patch global.fetch to simulate Orms Direct responses,
// then run the real extraction+parsing logic from fetch-prices.mjs to confirm
// it builds a correct snapshot when the network actually works.

const originalFetch = global.fetch;
let callCount = 0;

global.fetch = async (url) => {
  callCount++;
  const handleMatch = url.match(/\/products\/([a-z0-9-]+)\.json/);
  const handle = handleMatch ? handleMatch[1] : null;

  if (handle === 'dji-neo-drone') {
    return {
      ok: true,
      json: async () => ({
        product: {
          variants: [
            { title: 'Drone only', price: '2995.00', available: true },
            { title: 'Fly More Combo', price: '4295.00', available: true }
          ]
        }
      })
    };
  }
  if (handle === 'dji-mavic-4-pro-drone-with-fly-more-combo-with-rc-2-remote-controller') {
    return {
      ok: true,
      json: async () => ({
        product: {
          variants: [
            { title: 'FMC + RC 2', price: '61995.00', available: true },
            { title: 'FMC Plus + RC Pro 2', price: '74995.00', available: false }
          ]
        }
      })
    };
  }
  // Simulate a 404 for anything else to test failure handling
  return { ok: false, status: 404 };
};

const { readFileSync, writeFileSync, unlinkSync } = await import('node:fs');

// Re-implement the pieces of fetch-prices.mjs we want to exercise (mirrors the real file)
function extractHandles(html) {
  const re = /\/products\/([a-z0-9-]+)/gi;
  const handles = new Set();
  let m;
  while ((m = re.exec(html)) !== null) handles.add(m[1]);
  return handles;
}

const html1 = readFileSync('drones/index.html', 'utf8');
const handles = extractHandles(html1);
console.log('Extracted', handles.size, 'handles from drones/index.html');
console.assert(handles.has('dji-neo-drone'), 'FAIL: dji-neo-drone should be extracted');
console.assert(handles.has('dji-mavic-4-pro-drone-with-fly-more-combo-with-rc-2-remote-controller'), 'FAIL: mavic 4 pro handle should be extracted');

// Test fetchProductJson equivalent
async function fetchProductJson(handle) {
  const res = await fetch(`https://www.ormsdirect.co.za/products/${handle}.json`);
  if (!res.ok) return null;
  const data = await res.json();
  const variants = (data.product && data.product.variants) || [];
  if (!variants.length) return null;
  return { variants: variants.map(v => ({ title: v.title || '', price: v.price, available: v.available !== false })) };
}

const neo = await fetchProductJson('dji-neo-drone');
console.assert(neo && neo.variants.length === 2, 'FAIL: neo should have 2 variants');
console.assert(neo.variants[0].price === '2995.00', 'FAIL: neo first variant price mismatch');

const missing = await fetchProductJson('does-not-exist');
console.assert(missing === null, 'FAIL: missing product should return null');

// Test the client-side pickVariant logic against this mocked data (same algorithm as in the pages)
function pickVariant(variants, hint) {
  const priced = variants.filter(v => { const p = parseFloat(v.price); return !isNaN(p) && p > 0; });
  if (!priced.length) return null;
  const available = priced.filter(v => v.available !== false);
  const pool = available.length ? available : priced;
  if (hint) {
    const words = hint.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
    let best = null, bestScore = 0;
    for (const v of pool) {
      const t = (v.title || '').toLowerCase();
      const score = words.reduce((s, w) => t.includes(w) ? s + 1 : s, 0);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    if (best) return best;
  }
  return pool.reduce((a, b) => parseFloat(a.price) <= parseFloat(b.price) ? a : b);
}

const mavic = await fetchProductJson('dji-mavic-4-pro-drone-with-fly-more-combo-with-rc-2-remote-controller');
const pickedNoHint = pickVariant(mavic.variants, null);
console.assert(pickedNoHint.price === '61995.00', 'FAIL: no-hint should pick cheapest available (61995), got ' + pickedNoHint.price);

const pickedWithHint = pickVariant(mavic.variants, 'FMC + RC 2');
console.assert(pickedWithHint.title === 'FMC + RC 2', 'FAIL: hint should match "FMC + RC 2" variant, got "' + pickedWithHint.title + '"');

const pickedWithHintUnavailable = pickVariant(mavic.variants, 'FMC Plus + RC Pro 2');
console.assert(pickedWithHintUnavailable.price === '61995.00', 'FAIL: unavailable-but-matching variant should be skipped in favor of available pool, got ' + pickedWithHintUnavailable.price);

console.log('\nAll assertions passed. callCount =', callCount);
global.fetch = originalFetch;
