// Reverse Sync : Stock Retours → Shopify (mise en rupture)
//
// Logique :
//   Trouve tous les items du stock qui ont DÉJÀ été poussés vers Shopify
//   (shopify_pushed_at IS NOT NULL) ET dont le statut est "vendu" ou "mystere".
//   Pour chacun : lit l'inventaire live Shopify, met à 0 si > 0.
//
//   NOTE : pour les ventes Shopify normales, Shopify déduit automatiquement
//   l'inventaire → skipped_already_zero (aucun effet).
//   Cette sync est utile pour les ventes physiques / mystère non passées par Shopify.
//
// SÉCURITÉ CRITIQUE :
//   On ne touche QUE les variants où shopify_pushed_at IS NOT NULL.
//   = seuls les articles que NOUS avons mis en stock via sync-return-to-shopify.
//   Les stocks Shopify normaux ne sont jamais affectés.
//
// Mode :
//   GET  ?secret=... → dry-run (simulation, pas de modification Shopify)
//   POST ?secret=... → exécute les mises en rupture
//
// Résultat : { checked, set_to_zero, skipped_already_zero, errors, details[] }

const {
  SHOPIFY_CLIENT_ID, SHOPIFY_LOCATION_ID, SB_URL,
  shopifyAdminHeaders, supabaseHeaders,
  SHOPIFY_DOMAIN, SHOPIFY_API_VERSION,
} = require('./_shopify-helpers.js');

// ── Rate limiter identique à sync-return-to-shopify ──────────────────────────
const _throttle = {
  tokens: 2, maxTokens: 2, refillRate: 2, lastRefill: Date.now(),
};
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function shopifyThrottle() {
  const now = Date.now();
  const elapsed = (now - _throttle.lastRefill) / 1000;
  _throttle.tokens = Math.min(_throttle.maxTokens, _throttle.tokens + elapsed * _throttle.refillRate);
  _throttle.lastRefill = now;
  if (_throttle.tokens >= 1) { _throttle.tokens -= 1; return; }
  const waitMs = Math.ceil((1 - _throttle.tokens) / _throttle.refillRate * 1000) + 50;
  await sleep(waitMs);
  _throttle.tokens = 0;
}

// Appel Shopify pour définir le stock à une valeur précise (set, pas adjust)
async function setInventory(inventoryItemId, available) {
  const headers = await shopifyAdminHeaders();
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels/set.json`;
  const body = {
    location_id: parseInt(SHOPIFY_LOCATION_ID),
    inventory_item_id: parseInt(inventoryItemId),
    available: parseInt(available),
  };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`setInventory ${res.status}: ${await res.text()}`);
  return res.json();
}

// Lit l'inventaire Shopify live pour un inventory_item_id
async function getLiveInventory(inventoryItemId) {
  const headers = await shopifyAdminHeaders();
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${SHOPIFY_LOCATION_ID}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`getLiveInventory ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const level = (data.inventory_levels || [])[0];
  return level ? (level.available || 0) : null;
}

// Insert une notification de résultat dans shopify_notifications
async function insertRuptureNotification(isDryRun, results) {
  try {
    const zeroItems = results.details.filter(d =>
      d.status === 'set_to_zero' || d.status === 'would_zero'
    );
    const status =
      zeroItems.length === 0 ? 'rien_a_pousser' :
      results.errors > 0     ? 'partiel' :
                               'succes';
    const message = isDryRun
      ? `[DRY-RUN] Rupture simulation : ${zeroItems.length} article(s) seraient mis à 0`
      : `Sync rupture : ${zeroItems.length} article(s) mis en rupture sur Shopify`;
    const notification = {
      type: isDryRun ? 'rupture_dry_run' : 'rupture_shopify',
      message,
      data: {
        dry_run: isDryRun,
        status,
        checked: results.checked,
        set_to_zero: results.set_to_zero,
        skipped_already_zero: results.skipped_already_zero,
        errors: results.errors,
        zeroed_items: zeroItems.map(d => ({
          product: d.product,
          size: d.size,
          color: d.color || null,
          reason: d.reason,
          shopify_inventory_before: d.shopify_inventory_before,
        })),
        error_items: results.details
          .filter(d => d.status === 'error')
          .map(d => ({
            product: d.product,
            size: d.size,
            reason: d.reason,
          })),
      },
    };
    const r = await fetch(`${SB_URL}/rest/v1/shopify_notifications`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(notification),
    });
    if (!r.ok) console.warn('[sync-rupture] Notification insert failed:', await r.text());
    else console.log(`[sync-rupture] Notification inserted (status=${status})`);
  } catch (e) {
    console.warn('[sync-rupture] insertRuptureNotification error:', e.message);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const expectedSecret = process.env.SYNC_SECRET || 'touni-sync-2026';
  const providedSecret = req.query?.secret || req.headers['x-sync-secret'];
  if (providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const isDryRun = req.method === 'GET';

  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_LOCATION_ID) {
    return res.status(503).json({
      error: 'SHOPIFY_CLIENT_ID or SHOPIFY_LOCATION_ID not configured.',
    });
  }

  try {
    // ── 1. Récupère les items précédemment poussés avec status vendu ou mystère ──
    //
    // CONDITION STRICTE :
    //   shopify_pushed_at IS NOT NULL   → on ne touche QUE ce qu'on a poussé
    //   AND status IN ('vendu','mystere') → statut changé manuellement par l'opératrice
    //
    // On exclut volontairement qty = 0 : un article "retour" à qty 0 n'est pas forcément
    // vendu. Pour les ventes Shopify normales, Shopify déduit automatiquement l'inventaire
    // → la sync trouve déjà 0 → skipped_already_zero (aucun effet).
    // La rupture sync est utile uniquement pour les ventes physiques / mystère non passées
    // par Shopify, où l'opératrice change le statut mais Shopify n'est pas mis à jour.

    const baseFilter = `shopify_pushed_at=not.is.null&select=id,product,size,qty,status,shopify_inventory_item_id,shopify_variant_id,shopify_pushed_at,shopify_qty_pushed`;
    const urlStatus = `${SB_URL}/rest/v1/stock?${baseFilter}&status=in.(vendu,mystere)`;

    const resStatus = await fetch(urlStatus, { headers: supabaseHeaders() });
    if (!resStatus.ok) throw new Error('Stock fetch error: ' + await resStatus.text());
    const byStatus = await resStatus.json();

    const eligible = byStatus.filter(item => !!item.shopify_inventory_item_id);

    console.log(`[sync-rupture] Found ${eligible.length} previously-pushed items to check (vendu/mystere)`);

    // ── 2. Groupe par inventory_item_id (un seul appel Shopify par variant) ──
    const groups = {};
    for (const item of eligible) {
      const key = item.shopify_inventory_item_id;
      if (!groups[key]) {
        groups[key] = {
          inventory_item_id: item.shopify_inventory_item_id,
          variant_id: item.shopify_variant_id,
          product: item.product,
          size: item.size,
          items: [],
          reasons: new Set(),
        };
      }
      groups[key].items.push(item);
      if (item.status === 'vendu')   groups[key].reasons.add('vendu');
      if (item.status === 'mystere') groups[key].reasons.add('mystere');
    }

    const results = {
      checked: 0,
      set_to_zero: 0,
      skipped_already_zero: 0,
      errors: 0,
      details: [],
    };

    // ── 3. Pour chaque variant : vérifie inventaire live, met à 0 si besoin ──
    for (const key in groups) {
      const grp = groups[key];
      results.checked++;
      const reasonLabel = [...grp.reasons].join(', ');

      try {
        await shopifyThrottle();
        const liveInv = await getLiveInventory(grp.inventory_item_id);

        if (liveInv === null) {
          results.errors++;
          results.details.push({
            status: 'error',
            product: grp.product,
            size: grp.size,
            reason: 'inventory_level introuvable',
          });
          continue;
        }

        if (liveInv === 0) {
          results.skipped_already_zero++;
          results.details.push({
            status: 'skipped_already_zero',
            product: grp.product,
            size: grp.size,
            reason: reasonLabel,
            shopify_inventory: 0,
          });
          continue;
        }

        // Shopify a encore du stock → on met à 0
        if (!isDryRun) {
          await shopifyThrottle();
          await setInventory(grp.inventory_item_id, 0);

          // Met à jour le cache local
          const now = new Date().toISOString();
          await fetch(`${SB_URL}/rest/v1/shopify_variants_cache?variant_id=eq.${grp.variant_id}`, {
            method: 'PATCH',
            headers: supabaseHeaders(),
            body: JSON.stringify({ inventory_quantity: 0, updated_at: now }),
          });
        }

        results.set_to_zero++;
        results.details.push({
          status: isDryRun ? 'would_zero' : 'set_to_zero',
          product: grp.product,
          size: grp.size,
          color: null,
          reason: reasonLabel,
          shopify_inventory_before: liveInv,
          shopify_variant_id: grp.variant_id,
        });

        console.log(`[sync-rupture] ${isDryRun ? '[DRY]' : ''} ${grp.product} (${grp.size}) : ${liveInv} → 0 (${reasonLabel})`);

      } catch (e) {
        results.errors++;
        results.details.push({
          status: 'error',
          product: grp.product,
          size: grp.size,
          reason: e.message,
        });
        console.error(`[sync-rupture] Error for ${key}:`, e.message);
      }
    }

    console.log(`[sync-rupture] Done : ${results.set_to_zero} set to 0, ${results.skipped_already_zero} already zero, ${results.errors} errors`);

    // ── 4. Notification Supabase ──────────────────────────────────────────────
    await insertRuptureNotification(isDryRun, results);

    return res.status(200).json({
      success: true,
      dry_run: isDryRun,
      ...results,
    });

  } catch (e) {
    console.error('[sync-rupture] Fatal error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
