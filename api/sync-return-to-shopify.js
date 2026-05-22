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
// 4. Retourne récap { checked, pushed, skipped, errors }
//
// Mode :
// - GET /api/sync-return-to-shopify?secret=... → dry-run (juste analyse, pas de push)
// - POST /api/sync-return-to-shopify?secret=... → exécute les pushs

const {
  SHOPIFY_ADMIN_TOKEN, SHOPIFY_LOCATION_ID, SB_URL,
  shopifyAdminHeaders, supabaseHeaders,
  getInventoryLevel, adjustInventory,
  normalizeSize, normalizeColor,
} = require('./_shopify-helpers.js');

function groupKey(title, size, color) {
  return `${title}||${normalizeSize(size) || ''}||${normalizeColor(color) || ''}`;
}

function parseSize(stockSize) {
  // stock.size est au format "M | Black" ou "M" ou ""
  if (!stockSize) return { size: null, color: null };
  const parts = String(stockSize).split('|');
  return {
    size: parts[0] ? parts[0].trim() : null,
    color: parts.length > 1 ? parts[1].trim() : null,
  };
}

module.exports = async function handler(req, res) {
  const expectedSecret = process.env.SYNC_SECRET || 'touni-sync-2026';
  const providedSecret = req.query?.secret || req.headers['x-sync-secret'];
  if (providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const isDryRun = req.method === 'GET';

  if (!SHOPIFY_ADMIN_TOKEN || !SHOPIFY_LOCATION_ID) {
    return res.status(503).json({
      error: 'SHOPIFY_ADMIN_TOKEN or SHOPIFY_LOCATION_ID not configured.',
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
          await adjustInventory(match.inventory_item_id, grp.totalQty);
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
