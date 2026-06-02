// TEMPORARY — régularise les stocks négatifs à 0 + active "deny" sur les variantes à 0
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  SHOPIFY_LOCATION_ID,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const log = [];
  const errors = [];

  try {
    // Étape 1 : Récupérer tous les produits actifs
    let allProducts = [];
    let url = `https://${_SD}/admin/api/${_SV}/products.json?status=active&limit=250&fields=id,title,variants`;
    while (url) {
      const hdrs = await shopifyAdminHeaders();
      const r = await fetch(url, { headers: hdrs });
      if (!r.ok) throw new Error(`Shopify ${r.status}`);
      const data = await r.json();
      allProducts = allProducts.concat(data.products || []);
      const lh = r.headers.get('link') || '';
      const nm = lh.match(/<([^>]+)>;\s*rel="next"/);
      url = nm ? nm[1] : null;
      await sleep(300);
    }

    // Étape 2 : Trouver toutes les variantes avec stock négatif
    const negativeVariants = [];
    for (const p of allProducts) {
      for (const v of p.variants) {
        if (v.inventory_management === 'shopify' && (v.inventory_quantity || 0) < 0) {
          negativeVariants.push({
            productTitle: p.title,
            variantId: v.id,
            variantTitle: v.title,
            inventoryItemId: v.inventory_item_id,
            currentQty: v.inventory_quantity,
          });
        }
      }
    }

    log.push(`Variantes négatives trouvées : ${negativeVariants.length}`);

    // Étape 3 : Pour chaque variante négative :
    //   A) Mettre inventory_policy = 'deny'
    //   B) Ajuster le stock à 0 (delta = -currentQty)
    for (const v of negativeVariants) {
      // A) Deny policy via variant update
      const hdrs = await shopifyAdminHeaders();
      const updateRes = await fetch(
        `https://${_SD}/admin/api/${_SV}/variants/${v.variantId}.json`,
        {
          method: 'PUT',
          headers: hdrs,
          body: JSON.stringify({ variant: { id: v.variantId, inventory_policy: 'deny' } }),
        }
      );
      const updateOk = updateRes.ok;
      await sleep(300);

      // B) Ajuster le stock à 0
      const delta = -(v.currentQty); // ex: currentQty=-6 → delta=+6 pour atteindre 0
      const hdrs2 = await shopifyAdminHeaders();
      const adjustRes = await fetch(
        `https://${_SD}/admin/api/${_SV}/inventory_levels/adjust.json`,
        {
          method: 'POST',
          headers: hdrs2,
          body: JSON.stringify({
            location_id: parseInt(SHOPIFY_LOCATION_ID),
            inventory_item_id: v.inventoryItemId,
            available_adjustment: delta,
          }),
        }
      );
      const adjustOk = adjustRes.ok;
      const adjustData = await adjustRes.json();
      await sleep(300);

      const newQty = adjustData.inventory_level ? adjustData.inventory_level.available : '?';
      const status = (updateOk && adjustOk) ? '✅' : '⚠️';
      log.push(`${status} ${v.productTitle} — ${v.variantTitle} : ${v.currentQty} → ${newQty} | policy=deny: ${updateOk}`);

      if (!updateOk || !adjustOk) {
        errors.push(`${v.productTitle} [${v.variantTitle}]: update=${updateOk} adjust=${adjustOk}`);
      }
    }

    res.json({ success: true, fixed: negativeVariants.length, log, errors });
  } catch (e) {
    res.status(500).json({ error: e.message, log });
  }
};
