// TEMPORARY — Fix remaining restock issues:
// 1. FC Barcelone (broad search, no year)
// 2. Japon Dragon Ball + Santos Domicile (enable shopify tracking then set 50)
// 3. Man United 2007/08 XL + Santos Retro failures (retry with connect)
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  SHOPIFY_LOCATION_ID: _LOC,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

// Specific product IDs from the previous run (known, no need to search again)
// Plus Barcelona search
const KNOWN_IDS = [
  9101869580507, // Japon - Maillot Dragon Ball 2025/26
  9101971882203, // Santos FC - Maillot Domicile V2 2025
  9025702428891, // Manchester United - Maillot Rétro Extérieur 2007/08 (retry XL)
  9139641876699, // Santos FC - Maillot Rétro Extérieur 2012/13 Noir
  9024990478555, // Santos Retro Home 2011/2012
];

async function setInventory(hdrs, locationId, inventoryItemId, qty) {
  // Try direct set
  const r = await fetch(`https://${_SD}/admin/api/${_SV}/inventory_levels/set.json`, {
    method: 'POST',
    headers: { ...hdrs, 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: parseInt(locationId), inventory_item_id: inventoryItemId, available: qty }),
  });
  if (r.ok) return await r.json();

  // If failed, try connect first then set
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

async function enableTrackingAndSet(hdrs, locationId, variant, productId, qty) {
  // Enable shopify inventory tracking on the variant
  const updateR = await fetch(`https://${_SD}/admin/api/${_SV}/variants/${variant.id}.json`, {
    method: 'PUT',
    headers: { ...hdrs, 'Content-Type': 'application/json' },
    body: JSON.stringify({ variant: { id: variant.id, inventory_management: 'shopify' } }),
  });
  if (!updateR.ok) return { ok: false, reason: `track enable failed ${updateR.status}` };

  // Now set inventory
  const result = await setInventory(hdrs, locationId, variant.inventory_item_id, qty);
  return { ok: true, new_qty: result.inventory_level?.available };
}

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  try {
    const hdrs = await shopifyAdminHeaders();

    // ── Location ──────────────────────────────────────────────────────
    let locationId = _LOC;
    if (!locationId) {
      const lr = await fetch(`https://${_SD}/admin/api/${_SV}/locations.json`, { headers: hdrs });
      const ld = await lr.json();
      locationId = (ld.locations || [])[0]?.id?.toString();
    }

    const results = [];

    // ── 1. FC Barcelone — broad search ────────────────────────────────
    const allP = [];
    let url = `https://${_SD}/admin/api/${_SV}/products.json?status=active&limit=250&fields=id,title,variants`;
    while (url) {
      const r = await fetch(url, { headers: hdrs });
      const d = await r.json();
      allP.push(...(d.products || []));
      const link = r.headers.get('link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    const barcelonaProducts = allP.filter(p => {
      const t = p.title.toLowerCase();
      return (t.includes('barcelon') || t.includes('barca')) && t.includes('domicile');
    });

    results.push({ step: 'Barcelona search', found: barcelonaProducts.map(p => ({ id: p.id, title: p.title })) });

    // Process Barcelona products
    for (const p of barcelonaProducts) {
      const pr = await fetch(`https://${_SD}/admin/api/${_SV}/products/${p.id}.json?fields=id,title,variants`, { headers: hdrs });
      const pd = await pr.json();
      for (const v of (pd.product?.variants || [])) {
        let upd;
        if (v.inventory_management === 'shopify') {
          const d = await setInventory(hdrs, locationId, v.inventory_item_id, 50);
          upd = { ok: true, new_qty: d.inventory_level?.available };
        } else {
          upd = await enableTrackingAndSet(hdrs, locationId, v, p.id, 50);
        }
        results.push({ product: p.title, variant: v.title, ...upd });
      }
    }

    // ── 2. Known products from previous run ───────────────────────────
    for (const pid of KNOWN_IDS) {
      const pr = await fetch(`https://${_SD}/admin/api/${_SV}/products/${pid}.json?fields=id,title,variants`, { headers: hdrs });
      if (!pr.ok) { results.push({ product: pid, error: `fetch ${pr.status}` }); continue; }
      const pd = await pr.json();
      for (const v of (pd.product?.variants || [])) {
        let upd;
        if (v.inventory_management === 'shopify') {
          const d = await setInventory(hdrs, locationId, v.inventory_item_id, 50);
          upd = { ok: !!d.inventory_level, new_qty: d.inventory_level?.available };
        } else {
          upd = await enableTrackingAndSet(hdrs, locationId, v, pid, 50);
        }
        results.push({ product: pd.product.title, variant: v.title, ...upd });
      }
    }

    const ok_count = results.filter(r => r.ok === true).length;
    const fail_count = results.filter(r => r.ok === false).length;

    res.json({
      ok: true,
      location_id: locationId,
      summary: `${ok_count} ok, ${fail_count} failed`,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
