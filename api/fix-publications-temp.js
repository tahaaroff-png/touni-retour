// TEMPORARY — Publish all active products to all sales channels (Facebook, Instagram, etc.)
// DELETE AFTER USE
// ?action=list  → list channels
// ?action=fix   → publish all active products to all channels (paginated: ?page=1,2,...)

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
    const pubR = await fetch(`https://${_SD}/admin/api/${_SV}/publications.json`, { headers: hdrs });
    const pubData = await pubR.json();
    const publications = pubData.publications || [];

    if (req.query.action === 'list') {
      return res.json({ publications });
    }

    // 2. Get all active products (paginated, 50 per batch to avoid timeout)
    const page = parseInt(req.query.page || '1');
    const pageSize = 50;
    const since_id = req.query.since_id ? parseInt(req.query.since_id) : 0;

    const prodUrl = `https://${_SD}/admin/api/${_SV}/products.json?status=active&limit=${pageSize}&fields=id,title,published_scope${since_id ? `&since_id=${since_id}` : ''}`;
    const prodR = await fetch(prodUrl, { headers: hdrs });
    const prodData = await prodR.json();
    const products = prodData.products || [];

    if (products.length === 0) {
      return res.json({ success: true, message: 'No more products', page, processed: 0 });
    }

    const lastId = products[products.length - 1].id;
    const results = { page, batch_size: products.length, next_since_id: lastId, details: [] };

    for (const product of products) {
      const productResult = { id: product.id, title: product.title, scope: product.published_scope, channels: [] };

      // 3. Publish to each channel via product_publications
      for (const pub of publications) {
        const r = await fetch(`https://${_SD}/admin/api/${_SV}/product_publications.json`, {
          method: 'POST',
          headers: hdrs,
          body: JSON.stringify({
            product_publication: {
              product_id: product.id,
              publication_id: pub.id,
            }
          }),
        });

        const data = await r.json();
        if (r.ok) {
          productResult.channels.push({ pub: pub.name, status: 'published' });
        } else {
          const msg = JSON.stringify(data.errors || data).slice(0, 80);
          // Already published = not an error
          const alreadyPublished = msg.includes('already') || msg.includes('taken') || r.status === 422;
          productResult.channels.push({ pub: pub.name, status: alreadyPublished ? 'already_ok' : 'error', msg: alreadyPublished ? undefined : msg });
        }
      }

      results.details.push(productResult);
    }

    const published = results.details.reduce((acc, p) => acc + p.channels.filter(c => c.status === 'published').length, 0);
    const already = results.details.reduce((acc, p) => acc + p.channels.filter(c => c.status === 'already_ok').length, 0);
    const errors = results.details.reduce((acc, p) => acc + p.channels.filter(c => c.status === 'error').length, 0);

    return res.json({
      success: true,
      page,
      batch_size: products.length,
      next_since_id: lastId,
      published,
      already_ok: already,
      errors,
      details: results.details,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
