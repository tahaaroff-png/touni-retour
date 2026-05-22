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

// ── Shopify rate-limiter (2 req/s max on standard plan) ──────────────────────
// Token bucket: allows short bursts then throttles to 2 req/s.
// Each Shopify API call should go through shopifyThrottle() first.
const _throttle = {
  tokens: 2,          // start with 2 tokens (burst allowance)
  maxTokens: 2,
  refillRate: 2,      // tokens per second
  lastRefill: Date.now(),
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function shopifyThrottle() {
  const now = Date.now();
  const elapsed = (now - _throttle.lastRefill) / 1000;
  _throttle.tokens = Math.min(_throttle.maxTokens, _throttle.tokens + elapsed * _throttle.refillRate);
  _throttle.lastRefill = now;

  if (_throttle.tokens >= 1) {
    _throttle.tokens -= 1;
    return; // proceed immediately
  }
  // Need to wait for a token to refill
  const waitMs = Math.ceil((1 - _throttle.tokens) / _throttle.refillRate * 1000) + 50;
  await sleep(waitMs);
  _throttle.tokens = 0;
}

function groupKey(title, size, color) {
  return `${title}||${normalizeSize(size) || ''}||${normalizeColor(color) || ''}`;
}

// ── Fuzzy title matching ─────────────────────────────────────────────────────
// Normalise un titre de produit : minuscules, sans accents, sans ponctuation
function normTitle(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // accents
    .replace(/[^a-z0-9\s]/g, ' ')                     // ponctuation → espace
    .replace(/\s+/g, ' ')
    .trim();
}

// Score de similarité entre deux titres (0..1) basé sur le chevauchement de mots
// Jaccard : |intersection| / |union|
function titleSimilarity(a, b) {
  const wordsA = new Set(normTitle(a).split(' ').filter(w => w.length > 1));
  const wordsB = new Set(normTitle(b).split(' ').filter(w => w.length > 1));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let inter = 0;
  for (const w of wordsA) if (wordsB.has(w)) inter++;
  const union = wordsA.size + wordsB.size - inter;
  return inter / union;
}

const FUZZY_THRESHOLD = 0.65; // 65% de mots en commun → match accepté

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
          shopify_title: d.shopify_title || null,
          fuzzy_score: d.fuzzy_score || null,
          size: d.size,
          color: d.color || null,
          qty: d.qty_pushed,
        })),
        no_match_items: results.details
          .filter(d => d.status === 'skipped_no_match')
          .map(d => ({
            product: d.product,
            size: d.size,
            color: d.color || null,
            qty: d.qty,
            reason: d.reason,
            cause: d.cause || 'unknown',
            stock_ids: d.stock_ids || [],
            candidates_count: d.candidates_count || 0,
            matched_shopify_title: d.matched_shopify_title || null,
          })),
        error_items: results.details
          .filter(d => d.status === 'error')
          .map(d => ({
            product: d.product,
            size: d.size,
            reason: d.reason,
            stock_ids: d.stock_ids || [],
          })),
        skipped_stock_items: results.details
          .filter(d => d.status === 'skipped_has_stock')
          .slice(0, 20) // cap à 20 pour éviter payload trop lourd
          .map(d => ({
            product: d.product,
            size: d.size,
            shopify_inventory: d.shopify_inventory,
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

    for (const key in groups) {
      const grp = groups[key];
      results.checked++;
      try {
        // Match variant via cache — exact title first, then fuzzy fallback
        const normSize = normalizeSize(grp.size);
        const normColor = normalizeColor(grp.color);
        let candidates = [];
        let matchedTitle = grp.product;
        let fuzzyScore = null;

        // Step 1 : exact title match
        const exactUrl = `${SB_URL}/rest/v1/shopify_variants_cache?select=variant_id,inventory_item_id,inventory_quantity,size,color,product_title&product_title=eq.${encodeURIComponent(grp.product)}`;
        const exactRes = await fetch(exactUrl, { headers: supabaseHeaders() });
        if (!exactRes.ok) throw new Error('Cache fetch error (exact)');
        candidates = await exactRes.json();

        // Step 2 : fuzzy title match if no exact candidates found
        if (candidates.length === 0) {
          // Fetch all distinct product_titles from cache
          const allTitlesUrl = `${SB_URL}/rest/v1/shopify_variants_cache?select=product_title&limit=2000`;
          const allTitlesRes = await fetch(allTitlesUrl, { headers: supabaseHeaders() });
          if (allTitlesRes.ok) {
            const allRows = await allTitlesRes.json();
            // Find best matching title
            let bestScore = 0, bestTitle = null;
            const seen = new Set();
            for (const row of allRows) {
              const t = row.product_title;
              if (!t || seen.has(t)) continue;
              seen.add(t);
              const score = titleSimilarity(grp.product, t);
              if (score > bestScore) { bestScore = score; bestTitle = t; }
            }
            if (bestScore >= FUZZY_THRESHOLD && bestTitle) {
              // Fetch variants for best matching title
              const fuzzyUrl = `${SB_URL}/rest/v1/shopify_variants_cache?select=variant_id,inventory_item_id,inventory_quantity,size,color,product_title&product_title=eq.${encodeURIComponent(bestTitle)}`;
              const fuzzyRes = await fetch(fuzzyUrl, { headers: supabaseHeaders() });
              if (fuzzyRes.ok) {
                candidates = await fuzzyRes.json();
                matchedTitle = bestTitle;
                fuzzyScore = bestScore;
                console.log(`[sync-return] Fuzzy match: "${grp.product}" → "${bestTitle}" (score=${bestScore.toFixed(2)})`);
              }
            }
          }
        }

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
          const cause = candidates.length === 0
            ? 'no_cache'
            : (!grp.size ? 'size_null' : 'size_mismatch');
          results.details.push({
            status: 'skipped_no_match',
            product: grp.product, size: grp.size, color: grp.color, qty: grp.totalQty,
            stock_ids: grp.items.map(i => i.id),
            cause,
            candidates_count: candidates.length,
            matched_shopify_title: matchedTitle || null,
            reason: candidates.length === 0
              ? 'Aucune variante dans le cache (sync-products-cache requis ?)'
              : `Aucune correspondance pour size=${grp.size} color=${grp.color} parmi ${candidates.length} candidats de "${matchedTitle}"`,
          });
          continue;
        }

        // FIX: Token-bucket throttle before each Shopify REST call (max 2 req/s)
        await shopifyThrottle();

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
          // adjustInventory is another Shopify call — throttle before it too
          await shopifyThrottle();
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
          product: grp.product,
          shopify_title: fuzzyScore ? matchedTitle : undefined,
          fuzzy_score: fuzzyScore ? Math.round(fuzzyScore * 100) : undefined,
          size: grp.size, color: grp.color,
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
