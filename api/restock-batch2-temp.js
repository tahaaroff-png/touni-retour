// TEMPORARY — Restock batch 2 (5 products) to 50 per variant
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  SHOPIFY_LOCATION_ID: _LOC,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

const TARGETS = [
  { label: 'PSG Extérieur 2024/25',             keywords: ['paris', 'extérieur'] },
  { label: 'Manchester United Rétro Domicile',   keywords: ['manchester', 'rétro', 'domicile'] },
  { label: 'Angleterre Domicile',                keywords: ['angleterre', 'domicile'] },
  { label: 'Italie Domicile',                    keywords: ['itali', 'domicile'] },
  { label: 'Brésil Domicile',                    keywords: ['brésil', 'domicile'] },
  { label: 'Allemagne Extérieur 2024 Rose',      keywords: ['allemagne', 'extérieur'] },
  { label: 'Allemagne Domicile Euro 2024',       keywords: ['allemagne', 'domicile'] },
];

function matches(title, keywords) {
  const t = title.toLowerCase();
  return keywords.every(k => t.includes(k));
}

async function setStock(hdrs, locationId, inventoryItemId, qty) {
  const r = await fetch(`https://${_SD}/admin/api/${_SV}/inventory_levels/set.json`, {
    method: 'POST',
    headers: { ...hdrs, 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: parseInt(locationId), inventory_item_id: inventoryItemId, available: qty }),
  });
  if (r.ok) return await r.json();
  // Connect then retry
  await fetch(`https://${_SD}/admin/api/${_SV}/inventory_levels/connect.json`, {
    method: 'POST',
    headers: { ...hdrs, 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: parseInt(locationId), inventory_item_id: inventoryItemId }),
  });
  const r2 = await fetch(`https://${_SD}/admin/api/${_SV}/inventory_levels/set.json`, {
    method: 'POST',
    headers: { ...hdrs, 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: parseInt(locationId), inventory_item_id: inventoryItemId, available: qty }),
  });
  return await r2.json();
}

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  try {
    const hdrs = await shopifyAdminHeaders();

    // Location
    let locationId = _LOC;
    if (!locationId) {
      const lr = await fetch(`https://${_SD}/admin/api/${_SV}/locations.json`, { headers: hdrs });
      const ld = await lr.json();
      locationId = (ld.locations || [])[0]?.id?.toString();
    }

    // Fetch all products
    const allProducts = [];
    let url = `https://${_SD}/admin/api/${_SV}/products.json?status=active&limit=250&fields=id,title,variants`;
    while (url) {
      const r = await fetch(url, { headers: hdrs });
      const d = await r.json();
      allProducts.push(...(d.products || []));
      const link = r.headers.get('link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    const matched = [];
    for (const target of TARGETS) {
      const found = allProducts.filter(p => matches(p.title, target.keywords));
      matched.push({ label: target.label, found: found.map(p => ({ id: p.id, title: p.title })) });
    }

    const updates = [];
    for (const group of matched) {
      for (const p of group.found) {
        const pr = await fetch(`https://${_SD}/admin/api/${_SV}/products/${p.id}.json?fields=id,title,variants`, { headers: hdrs });
        const pd = await pr.json();
        for (const v of (pd.product?.variants || [])) {
          // Enable tracking if needed
          if (v.inventory_management !== 'shopify') {
            await fetch(`https://${_SD}/admin/api/${_SV}/variants/${v.id}.json`, {
              method: 'PUT',
              headers: { ...hdrs, 'Content-Type': 'application/json' },
              body: JSON.stringify({ variant: { id: v.id, inventory_management: 'shopify' } }),
            });
          }
          const d = await setStock(hdrs, locationId, v.inventory_item_id, 50);
          updates.push({
            product: pd.product.title,
            variant: v.title,
            ok: !!d.inventory_level,
            new_qty: d.inventory_level?.available,
          });
        }
      }
    }

    res.json({
      ok: true,
      products_matched: matched,
      summary: `${updates.filter(u => u.ok).length}/${updates.length} variants → 50`,
      updates,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
