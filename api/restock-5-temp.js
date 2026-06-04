// TEMPORARY — Restock 5 identified products to 50 units per variant
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  SHOPIFY_LOCATION_ID: _LOC,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

// Keywords to identify each of the 5 jerseys
// Each entry: array of terms that must ALL appear in the title (case-insensitive)
const TARGETS = [
  { label: 'Real Madrid Rétro Extérieur',       keywords: ['real madrid', 'rétro'] },
  { label: 'Manchester United Rétro Extérieur',  keywords: ['manchester', 'rétro'] },
  { label: 'FC Barcelone Domicile 2024/25',       keywords: ['barcelon', 'domicile', '2024'] },
  { label: 'Japon x Dragon Ball',                keywords: ['japon', 'dragon'] },
  { label: 'Santos FC Domicile',                 keywords: ['santos'] },
];

function matches(title, keywords) {
  const t = title.toLowerCase();
  return keywords.every(k => t.includes(k));
}

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  try {
    const hdrs = await shopifyAdminHeaders();

    // ── 1. Fetch all products (paginated) ──────────────────────────────
    const allProducts = [];
    let url = `https://${_SD}/admin/api/${_SV}/products.json?status=active&limit=250&fields=id,title,variants`;
    while (url) {
      const r = await fetch(url, { headers: hdrs });
      if (!r.ok) throw new Error(`Products fetch ${r.status}: ${await r.text()}`);
      const data = await r.json();
      allProducts.push(...(data.products || []));
      const link = r.headers.get('link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    // ── 2. Match products ──────────────────────────────────────────────
    const matched = [];
    for (const target of TARGETS) {
      const found = allProducts.filter(p => matches(p.title, target.keywords));
      matched.push({ label: target.label, keywords: target.keywords, found: found.map(p => ({ id: p.id, title: p.title, variant_count: p.variants.length })) });
    }

    // ── 3. Get location ID ─────────────────────────────────────────────
    let locationId = _LOC;
    if (!locationId) {
      const lr = await fetch(`https://${_SD}/admin/api/${_SV}/locations.json`, { headers: hdrs });
      const ld = await lr.json();
      locationId = (ld.locations || [])[0]?.id?.toString();
    }

    if (!locationId) throw new Error('No location found');

    // ── 4. Set inventory to 50 for all matched variants ────────────────
    const updateResults = [];
    for (const group of matched) {
      for (const product of group.found) {
        // Get full variant data
        const pr = await fetch(
          `https://${_SD}/admin/api/${_SV}/products/${product.id}.json?fields=id,title,variants`,
          { headers: hdrs }
        );
        const pd = await pr.json();
        const variants = pd.product?.variants || [];

        for (const v of variants) {
          if (v.inventory_management !== 'shopify') continue;

          // Get current inventory level
          const ilr = await fetch(
            `https://${_SD}/admin/api/${_SV}/inventory_levels.json?inventory_item_ids=${v.inventory_item_id}&location_ids=${locationId}`,
            { headers: hdrs }
          );
          const ild = await ilr.json();
          const level = (ild.inventory_levels || [])[0];

          if (!level) {
            // Connect first
            await fetch(`https://${_SD}/admin/api/${_SV}/inventory_levels/connect.json`, {
              method: 'POST',
              headers: { ...hdrs, 'Content-Type': 'application/json' },
              body: JSON.stringify({ location_id: parseInt(locationId), inventory_item_id: v.inventory_item_id }),
            });
          }

          // Set to 50
          const sr = await fetch(`https://${_SD}/admin/api/${_SV}/inventory_levels/set.json`, {
            method: 'POST',
            headers: { ...hdrs, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              location_id: parseInt(locationId),
              inventory_item_id: v.inventory_item_id,
              available: 50,
            }),
          });
          const sd = await sr.json();

          updateResults.push({
            product: product.title,
            variant: v.title,
            ok: sr.ok,
            new_qty: sd.inventory_level?.available,
          });
        }
      }
    }

    res.json({
      ok: true,
      location_id: locationId,
      products_matched: matched,
      variants_updated: updateResults,
      summary: `${updateResults.filter(r => r.ok).length}/${updateResults.length} variants set to 50`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
