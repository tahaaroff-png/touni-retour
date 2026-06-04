// TEMP - restock 19 variants Brésil + Allemagne (using _shopify-helpers auth)
// DELETE AFTER USE
const {
  SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, SHOPIFY_LOCATION_ID,
  shopifyAdminHeaders, fetchShopifyProductsAdmin,
} = require('./_shopify-helpers.js');

// Only the 5 exact products that were failing (original 19 variants)
const TARGET_EXACT = [
  'Brésil - Maillot Domicile 2024/25',
  'Brésil - Maillot Domicile Manches Longues 2025/26',
  'Maillot Brésil Domicile 1998 – Version Rétro',
  'Allemagne - Maillot Domicile 2026',
  'Maillot Domicile Allemagne 26 Manches Longues Blanc',
];
const TARGET_SIZES = ['S', 'M', 'L', 'XL', '2XL'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async function handler(req, res) {
  const secret = req.query?.secret || req.headers['x-sync-secret'];
  if (secret !== (process.env.SYNC_SECRET || 'touni-sync-2026')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const headers = await shopifyAdminHeaders();
  const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
  const LOC = SHOPIFY_LOCATION_ID;

  const results = { updated: [], skipped: [], failed: [] };

  // Fetch all products and filter only the 5 exact failing products
  const allProducts = await fetchShopifyProductsAdmin();
  const relevant = allProducts.filter(p =>
    TARGET_EXACT.some(t => p.title.trim() === t)
  );

  for (const product of relevant) {
    for (const variant of product.variants) {
      const size = variant.option1 || variant.title;
      if (!TARGET_SIZES.includes(size)) continue;

      const iid = variant.inventory_item_id;

      await sleep(600); // stay under 2 calls/sec

      // Step 1: enable tracking if needed
      if (variant.inventory_management !== 'shopify') {
        const putRes = await fetch(`${base}/variants/${variant.id}.json`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ variant: { id: variant.id, inventory_management: 'shopify' } }),
        });
        await sleep(600);
        if (!putRes.ok) {
          results.failed.push({ product: product.title, size, reason: `enable_tracking ${putRes.status}: ${await putRes.text()}` });
          continue;
        }
        // Connect to location
        const conRes = await fetch(`${base}/inventory_levels/connect.json`, {
          method: 'POST', headers,
          body: JSON.stringify({ location_id: LOC, inventory_item_id: iid }),
        });
        await sleep(600);
        if (!conRes.ok && conRes.status !== 422) { // 422 = already connected
          results.failed.push({ product: product.title, size, reason: `connect ${conRes.status}: ${await conRes.text()}` });
          continue;
        }
      }

      // Step 2: check current stock
      const levRes = await fetch(
        `${base}/inventory_levels.json?inventory_item_ids=${iid}&location_ids=${LOC}`,
        { headers }
      );
      await sleep(600);
      const levData = await levRes.json();
      const current = levData.inventory_levels?.[0]?.available ?? 0;
      if (current >= 50) {
        results.skipped.push({ product: product.title, size, current });
        continue;
      }

      // Step 3: set to 50
      const setRes = await fetch(`${base}/inventory_levels/set.json`, {
        method: 'POST', headers,
        body: JSON.stringify({ location_id: LOC, inventory_item_id: iid, available: 50 }),
      });
      if (setRes.ok) {
        results.updated.push({ product: product.title, size, was: current });
      } else {
        const body = await setRes.text();
        results.failed.push({ product: product.title, size, reason: `set ${setRes.status}: ${body}` });
      }
    }
  }

  return res.json({
    products_found: relevant.map(p => p.title),
    updated: results.updated.length,
    skipped: results.skipped.length,
    failed: results.failed.length,
    details: results,
  });
};
