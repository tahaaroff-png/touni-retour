// TEMPORARY — Read metafields of existing products to understand Infos & Conditions structure
// DELETE AFTER USE
const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');
const SYNC_SECRET = process.env.SYNC_SECRET || '';

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const hdrs = await shopifyAdminHeaders();
  const productId = req.query.id; // pass ?id=PRODUCT_ID
  if (!productId) return res.status(400).json({ error: 'Missing ?id=' });
  try {
    const r = await fetch(
      `https://${_SD}/admin/api/${_SV}/products/${productId}/metafields.json`,
      { headers: hdrs }
    );
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
