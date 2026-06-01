// Endpoint temporaire — restaure les 4 articles mis à 0 par erreur par sync-rupture
// À supprimer après utilisation.

const { shopifyAdminHeaders, SHOPIFY_LOCATION_ID, SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV } = require('./_shopify-helpers.js');

const RESTORE_ITEMS = [
  { variant_id: '47638814654683', product: 'Raja Club Athletic - Maillot 2025/26 L',                       qty: 41 },
  { variant_id: '48212396736731', product: 'Raja Club Athletic - Kit Complet Maillot + Short 2025/26 S',   qty: 45 },
  { variant_id: '47205469815003', product: 'Maillot Brésil Domicile 2025/26 L',                           qty: 49 },
  { variant_id: '48255167791323', product: 'Wydad AC - Maillot Noir Édition Spéciale 2023/2024 XL',       qty: 40 },
];

module.exports = async function handler(req, res) {
  const secret = req.query?.secret;
  if (secret !== (process.env.SYNC_SECRET || 'touni-sync-2026')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];

  for (const item of RESTORE_ITEMS) {
    try {
      // 1. Trouver l'inventory_item_id via l'API Shopify
      const hdrs = await shopifyAdminHeaders();
      const varRes = await fetch(
        `https://${_SD}/admin/api/${_SV}/variants/${item.variant_id}.json?fields=id,inventory_item_id`,
        { headers: hdrs }
      );
      if (!varRes.ok) throw new Error(`Variant fetch ${varRes.status}: ${await varRes.text()}`);
      const varData = await varRes.json();
      const inventoryItemId = varData.variant?.inventory_item_id;
      if (!inventoryItemId) throw new Error('inventory_item_id introuvable');

      // 2. Remettre à la quantité d'avant via inventory_levels/set.json
      const hdrs2 = await shopifyAdminHeaders();
      const setRes = await fetch(
        `https://${_SD}/admin/api/${_SV}/inventory_levels/set.json`,
        {
          method: 'POST',
          headers: hdrs2,
          body: JSON.stringify({
            location_id: parseInt(SHOPIFY_LOCATION_ID),
            inventory_item_id: parseInt(inventoryItemId),
            available: item.qty,
          }),
        }
      );
      if (!setRes.ok) throw new Error(`Set inventory ${setRes.status}: ${await setRes.text()}`);
      const setData = await setRes.json();
      results.push({ product: item.product, status: 'restored', qty: item.qty, available: setData.inventory_level?.available });
      console.log(`[restore] ✅ ${item.product} → ${item.qty}`);
    } catch (e) {
      results.push({ product: item.product, status: 'error', error: e.message });
      console.error(`[restore] ❌ ${item.product}:`, e.message);
    }
  }

  return res.status(200).json({ success: true, results });
};
