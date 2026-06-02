// TEMPORARY — produits avec ≤ 2 tailles en rupture (mais pas en rupture totale)
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  try {
    const results = [];
    let url = `https://${_SD}/admin/api/${_SV}/products.json?status=active&limit=250&fields=id,title,status,image,variants`;

    while (url) {
      const hdrs = await shopifyAdminHeaders();
      const r = await fetch(url, { headers: hdrs });
      if (!r.ok) throw new Error(`Shopify ${r.status}: ${await r.text()}`);
      const data = await r.json();

      for (const p of data.products || []) {
        const tracked = p.variants.filter(v => v.inventory_management === 'shopify');
        if (tracked.length === 0) continue;

        const outOfStock = tracked.filter(v => (v.inventory_quantity || 0) <= 0);
        const inStock = tracked.filter(v => (v.inventory_quantity || 0) > 0);

        // Produits avec au moins 1 taille en stock ET au plus 2 tailles en rupture
        if (inStock.length > 0 && outOfStock.length > 0 && outOfStock.length <= 2) {
          results.push({
            id: p.id,
            title: p.title,
            image: p.image ? p.image.src : null,
            variants_total: tracked.length,
            in_stock: inStock.map(v => ({ title: v.title, qty: v.inventory_quantity })),
            out_of_stock: outOfStock.map(v => ({ title: v.title, qty: v.inventory_quantity })),
          });
        }
      }

      const linkHeader = r.headers.get('link') || '';
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = nextMatch ? nextMatch[1] : null;
    }

    results.sort((a, b) => a.title.localeCompare(b.title, 'fr'));
    res.json({ count: results.length, products: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
