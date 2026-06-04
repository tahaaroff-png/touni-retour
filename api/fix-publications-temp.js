// TEMPORARY — List publications then publish all active products to all channels
// DELETE AFTER USE
// ?action=list  → list all channels/publications
// ?action=fix&limit=250 → publish all active products to all channels

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const hdrs = await shopifyAdminHeaders();

  try {
    // 1. List all publications (sales channels)
    const pubR = await fetch(
      `https://${_SD}/admin/api/${_SV}/publications.json`,
      { headers: hdrs }
    );
    const pubData = await pubR.json();
    const publications = pubData.publications || [];

    if (req.query.action === 'list') {
      return res.json({ publications });
    }

    // 2. Get all active products (paginated)
    const allProducts = [];
    let url = `https://${_SD}/admin/api/${_SV}/products.json?status=active&limit=250&fields=id,title`;
    while (url) {
      const r = await fetch(url, { headers: hdrs });
      const data = await r.json();
      allProducts.push(...(data.products || []));
      const link = r.headers.get('link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    // 3. For each product × each publication → publish
    const results = { total_products: allProducts.length, publications: publications.map(p => p.name), already: 0, published: 0, errors: [] };

    for (const product of allProducts) {
      for (const pub of publications) {
        const r = await fetch(
          `https://${_SD}/admin/api/${_SV}/publications/${pub.id}/products/${product.id}/connections.json`,
          { method: 'PUT', headers: hdrs }
        );
        if (r.ok) {
          results.published++;
        } else {
          const txt = await r.text();
          // 422 = already published, not an error
          if (r.status === 422 || txt.includes('already')) {
            results.already++;
          } else {
            results.errors.push({ product_id: product.id, pub: pub.name, status: r.status, msg: txt.slice(0, 100) });
          }
        }
      }
    }

    return res.json({ success: true, ...results });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
