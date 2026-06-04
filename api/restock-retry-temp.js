// TEMPORARY — Retry: set to 50 only variants NOT already at 50 (avoids timeout)
// Targets: Italie, Brésil, Allemagne (failed from batch 2)
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  SHOPIFY_LOCATION_ID: _LOC,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

// Keywords for the 3 groups that had failures
const TARGETS = [
  { label: 'Italie',     keywords: ['itali', 'domicile'] },
  { label: 'Brésil',    keywords: ['brésil', 'domicile'] },
  { label: 'Allemagne', keywords: ['allemagne'] },
];

function matches(title, keywords) {
  const t = title.toLowerCase();
  return keywords.every(k => t.includes(k));
}

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  try {
    const hdrs = await shopifyAdminHeaders();

    let locationId = _LOC;
    if (!locationId) {
      const lr = await fetch(`https://${_SD}/admin/api/${_SV}/locations.json`, { headers: hdrs });
      locationId = ((await lr.json()).locations || [])[0]?.id?.toString();
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

    const updates = [];

    for (const target of TARGETS) {
      const products = allProducts.filter(p => matches(p.title, target.keywords));

      for (const p of products) {
        const pr = await fetch(
          `https://${_SD}/admin/api/${_SV}/products/${p.id}.json?fields=id,title,variants`,
          { headers: hdrs }
        );
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

          // Check current qty — skip if already 50
          const ilr = await fetch(
            `https://${_SD}/admin/api/${_SV}/inventory_levels.json?inventory_item_ids=${v.inventory_item_id}&location_ids=${locationId}`,
            { headers: hdrs }
          );
          const ild = await ilr.json();
          const current = (ild.inventory_levels || [])[0]?.available;
          if (current === 50) {
            updates.push({ product: pd.product.title, variant: v.title, status: 'skipped (already 50)' });
            continue;
          }

          // Connect if needed
          if (current === undefined) {
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
            body: JSON.stringify({ location_id: parseInt(locationId), inventory_item_id: v.inventory_item_id, available: 50 }),
          });
          const sd = await sr.json();
          updates.push({
            product: pd.product.title,
            variant: v.title,
            ok: sr.ok,
            new_qty: sd.inventory_level?.available,
          });
        }
      }
    }

    const ok = updates.filter(u => u.ok === true).length;
    const skipped = updates.filter(u => u.status?.includes('skipped')).length;
    const failed = updates.filter(u => u.ok === false).length;

    res.json({ ok: true, summary: `${ok} updated, ${skipped} already at 50, ${failed} failed`, updates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
