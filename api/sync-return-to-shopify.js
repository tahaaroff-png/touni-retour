// Synchronisation Stock Retours → Shopify Inventory
//
// Workflow :
// 1. Récupère tous les items du stock retours non encore pushés (shopify_pushed_at IS NULL)
//    avec qty > 0 et status = 'retour'
// 2. Group par (product_title + size + color) → sum qty
// 3. Pour chaque groupe :
//    a. Match avec shopify_variants_cache → trouve variant_id + inventory_item_id
//    b. Si pas de match → on saute (log warning)
//    c. Lit inventaire Shopify courant (live, pas cache, pour être sûr)
//    d. Si inventory == 0 (rupture) → push +total_local
//    e. Marque tous les stock items avec shopify_pushed_at, shopify_qty_pushed, variant_id
// 4. Insère une notification Supabase (shopify_notifications) avec le résumé du sync
// 5. Retourne récap { checked, pushed, skipped, errors }
//
// Mode :
// - GET /api/sync-return-to-shopify?secret=... → dry-run (juste analyse, pas de push)
// - POST /api/sync-return-to-shopify?secret=... → exécute les pushs

const {
  SHOPIFY_CLIENT_ID, SHOPIFY_LOCATION_ID, SB_URL,
  shopifyAdminHeaders, supabaseHeaders,
  getInventoryLevel, adjustInventory,
  normalizeSize, normalizeColor,
} = require('./_shopify-helpers.js');

// Shopify REST allows 2 req/s on the standard plan.
// We call getInventoryLevel() once per matched group — throttle to avoid 429s.
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function groupKey(title, size, color) {
  return `${title}||${normalizeSize(size) || ''}||${normalizeColor(color) || ''}`;
}

function parseSize(stockSize) {
  // stock.size est au format "M | Black" ou "M" ou "" ou "—" (em-dash sentinel = inconnu)
  if (!stockSize) return { size: null, color: null };
  const s = String(stockSize).trim();
  // Ignore sentinel values used in the DB to mean "no size"
  if (s === '—' || s === '-' || s === 'N/A' || s === 'n/a') return { size: null, color: null };
  const parts = s.split('|');
  return {
    size: parts[0] ? parts[0].trim() : null,
    color: parts.length > 1 ? parts[1].trim() : null,
  };
}

// Insert a sync summary notification in shopify_notifications
async function insertSyncNotification(isDryRun, results) {
  try {
    const pushedItems = results.details.filter(d =>
      d.status === 'pushed' || d.status === 'would_push'
    );
    const status =
      pushedItems.length === 0 ? 'rien_a_pousser' :
      results.errors > 0       ? 'partiel' :
                                  'succes';

    const message = isDryRun
      ? `[DRY-RUN] Simulation sync : ${pushedItems.length} articles seraient poussés`
      : `Sync terminé : ${pushedItems.length} article(s) poussé(s) vers Shopify`;

    const notification = {
      type: isDryRun ? 'sync_dry_run' : 'sync_shopify',
      message,
      data: {
        dry_run: isDryRun,
        status,
        checked: results.checked,
        pushed: results.pushed,
        skipped_has_stock: results.skipped_has_stock,
        skipped_no_match: results.skipped_no_match,
        errors: results.errors,
        pushed_items: pushedItems.map(d => ({
          product: d.product,
          size: d.size,
          color: d.color || null,
          qty: d.qty_pushed,
        })),
      },
    };

    const url = `${SB_URL}/rest/v1/shopify_notifications`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(notification),
    });
    if (!r.ok) {
      console.warn('[sync-return] Notification insert failed:', await r.text());
    } else {
      console.log(`[sync-return] Notification inserted (status=${status})`);
    }
  } catch (e) {
    // Non-blocking — don't fail the whole sync because of a notification error
    console.warn('[sync-return] insertSyncNotification error:', e.message);
  }
}

module.exports = async function handler(req, res) {
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
    // 1. Récupère tous les items éligibles (qty > 0, status = retour, pas déjà push)
    const stockUrl = `${SB_URL}/rest/v1/stock?select=*&status=eq.retour&qty=gt.0&shopify_pushed_at=is.null`;
    const stockRes = await fetch(stockUrl, { headers: supabaseHeaders() });
    if (!stockRes.ok) throw new Error('Stock fetch error: ' + await stockRes.text());
    const stockItems = await stockRes.json();
    console.log(`[sync-return] Found ${stockItems.length} eligible stock items to check`);

    // 2. Group par (product_title + size + color)
    const groups = {};
    for (const item of stockItems) {
      const { size, color } = parseSize(item.size);
      const key = groupKey(item.product, size, color);
      if (!groups[key]) {
        groups[key] = { product: item.product, size, color, items: [], totalQty: 0 };
      }
      groups[key].items.push(item);
      groups[key].totalQty += (item.qty || 0);
    }
    const groupCount = Object.keys(groups).length;
    console.log(`[sync-return] Grouped into ${groupCount} unique product/size/color combos`);

    // 3. Pour chaque groupe : matcher avec Shopify + check inventory + push si rupture
    const results = {
      checked: 0,
      pushed: 0,
      skipped_has_stock: 0,
      skipped_no_match: 0,
      errors: 0,
      details: [],
    };

    let shopifyCallCount = 0;

    for (const key in groups) {
      const grp = groups[key];
      results.checked++;
      try {
        // Match variant via cache
        const cacheUrl = `${SB_URL}/rest/v1/shopify_variants_cache?select=variant_id,inventory_item_id,inventory_quantity,size,color&product_title=eq.${encodeURIComponent(grp.product)}`;
        const cacheRes = await fetch(cacheUrl, { headers: supabaseHeaders() });
        if (!cacheRes.ok) throw new Error('Cache fetch error');
        const candidates = await cacheRes.json();
        const normSize = normalizeSize(grp.size);
        const normColor = normalizeColor(grp.color);
        let match = candidates.find(c =>
          normalizeSize(c.size) === normSize &&
          (normColor ? normalizeColor(c.color) === normColor : true)
        );
        if (!match && normSize) {
          // Fallback : same size, color ignored
          match = candidates.find(c => normalizeSize(c.size) === normSize);
        }
        if (!match) {
          results.skipped_no_match++;
          results.details.push({
            status: 'skipped_no_match',
            product: grp.product, size: grp.size, color: grp.color, qty: grp.totalQty,
            reason: candidates.length === 0
              ? 'Aucune variante dans le cache (sync-products-cache requis ?)'
              : `Aucune correspondance pour size=${grp.size} color=${grp.color} (${candidates.length} candidats)`,
          });
          continue;
        }

        // FIX: Throttle Shopify REST calls to stay under 2 req/s limit (avoids 429)
        // Every Shopify call (getInventoryLevel + adjustInventory) is preceded by a 550ms pause.
        shopifyCallCount++;
        if (shopifyCallCount > 1) await sleep(550);

        // Read live inventory (don't trust cache for the push decision)
        const liveInv = await getInventoryLevel(match.inventory_item_id);
        if (liveInv === null) {
          results.errors++;
          results.details.push({
            status: 'error', product: grp.product, size: grp.size,
            reason: 'inventory_level introuvable',
          });
          continue;
        }

        if (liveInv > 0) {
          results.skipped_has_stock++;
          results.details.push({
            status: 'skipped_has_stock',
            product: grp.product, size: grp.size, color: grp.color, qty: grp.totalQty,
            shopify_inventory: liveInv,
          });
          continue;
        }

        // Shopify is at 0 → push the full qty from our returns
        if (!isDryRun) {
          // adjustInventory counts as another Shopify call — add extra delay
          await sleep(550);
          await adjustInventory(match.inventory_item_id, grp.totalQty);
          shopifyCallCount++;

          // Mark all stock items as pushed
          const now = new Date().toISOString();
          for (const item of grp.items) {
            const updateUrl = `${SB_URL}/rest/v1/stock?id=eq.${item.id}`;
            const updateRes = await fetch(updateUrl, {
              method: 'PATCH',
              headers: supabaseHeaders(),
              body: JSON.stringify({
                shopify_pushed_at: now,
                shopify_variant_id: String(match.variant_id),
                shopify_inventory_item_id: String(match.inventory_item_id),
                shopify_qty_pushed: item.qty,
              }),
            });
            if (!updateRes.ok) console.warn('Stock update error:', await updateRes.text());
          }
          // Update cache to reflect the push
          await fetch(`${SB_URL}/rest/v1/shopify_variants_cache?variant_id=eq.${match.variant_id}`, {
            method: 'PATCH',
            headers: supabaseHeaders(),
            body: JSON.stringify({ inventory_quantity: grp.totalQty, updated_at: now }),
          });
        }
        results.pushed++;
        results.details.push({
          status: isDryRun ? 'would_push' : 'pushed',
          product: grp.product, size: grp.size, color: grp.color,
          qty_pushed: grp.totalQty,
          shopify_variant_id: match.variant_id,
        });
      } catch (e) {
        results.errors++;
        results.details.push({
          status: 'error', product: grp.product, size: grp.size,
          reason: e.message,
        });
        console.error(`[sync-return] Error for ${key}:`, e.message);
      }
    }

    console.log(`[sync-return] Done : ${results.pushed} pushed, ${results.skipped_has_stock} skipped (has stock), ${results.skipped_no_match} skipped (no match), ${results.errors} errors`);

    // 4. Insert Supabase notification with sync summary (non-blocking)
    await insertSyncNotification(isDryRun, results);

    return res.status(200).json({
      success: true,
      dry_run: isDryRun,
      ...results,
    });
  } catch (e) {
    console.error('[sync-return] Fatal error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
