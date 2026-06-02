// TEMPORARY endpoint — list active Shopify products with zero inventory
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
      const products = data.products || [];

      for (const p of products) {
        // Check if ALL variants have zero or negative inventory (or untracked)
        const tracked = p.variants.filter(v => v.inventory_management === 'shopify');
        if (tracked.length === 0) continue; // skip untracked products

        const totalInventory = tracked.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0);
        if (totalInventory <= 0) {
          results.push({
            id: p.id,
            title: p.title,
            image: p.image ? p.image.src : null,
            variants_count: p.variants.length,
            total_inventory: totalInventory,
          });
        }
      }

      // Pagination
      const linkHeader = r.headers.get('link') || '';
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = nextMatch ? nextMatch[1] : null;
    }

    results.sort((a, b) => a.title.localeCompare(b.title, 'fr'));

    res.json({
      count: results.length,
      products: results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
