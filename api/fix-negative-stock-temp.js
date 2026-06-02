// TEMPORARY — force stock négatif à 0 via inventory_levels/set.json + deny policy
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  SHOPIFY_LOCATION_ID,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function shopifyFetch(url, options = {}) {
  const hdrs = await shopifyAdminHeaders();
  const res = await fetch(url, { ...options, headers: { ...hdrs, ...(options.headers || {}) } });
  return res;
}

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const log = [];
  const errors = [];

  try {
    // Étape 1 : Tous produits actifs
    let allProducts = [];
    let url = `https://${_SD}/admin/api/${_SV}/products.json?status=active&limit=250&fields=id,title,variants`;
    while (url) {
      const r = await shopifyFetch(url);
      if (!r.ok) throw new Error(`Shopify ${r.status}`);
      const data = await r.json();
      allProducts = allProducts.concat(data.products || []);
      const lh = r.headers.get('link') || '';
      const nm = lh.match(/<([^>]+)>;\s*rel="next"/);
      url = nm ? nm[1] : null;
      await sleep(400);
    }

    // Étape 2 : Variantes avec stock négatif (d'après variant.inventory_quantity)
    const negativeVariants = [];
    for (const p of allProducts) {
      for (const v of p.variants) {
        if (v.inventory_management === 'shopify' && (v.inventory_quantity || 0) < 0) {
          negativeVariants.push({
            productTitle: p.title,
            variantId: v.id,
            variantTitle: v.title,
            inventoryItemId: v.inventory_item_id,
            reportedQty: v.inventory_quantity,
          });
        }
      }
    }

    log.push(`Variantes négatives trouvées : ${negativeVariants.length}`);

    // Étape 3 : Pour chaque variante :
    //   A) Récupérer le stock RÉEL au niveau de la location
    //   B) Si négatif : forcer à 0 via set.json
    //   C) Si set échoue (422) : enable tracking → connect → set
    //   D) Mettre inventory_policy = 'deny'

    for (const v of negativeVariants) {
      await sleep(400);

      // A) Stock réel à notre location
      const levelRes = await shopifyFetch(
        `https://${_SD}/admin/api/${_SV}/inventory_levels.json?inventory_item_ids=${v.inventoryItemId}&location_ids=${SHOPIFY_LOCATION_ID}`
      );
      const levelData = await levelRes.json();
      const levels = levelData.inventory_levels || [];
      const realQty = levels.length > 0 ? (levels[0].available || 0) : null;

      if (realQty === null) {
        // Pas de niveau à cette location — connecter d'abord
        log.push(`⚠️ ${v.productTitle} [${v.variantTitle}] : aucun niveau trouvé à cette location`);
      }

      log.push(`  ${v.productTitle} [${v.variantTitle}] : reporté=${v.reportedQty}, réel location=${realQty}`);

      // B) Si le stock réel est déjà >= 0, pas besoin de corriger l'inventaire
      //    (le stock négatif peut être une agrégation multi-location)
      let setOk = false;
      let newQty = realQty;

      if (realQty !== null && realQty < 0) {
        // Forcer à 0 via set.json
        await sleep(300);
        const setRes = await shopifyFetch(
          `https://${_SD}/admin/api/${_SV}/inventory_levels/set.json`,
          {
            method: 'POST',
            body: JSON.stringify({
              location_id: parseInt(SHOPIFY_LOCATION_ID),
              inventory_item_id: parseInt(v.inventoryItemId),
              available: 0,
            }),
          }
        );

        if (setRes.ok) {
          const setData = await setRes.json();
          newQty = setData.inventory_level ? setData.inventory_level.available : 0;
          setOk = true;
        } else if (setRes.status === 422) {
          // Tracking désactivé — activer + connecter + set
          await sleep(300);
          await shopifyFetch(
            `https://${_SD}/admin/api/${_SV}/variants/${v.variantId}.json`,
            { method: 'PUT', body: JSON.stringify({ variant: { id: v.variantId, inventory_management: 'shopify' } }) }
          );
          await sleep(400);
          await shopifyFetch(
            `https://${_SD}/admin/api/${_SV}/inventory_levels/connect.json`,
            { method: 'POST', body: JSON.stringify({ location_id: parseInt(SHOPIFY_LOCATION_ID), inventory_item_id: parseInt(v.inventoryItemId) }) }
          );
          await sleep(400);
          const setRes2 = await shopifyFetch(
            `https://${_SD}/admin/api/${_SV}/inventory_levels/set.json`,
            { method: 'POST', body: JSON.stringify({ location_id: parseInt(SHOPIFY_LOCATION_ID), inventory_item_id: parseInt(v.inventoryItemId), available: 0 }) }
          );
          if (setRes2.ok) {
            const setData2 = await setRes2.json();
            newQty = setData2.inventory_level ? setData2.inventory_level.available : 0;
            setOk = true;
          } else {
            errors.push(`${v.productTitle} [${v.variantTitle}] set échoué après 3 étapes`);
          }
        } else {
          errors.push(`${v.productTitle} [${v.variantTitle}] set échoué: ${setRes.status}`);
        }
      } else {
        // Le stock réel n'est pas négatif à notre location
        setOk = true; // rien à corriger
        log.push(`    → stock réel déjà >= 0, pas de correction inventaire`);
      }

      // D) Deny policy
      await sleep(300);
      const denyRes = await shopifyFetch(
        `https://${_SD}/admin/api/${_SV}/variants/${v.variantId}.json`,
        { method: 'PUT', body: JSON.stringify({ variant: { id: v.variantId, inventory_policy: 'deny' } }) }
      );
      const denyOk = denyRes.ok;

      const icon = (setOk && denyOk) ? '✅' : (setOk ? '🔶' : '❌');
      log.push(`  ${icon} Stock corrigé: ${realQty} → ${newQty} | deny: ${denyOk}`);
    }

    res.json({ success: true, fixed: negativeVariants.length, log, errors });
  } catch (e) {
    res.status(500).json({ error: e.message, log });
  }
};
