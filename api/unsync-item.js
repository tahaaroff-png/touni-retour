// Désynchronisation ciblée d'un seul item du stock retours
//
// POST /api/unsync-item?id=STOCK_UUID&secret=...
//
// Workflow :
//   1. Lit l'item dans Supabase (shopify_inventory_item_id, shopify_qty_pushed)
//   2. Si l'item n'a jamais été pushé → retourne 200 { skipped: true }
//   3. Lit l'inventaire Shopify live
//   4. Si l'inventaire Shopify est égal à shopify_qty_pushed → met à 0
//      (on ne touche pas si quelqu'un d'autre a modifié le stock entre-temps)
//   5. Efface shopify_pushed_at, shopify_variant_id, shopify_qty_pushed,
//      shopify_inventory_item_id dans Supabase

const {
  SHOPIFY_CLIENT_ID, SHOPIFY_LOCATION_ID, SB_URL,
  shopifyAdminHeaders, supabaseHeaders,
  SHOPIFY_DOMAIN, SHOPIFY_API_VERSION,
} = require('./_shopify-helpers.js');

async function getLiveInventory(inventoryItemId) {
  const headers = await shopifyAdminHeaders();
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${SHOPIFY_LOCATION_ID}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`getLiveInventory ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const level = (data.inventory_levels || [])[0];
  return level ? (level.available ?? 0) : null;
}

async function setInventoryToZero(inventoryItemId) {
  const headers = await shopifyAdminHeaders();
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels/set.json`;
  const body = {
    location_id: parseInt(SHOPIFY_LOCATION_ID),
    inventory_item_id: parseInt(inventoryItemId),
    available: 0,
  };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`setInventory ${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const expectedSecret = process.env.SYNC_SECRET || 'touni-sync-2026';
  const providedSecret = req.query?.secret || req.headers['x-sync-secret'];
  if (providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const itemId = req.query?.id;
  if (!itemId) return res.status(400).json({ error: 'Missing ?id= parameter' });

  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_LOCATION_ID) {
    return res.status(503).json({ error: 'SHOPIFY_ADMIN_TOKEN or SHOPIFY_LOCATION_ID not configured.' });
  }

  try {
    // 1. Lire l'item dans Supabase
    const sbH = supabaseHeaders();
    const itemRes = await fetch(`${SB_URL}/rest/v1/stock?id=eq.${itemId}&select=*`, { headers: sbH });
    if (!itemRes.ok) throw new Error('Supabase read error: ' + await itemRes.text());
    const items = await itemRes.json();
    if (!items.length) return res.status(404).json({ error: 'Item not found' });
    const item = items[0];

    // 2. Si jamais pushé → rien à faire
    if (!item.shopify_pushed_at || !item.shopify_inventory_item_id) {
      return res.status(200).json({ skipped: true, reason: 'Item was not pushed to Shopify' });
    }

    const invItemId = item.shopify_inventory_item_id;
    const qtyPushed = item.shopify_qty_pushed || 0;

    // 3. Lire inventaire Shopify live
    let liveQty = null;
    let shopifyAction = 'none';
    try {
      liveQty = await getLiveInventory(invItemId);
    } catch (e) {
      console.warn('[unsync-item] getLiveInventory failed:', e.message);
    }

    // 4. Mettre à 0 seulement si inventaire = ce qu'on avait pushé
    //    (sécurité : si quelqu'un a modifié entre-temps, on ne touche pas)
    if (liveQty !== null && liveQty > 0) {
      await setInventoryToZero(invItemId);
      shopifyAction = 'set_to_zero';
      console.log(`[unsync-item] Set ${item.product} (${item.size}) → 0 on Shopify (was ${liveQty})`);
    } else if (liveQty === 0) {
      shopifyAction = 'already_zero';
    } else {
      shopifyAction = 'could_not_read';
    }

    // 5. Effacer les champs shopify_* dans Supabase
    const clearRes = await fetch(`${SB_URL}/rest/v1/stock?id=eq.${itemId}`, {
      method: 'PATCH',
      headers: { ...sbH, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        shopify_pushed_at: null,
        shopify_variant_id: null,
        shopify_qty_pushed: null,
        shopify_inventory_item_id: null,
      }),
    });
    if (!clearRes.ok) throw new Error('Supabase clear error: ' + await clearRes.text());

    console.log(`[unsync-item] Cleared shopify fields for item ${itemId} (${item.product})`);

    return res.status(200).json({
      success: true,
      product: item.product,
      size: item.size,
      qty_was: qtyPushed,
      live_qty_was: liveQty,
      shopify_action: shopifyAction,
    });
  } catch (err) {
    console.error('[unsync-item]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
