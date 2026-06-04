// TEMP - restock Manchester United Terrace Icons 2025
// DELETE AFTER USE
const {
  SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, SHOPIFY_LOCATION_ID,
  shopifyAdminHeaders, fetchShopifyProductsAdmin,
} = require('./_shopify-helpers.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TARGET = 'Manchester United - Maillot Terrace Icons 2025';
const SIZES = ['S', 'M', 'L', 'XL', '2XL'];

module.exports = async function handler(req, res) {
  if ((req.query?.secret || req.headers['x-sync-secret']) !== (process.env.SYNC_SECRET || 'touni-sync-2026'))
    return res.status(401).json({ error: 'Unauthorized' });

  const headers = await shopifyAdminHeaders();
  const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
  const LOC = SHOPIFY_LOCATION_ID;
  const results = { updated: [], skipped: [], failed: [] };

  const allProducts = await fetchShopifyProductsAdmin();
  const product = allProducts.find(p => p.title === TARGET);
  if (!product) return res.json({ error: `Product not found: ${TARGET}` });

  for (const variant of product.variants) {
    const size = variant.option1 || variant.title;
    if (!SIZES.includes(size)) continue;
    await sleep(600);

    const iid = variant.inventory_item_id;

    if (variant.inventory_management !== 'shopify') {
      const putRes = await fetch(`${base}/variants/${variant.id}.json`, {
        method: 'PUT', headers,
        body: JSON.stringify({ variant: { id: variant.id, inventory_management: 'shopify' } }),
      });
      await sleep(600);
      if (!putRes.ok) { results.failed.push({ size, reason: `tracking ${putRes.status}` }); continue; }

      const conRes = await fetch(`${base}/inventory_levels/connect.json`, {
        method: 'POST', headers,
        body: JSON.stringify({ location_id: LOC, inventory_item_id: iid }),
      });
      await sleep(600);
      if (!conRes.ok && conRes.status !== 422) { results.failed.push({ size, reason: `connect ${conRes.status}` }); continue; }
    }

    const levRes = await fetch(`${base}/inventory_levels.json?inventory_item_ids=${iid}&location_ids=${LOC}`, { headers });
    await sleep(600);
    const levData = await levRes.json();
    const current = levData.inventory_levels?.[0]?.available ?? 0;
    if (current >= 50) { results.skipped.push({ size, current }); continue; }

    const setRes = await fetch(`${base}/inventory_levels/set.json`, {
      method: 'POST', headers,
      body: JSON.stringify({ location_id: LOC, inventory_item_id: iid, available: 50 }),
    });
    if (setRes.ok) results.updated.push({ size, was: current });
    else results.failed.push({ size, reason: `set ${setRes.status}: ${await setRes.text()}` });
  }

  return res.json({ product: TARGET, updated: results.updated.length, skipped: results.skipped.length, failed: results.failed.length, details: results });
};
