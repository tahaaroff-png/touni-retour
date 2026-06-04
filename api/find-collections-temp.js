// TEMPORARY — Find collections for Colombia/Germany jerseys
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  try {
    const hdrs = await shopifyAdminHeaders();

    // List all collections
    const cR = await fetch(
      `https://${_SD}/admin/api/${_SV}/custom_collections.json?limit=250&fields=id,title,handle`,
      { headers: hdrs }
    );
    const cData = await cR.json();

    // Also search for products with Colombia or Germany
    const pR = await fetch(
      `https://${_SD}/admin/api/${_SV}/products.json?limit=10&fields=id,title,product_type,vendor,tags&title=Colombie`,
      { headers: hdrs }
    );
    const pData = await pR.json();

    const pR2 = await fetch(
      `https://${_SD}/admin/api/${_SV}/products.json?limit=10&fields=id,title,product_type,vendor,tags&title=Allemagne`,
      { headers: hdrs }
    );
    const pData2 = await pR2.json();

    // Find collections for a Colombia product
    let colombiaCollections = [];
    if (pData.products && pData.products[0]) {
      const pid = pData.products[0].id;
      const colR = await fetch(
        `https://${_SD}/admin/api/${_SV}/products/${pid}/collect.json`,
        { headers: hdrs }
      );
      const colData = await colR.json();
      colombiaCollections = colData.collects || [];
    }

    // Find collections for a Germany product
    let germanyCollections = [];
    if (pData2.products && pData2.products[0]) {
      const pid = pData2.products[0].id;
      const colR = await fetch(
        `https://${_SD}/admin/api/${_SV}/products/${pid}/collect.json`,
        { headers: hdrs }
      );
      const colData = await colR.json();
      germanyCollections = colData.collects || [];
    }

    return res.json({
      all_collections: cData.custom_collections || [],
      colombia_products: pData.products || [],
      germany_products: pData2.products || [],
      colombia_collection_ids: colombiaCollections,
      germany_collection_ids: germanyCollections,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
