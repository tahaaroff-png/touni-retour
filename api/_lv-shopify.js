// ─────────────────────────────────────────────────────────────────────────────
// LE VESTIAIRE — helpers Shopify (levestiaire-ma.myshopify.com)
// Source de vérité inventaire = table `stock` Supabase (gestionnaire).
// reconcileInventory() pousse les totaux par (produit, taille) :
//   → Le Vestiaire : TOUTES les variantes mappées (lv_variants_cache)
//   → Touni       : uniquement les articles déjà poussés (shopify_pushed_at)
// Fichier préfixé "_" : exclu du compte de fonctions Vercel.
// ─────────────────────────────────────────────────────────────────────────────

const {
  SB_URL, supabaseHeaders, shopifyAdminHeaders, normalizeSize, normalizeColor,
  SHOPIFY_DOMAIN, SHOPIFY_API_VERSION,
} = require('./_shopify-helpers.js');

const LV_DOMAIN = process.env.LV_SHOPIFY_DOMAIN || 'levestiaire-ma.myshopify.com';
const LV_CLIENT_ID = process.env.LV_SHOPIFY_CLIENT_ID || '';
const LV_CLIENT_SECRET = process.env.LV_SHOPIFY_CLIENT_SECRET || '';
const LV_API_VERSION = '2024-10';
const LV_LOCATION_GID = 'gid://shopify/Location/115970965783';

// ── Token client_credentials, caché ~50 min par instance ─────────────────────
let _lvToken = null;
let _lvTokenExp = 0;
async function getLvToken() {
  if (_lvToken && Date.now() < _lvTokenExp) return _lvToken;
  const r = await fetch(`https://${LV_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: LV_CLIENT_ID, client_secret: LV_CLIENT_SECRET }),
  });
  if (!r.ok) throw new Error(`LV token: HTTP ${r.status}`);
  const d = await r.json();
  _lvToken = d.access_token;
  _lvTokenExp = Date.now() + 50 * 60 * 1000;
  return _lvToken;
}

async function lvGraphql(query, variables) {
  const token = await getLvToken();
  const r = await fetch(`https://${LV_DOMAIN}/admin/api/${LV_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const d = await r.json();
  if (d.errors) throw new Error('LV GraphQL: ' + JSON.stringify(d.errors).slice(0, 300));
  return d.data;
}

// ── Normalisation pour le matching titre/taille ──────────────────────────────
// Le titre stock peut différer du titre LV par un point final ou des espaces.
function normTitle(t) {
  return String(t || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
}
function normSizeKey(s) {
  return String(s || '').toLowerCase().replace(/\s*\|\s*/g, '|').replace(/\s+/g, ' ').trim();
}
function stockKey(product, size) {
  return normTitle(product) + '§' + normSizeKey(size);
}

// ── Réconciliation complète ──────────────────────────────────────────────────
// Statuts vendables : mêmes que le flux « Expédier » du gestionnaire.
const SELLABLE_STATUSES = 'retour,stock,flocage_joueur';

async function reconcileInventory() {
  // 1) Totaux réels par (produit, taille) — inclut les lignes à 0 pour les ruptures
  const stockRes = await fetch(
    `${SB_URL}/rest/v1/stock?select=product,size,qty,status,shopify_pushed_at&deleted_at=is.null&status=in.(${SELLABLE_STATUSES})&limit=2000`,
    { headers: supabaseHeaders(true) }
  );
  if (!stockRes.ok) throw new Error('stock fetch: HTTP ' + stockRes.status);
  const rows = await stockRes.json();
  const totals = {};
  const touniPushed = new Set();
  for (const r of rows) {
    const k = stockKey(r.product, r.size);
    totals[k] = (totals[k] || 0) + (Number(r.qty) || 0);
    if (r.shopify_pushed_at) touniPushed.add(k);
  }

  // 2) Push Le Vestiaire — toutes les variantes mappées, quantité absolue
  const cacheRes = await fetch(`${SB_URL}/rest/v1/lv_variants_cache?select=product_title,size,inventory_item_id&limit=2000`, {
    headers: supabaseHeaders(true),
  });
  const cache = cacheRes.ok ? await cacheRes.json() : [];
  const quantities = cache.map(c => ({
    inventoryItemId: `gid://shopify/InventoryItem/${c.inventory_item_id}`,
    locationId: LV_LOCATION_GID,
    quantity: totals[stockKey(c.product_title, c.size)] || 0,
  }));
  let lvSet = 0;
  for (let i = 0; i < quantities.length; i += 200) {
    const batch = quantities.slice(i, i + 200);
    const d = await lvGraphql(
      `mutation($q: [InventorySetQuantityInput!]!) {
        inventorySetQuantities(input: { name: "available", reason: "correction", ignoreCompareQuantity: true, quantities: $q }) {
          userErrors { field message }
        }
      }`,
      { q: batch }
    );
    const errs = d.inventorySetQuantities.userErrors;
    if (errs && errs.length) console.error('[lv-sync] LV userErrors:', JSON.stringify(errs).slice(0, 300));
    else lvSet += batch.length;
  }

  // 3) Push Touni — uniquement les (produit, taille) déjà poussés vers Touni
  let touniSet = 0;
  if (touniPushed.size) {
    const tRes = await fetch(`${SB_URL}/rest/v1/shopify_variants_cache?select=product_title,size,color,inventory_item_id&limit=3000`, {
      headers: supabaseHeaders(true),
    });
    const tCache = tRes.ok ? await tRes.json() : [];
    const locationId = process.env.SHOPIFY_LOCATION_ID;
    for (const c of tCache) {
      const sizeKey = c.color ? `${c.size} | ${c.color}` : c.size;
      const k = stockKey(c.product_title, sizeKey);
      const k2 = stockKey(c.product_title, c.size);
      const key = touniPushed.has(k) ? k : (touniPushed.has(k2) ? k2 : null);
      if (!key) continue;
      const qty = totals[key] || 0;
      try {
        const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels/set.json`, {
          method: 'POST',
          headers: shopifyAdminHeaders(),
          body: JSON.stringify({ location_id: Number(locationId), inventory_item_id: Number(c.inventory_item_id), available: qty }),
        });
        if (r.ok) touniSet++;
        else console.error('[lv-sync] Touni set HTTP', r.status, c.product_title, c.size);
        await new Promise(rs => setTimeout(rs, 350)); // throttle REST 2/s
      } catch (e) {
        console.error('[lv-sync] Touni set error:', e.message);
      }
    }
  }

  const summary = { lv_variants: lvSet, touni_variants: touniSet, stock_keys: Object.keys(totals).length };
  console.log('[lv-sync] reconcile:', JSON.stringify(summary));
  return summary;
}

// ── Décrément direct après une commande Le Vestiaire ─────────────────────────
// matches = lignes stock (id, qty) ; toShip = quantité commandée.
async function decrementStockRows(matches, toShip) {
  const updates = [];
  for (const m of matches) {
    if (toShip <= 0) break;
    const have = Number(m.qty) || 0;
    if (have <= 0) continue;
    const take = Math.min(have, toShip);
    const newQty = have - take;
    await fetch(`${SB_URL}/rest/v1/stock?id=eq.${encodeURIComponent(m.id)}`, {
      method: 'PATCH',
      headers: { ...supabaseHeaders(true), Prefer: 'return=minimal' },
      body: JSON.stringify({ qty: newQty }),
    });
    updates.push({ id: m.id, before: have, taken: take, after: newQty });
    toShip -= take;
  }
  return { updates, remaining: Math.max(0, toShip) };
}

module.exports = { getLvToken, lvGraphql, reconcileInventory, decrementStockRows, normTitle, normSizeKey, stockKey, LV_DOMAIN, LV_CLIENT_SECRET };
