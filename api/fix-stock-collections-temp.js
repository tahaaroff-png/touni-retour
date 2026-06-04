// TEMPORARY — Add products to "Tous mes produits" + set stock 50 per variant
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  SHOPIFY_LOCATION_ID,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

// All products to fix (the 5 new + existing Trionda with 3 variants)
const PRODUCT_IDS = [
  9365962916059, // Colombie jersey
  9365962948827, // Allemagne jersey
  9365962981595, // Trionda Orange
  9365963047131, // Trionda Blanc Multicolore
  9365963079899, // Trionda Jaune Fluo
  9365959835867, // Trionda Pro (3 variants - original product)
];

const TOUS_MES_PRODUITS = 533551055067;

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const hdrs = await shopifyAdminHeaders();
  const results = [];

  for (const productId of PRODUCT_IDS) {
    const productResult = { product_id: productId, collects: null, variants: [] };

    try {
      // 1. Add to "Tous mes produits"
      const cR = await fetch(`https://${_SD}/admin/api/${_SV}/collects.json`, {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({ collect: { product_id: productId, collection_id: TOUS_MES_PRODUITS } }),
      });
      const cData = await cR.json();
      productResult.collects = cR.ok ? 'added' : (cData.errors || 'error');

      // 2. Get variants + inventory item IDs
      const pR = await fetch(
        `https://${_SD}/admin/api/${_SV}/products/${productId}.json?fields=id,title,variants`,
        { headers: hdrs }
      );
      const pData = await pR.json();
      productResult.title = pData.product?.title;

      for (const variant of (pData.product?.variants || [])) {
        const invItemId = variant.inventory_item_id;

        // 3. Get real inventory level at location
        const lvlR = await fetch(
          `https://${_SD}/admin/api/${_SV}/inventory_levels.json?inventory_item_ids=${invItemId}&location_ids=${SHOPIFY_LOCATION_ID}`,
          { headers: hdrs }
        );
        const lvlData = await lvlR.json();

        // 4a. If no level found, connect first
        if (!lvlData.inventory_levels || lvlData.inventory_levels.length === 0) {
          await fetch(`https://${_SD}/admin/api/${_SV}/inventory_levels/connect.json`, {
            method: 'POST',
            headers: hdrs,
            body: JSON.stringify({ location_id: parseInt(SHOPIFY_LOCATION_ID), inventory_item_id: invItemId }),
          });
        }

        // 4b. Set to 50
        const setR = await fetch(`https://${_SD}/admin/api/${_SV}/inventory_levels/set.json`, {
          method: 'POST',
          headers: hdrs,
          body: JSON.stringify({
            location_id: parseInt(SHOPIFY_LOCATION_ID),
            inventory_item_id: invItemId,
            available: 50,
          }),
        });
        const setData = await setR.json();
        productResult.variants.push({
          variant_id: variant.id,
          title: variant.title,
          ok: setR.ok,
          available: setData.inventory_level?.available,
        });
      }
    } catch (e) {
      productResult.error = e.message;
    }

    results.push(productResult);
  }

  return res.json({ success: true, results });
};
