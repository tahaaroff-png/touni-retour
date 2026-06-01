// Synchronisation Stock Retours → Shopify Inventory
//
// Workflow :
// 1. Récupère tous les items du stock retours non encore pushés (shopify_pushed_at IS NULL)
//    avec qty > 0 et status = 'retour'
// 2. Group par (product_title + size + color) → sum qty
// 3. Phase matching (tout Supabase, 0 appel Shopify) :
//    a. Match exact via shopify_variants_cache
//    b. Fuzzy fallback (titres pré-chargés une seule fois)
// 4. Phase inventory batch :
//    a. Collecte TOUS les inventory_item_ids à vérifier (cachedInv ≤ 0 ou null)
//    b. UN SEUL appel Shopify pour jusqu'à 50 ids
// 5. Push les ruptures (1 adjust.json par article en rupture — nombre limité)
// 6. Insère notification Supabase avec récap
//
// Méthode :
// - GET  → dry-run (analyse seulement, pas de push)
// - POST → exécute les pushs

const {
  SHOPIFY_CLIENT_ID, SHOPIFY_LOCATION_ID, SB_URL,
  shopifyAdminHeaders, supabaseHeaders,
  normalizeSize, normalizeColor,
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
} = require('./_shopify-helpers.js');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ── Shopify throttle (leaky bucket 40 calls, refill 2/s) ─────────────────────
const _bucket = { used: 0, total: 40 };
function _parseBucket(header) {
  if (!header) return;
  const [u, t] = header.split('/').map(Number);
  if (!isNaN(u)) _bucket.used = u;
  if (!isNaN(t)) _bucket.total = t;
}
async function _bucketDelay() {
  const remaining = _bucket.total - _bucket.used;
  if (remaining <= 4)  return sleep(3000);
  if (remaining <= 10) return sleep(1500);
  if (remaining <= 20) return sleep(800);
  return sleep(300);
}

async function _shopifyFetch(url, options = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await _bucketDelay();
    const hdrs = await shopifyAdminHeaders();
    const res = await fetch(url, { ...options, headers: { ...hdrs, ...(options.headers || {}) } });
    _parseBucket(res.headers.get('X-Shopify-Shop-Api-Call-Limit'));
    if (res.status === 429) {
      const wait = parseInt(res.headers.get('Retry-After') || '2') * 1000;
      console.warn(`[sync-return] 429 bucket=${_bucket.used}/${_bucket.total}, wait ${wait}ms (attempt ${attempt}/4)`);
      if (attempt < 4) { await sleep(wait); continue; }
      throw new Error('429: Rate limit after 4 attempts');
    }
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

// ── Batch inventory check : 1 seul appel Shopify pour N inventory_item_ids ──
// Shopify accepte jusqu'à 50 ids par appel.
async function getBatchInventoryLevels(inventoryItemIds) {
  if (!inventoryItemIds.length) return {};
  const results = {};
  const CHUNK = 50;
  for (let i = 0; i < inventoryItemIds.length; i += CHUNK) {
    const chunk = inventoryItemIds.slice(i, i + CHUNK);
    const url = `https://${_SD}/admin/api/${_SV}/inventory_levels.json?inventory_item_ids=${chunk.join(',')}&location_ids=${SHOPIFY_LOCATION_ID}`;
    const data = await _shopifyFetch(url, {});
    for (const level of (data.inventory_levels || [])) {
      results[String(level.inventory_item_id)] = level.available || 0;
    }
  }
  return results;
}

// ── Adjust inventory avec retry complet (tracking + connect + adjust) ─────────
// Séquence sur 422 :
//   1. Activer inventory_management:"shopify" sur la variante (tracking désactivé = cause principale)
//   2. Connecter l'inventory_item à la location
//   3. Réessayer l'adjust
async function adjustInventoryWithRetry(inventoryItemId, variantId, delta) {
  const adjustUrl = `https://${_SD}/admin/api/${_SV}/inventory_levels/adjust.json`;
  const connectUrl = `https://${_SD}/admin/api/${_SV}/inventory_levels/connect.json`;
  const adjustBody = JSON.stringify({
    location_id: parseInt(SHOPIFY_LOCATION_ID),
    inventory_item_id: parseInt(inventoryItemId),
    available_adjustment: parseInt(delta),
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    await _bucketDelay();
    const hdrs = await shopifyAdminHeaders();
    const res = await fetch(adjustUrl, { method: 'POST', body: adjustBody, headers: hdrs });
    _parseBucket(res.headers.get('X-Shopify-Shop-Api-Call-Limit'));

    if (res.status === 429) {
      const wait = parseInt(res.headers.get('Retry-After') || '2') * 1000;
      if (attempt < 3) { await sleep(wait); continue; }
      throw new Error('429: Rate limit on adjust');
    }

    if (res.status === 422 && attempt === 1) {
      const errBody = await res.text();
      console.warn(`[sync-return] 422 on adjust item=${inventoryItemId} variant=${variantId}: ${errBody}`);

      // Étape A — activer le tracking Shopify sur la variante
      if (variantId) {
        await _bucketDelay();
        const hA = await shopifyAdminHeaders();
        const trackRes = await fetch(`https://${_SD}/admin/api/${_SV}/variants/${variantId}.json`, {
          method: 'PUT', headers: hA,
          body: JSON.stringify({ variant: { id: parseInt(variantId), inventory_management: 'shopify' } }),
        });
        _parseBucket(trackRes.headers.get('X-Shopify-Shop-Api-Call-Limit'));
        if (!trackRes.ok) {
          console.warn(`[sync-return] Enable tracking failed (${trackRes.status}): ${await trackRes.text()}`);
        } else {
          console.log(`[sync-return] Tracking enabled for variant ${variantId}`);
        }
      }

      // Étape B — connecter à la location
      await _bucketDelay();
      const hB = await shopifyAdminHeaders();
      const connectRes = await fetch(connectUrl, {
        method: 'POST', headers: hB,
        body: JSON.stringify({ location_id: parseInt(SHOPIFY_LOCATION_ID), inventory_item_id: parseInt(inventoryItemId) }),
      });
      _parseBucket(connectRes.headers.get('X-Shopify-Shop-Api-Call-Limit'));
      if (!connectRes.ok) {
        console.warn(`[sync-return] Connect failed (${connectRes.status}): ${await connectRes.text()}`);
      } else {
        console.log(`[sync-return] Connected item ${inventoryItemId} to location ${SHOPIFY_LOCATION_ID}`);
      }

      continue; // Étape C — réessayer l'adjust
    }

    if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
    return res.json();
  }
  throw new Error('adjustInventoryWithRetry: max attempts reached');
}

// ── Fuzzy title matching ──────────────────────────────────────────────────────
function normTitle(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function titleSimilarity(a, b) {
  const wordsA = new Set(normTitle(a).split(' ').filter(w => w.length > 1));
  const wordsB = new Set(normTitle(b).split(' ').filter(w => w.length > 1));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let inter = 0;
  for (const w of wordsA) if (wordsB.has(w)) inter++;
  return inter / (wordsA.size + wordsB.size - inter);
}
const FUZZY_THRESHOLD = 0.65;

// ── Color / size helpers ──────────────────────────────────────────────────────
const COLOR_WORDS_IN_SIZE = new Set([
  'black','white','rouge','blanc','bleu','vert','noir','jaune','orange','rose',
  'violet','gris','brown','light brown','beige','gold','silver','or','argent',
  'red','blue','green','yellow','purple','grey','gray','pink','navy','marron','kaki',
]);

function parseSize(stockSize) {
  if (!stockSize) return { size: null, color: null };
  const s = String(stockSize).trim();
  if (s === '—' || s === '-' || s === 'N/A' || s === 'n/a') return { size: null, color: null };
  const sLow = s.toLowerCase();
  if (sLow === 'taille unique' || sLow === 'standard' || sLow === 'unique') return { size: null, color: null };
  if (COLOR_WORDS_IN_SIZE.has(sLow)) return { size: null, color: s };
  const parts = s.split('|');
  return { size: parts[0] ? parts[0].trim() : null, color: parts.length > 1 ? parts[1].trim() : null };
}

function groupKey(title, size, color) {
  return `${title}||${normalizeSize(size) || ''}||${normalizeColor(color) || ''}`;
}

const colMatch = (a, b) => {
  const na = normalizeColor(a), nb = normalizeColor(b);
  if (!na && !nb) return true;
  if (!na || !nb) return false;
  return na.toLowerCase() === nb.toLowerCase();
};

// ── Notification Supabase ─────────────────────────────────────────────────────
async function insertSyncNotification(isDryRun, results) {
  try {
    const pushedItems = results.details.filter(d => d.status === 'pushed' || d.status === 'would_push');
    const status =
      results.errors > 0 && pushedItems.length === 0 ? 'erreur' :
      pushedItems.length === 0 ? 'rien_a_pousser' :
      results.errors > 0 ? 'partiel' : 'succes';

    const notification = {
      type: isDryRun ? 'sync_dry_run' : 'sync_shopify',
      message: isDryRun
        ? `[DRY-RUN] ${pushedItems.length} articles seraient poussés`
        : `Sync terminé : ${pushedItems.length} article(s) poussé(s) vers Shopify`,
      data: {
        dry_run: isDryRun, status,
        checked: results.checked, pushed: results.pushed,
        skipped_has_stock: results.skipped_has_stock,
        skipped_no_match: results.skipped_no_match,
        errors: results.errors,
        pushed_items: pushedItems.map(d => ({
          product: d.product, shopify_title: d.shopify_title || null,
          fuzzy_score: d.fuzzy_score || null, size: d.size, color: d.color || null, qty: d.qty_pushed,
        })),
        no_match_items: results.details
          .filter(d => d.status === 'skipped_no_match')
          .map(d => ({ product: d.product, size: d.size, color: d.color || null, qty: d.qty, reason: d.reason, cause: d.cause || 'unknown' })),
      },
    };

    const r = await fetch(`${SB_URL}/rest/v1/shopify_notifications`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(notification),
    });
    if (!r.ok) console.warn('[sync-return] Notification insert failed:', await r.text());
    else console.log(`[sync-return] Notification inserted (status=${status})`);
  } catch (e) {
    console.warn('[sync-return] insertSyncNotification error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const expectedSecret = process.env.SYNC_SECRET || 'touni-sync-2026';
  const providedSecret = req.query?.secret || req.headers['x-sync-secret'];
  if (providedSecret !== expectedSecret) return res.status(401).json({ error: 'Unauthorized' });

  const isDryRun = req.method === 'GET';

  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_LOCATION_ID) {
    return res.status(503).json({ error: 'SHOPIFY_CLIENT_ID or SHOPIFY_LOCATION_ID not configured.' });
  }

  try {
    // ── ÉTAPE 1 : Charger le stock retours éligible ───────────────────────────
    const stockRes = await fetch(
      `${SB_URL}/rest/v1/stock?select=*&status=eq.retour&qty=gt.0&shopify_pushed_at=is.null`,
      { headers: supabaseHeaders() }
    );
    if (!stockRes.ok) throw new Error('Stock fetch error: ' + await stockRes.text());
    const stockItems = await stockRes.json();
    console.log(`[sync-return] ${stockItems.length} eligible stock items`);

    // ── ÉTAPE 2 : Grouper par (product + size + color) ────────────────────────
    const groups = {};
    for (const item of stockItems) {
      const { size, color } = parseSize(item.size);
      const key = groupKey(item.product, size, color);
      if (!groups[key]) groups[key] = { product: item.product, size, color, items: [], totalQty: 0 };
      groups[key].items.push(item);
      groups[key].totalQty += (item.qty || 0);
    }
    const groupKeys = Object.keys(groups);
    console.log(`[sync-return] ${groupKeys.length} unique product/size/color groups`);

    // ── ÉTAPE 3 : Pré-charger TOUS les titres du cache (1 seul appel Supabase) ─
    const allTitlesRes = await fetch(
      `${SB_URL}/rest/v1/shopify_variants_cache?select=product_title&limit=3000`,
      { headers: supabaseHeaders() }
    );
    const allCacheTitles = allTitlesRes.ok
      ? [...new Set((await allTitlesRes.json()).map(r => r.product_title).filter(Boolean))]
      : [];
    console.log(`[sync-return] Cache titles loaded: ${allCacheTitles.length}`);

    // ── ÉTAPE 4 : Matching Supabase (0 appel Shopify à cette étape) ───────────
    const matchedGroups = []; // { key, grp, match, matchedTitle, fuzzyScore }
    const unmatchedGroups = [];

    for (const key of groupKeys) {
      const grp = groups[key];
      const normSize = normalizeSize(grp.size);
      const normColor = normalizeColor(grp.color);
      let candidates = [];
      let matchedTitle = grp.product;
      let fuzzyScore = null;

      // Exact title match
      const exactRes = await fetch(
        `${SB_URL}/rest/v1/shopify_variants_cache?select=variant_id,inventory_item_id,inventory_quantity,size,color,product_title&product_title=eq.${encodeURIComponent(grp.product)}`,
        { headers: supabaseHeaders() }
      );
      if (exactRes.ok) candidates = await exactRes.json();

      // Fuzzy fallback (titres déjà en mémoire, 0 appel réseau supplémentaire)
      if (candidates.length === 0 && allCacheTitles.length > 0) {
        let bestScore = 0, bestTitle = null;
        for (const t of allCacheTitles) {
          const score = titleSimilarity(grp.product, t);
          if (score > bestScore) { bestScore = score; bestTitle = t; }
        }
        if (bestScore >= FUZZY_THRESHOLD && bestTitle) {
          const fuzzyRes = await fetch(
            `${SB_URL}/rest/v1/shopify_variants_cache?select=variant_id,inventory_item_id,inventory_quantity,size,color,product_title&product_title=eq.${encodeURIComponent(bestTitle)}`,
            { headers: supabaseHeaders() }
          );
          if (fuzzyRes.ok) {
            candidates = await fuzzyRes.json();
            matchedTitle = bestTitle;
            fuzzyScore = bestScore;
            console.log(`[sync-return] Fuzzy: "${grp.product}" → "${bestTitle}" (${(bestScore*100).toFixed(0)}%)`);
          }
        }
      }

      // Sélection du meilleur variant parmi les candidats
      let match =
        candidates.find(c => normalizeSize(c.size) === normSize && (normColor ? colMatch(c.color, normColor) : true)) ||
        (normSize ? candidates.find(c => normalizeSize(c.size) === normSize) : null) ||
        (!normSize && normColor ? candidates.find(c => normalizeSize(c.size) === null && colMatch(c.color, normColor)) : null) ||
        (!normSize && !normColor ? candidates.find(c => normalizeSize(c.size) === null) : null);

      if (!match) {
        const cause = candidates.length === 0 ? 'no_cache' : (!grp.size ? 'size_null' : 'size_mismatch');
        unmatchedGroups.push({ key, grp, cause, candidatesCount: candidates.length, matchedTitle });
      } else {
        matchedGroups.push({ key, grp, match, matchedTitle, fuzzyScore });
      }
    }

    // ── ÉTAPE 5 : Batch inventory check LIVE pour tous les articles matchés ──────
    // On vérifie TOUJOURS le vrai stock Shopify (pas le cache) pour éviter les
    // faux "skipped_has_stock" quand le cache est périmé.
    // Le batch rend ça rapide : 1 appel Shopify pour 50 ids au lieu de N appels.
    const liveInventoryIds = [...new Set(matchedGroups.map(mg => String(mg.match.inventory_item_id)))];

    console.log(`[sync-return] ${matchedGroups.length} matched → live inventory check for all ${liveInventoryIds.length} items (batch), ${unmatchedGroups.length} unmatched`);

    let liveInventory = {};
    if (liveInventoryIds.length > 0) {
      liveInventory = await getBatchInventoryLevels(liveInventoryIds);
    }

    // ── ÉTAPE 6 : Construire les résultats + push ─────────────────────────────
    const results = {
      checked: groupKeys.length,
      pushed: 0,
      skipped_has_stock: 0,
      skipped_no_match: unmatchedGroups.length,
      errors: 0,
      details: [],
    };

    // Articles sans match
    for (const { grp, cause, candidatesCount, matchedTitle } of unmatchedGroups) {
      results.details.push({
        status: 'skipped_no_match',
        product: grp.product, size: grp.size, color: grp.color, qty: grp.totalQty,
        stock_ids: grp.items.map(i => i.id),
        cause,
        candidates_count: candidatesCount,
        matched_shopify_title: matchedTitle || null,
        reason: candidatesCount === 0
          ? 'Aucune variante dans le cache (sync-products-cache requis ?)'
          : `Aucune correspondance pour size=${grp.size} color=${grp.color} parmi ${candidatesCount} candidats de "${matchedTitle}"`,
      });
    }

    // Articles matchés
    for (const { grp, match, matchedTitle, fuzzyScore } of matchedGroups) {
      try {
        const invItemId = String(match.inventory_item_id);

        // Stock Shopify en temps réel (toujours live, jamais cache)
        const liveInv = liveInventory[invItemId];
        const finalInv = liveInv !== undefined ? liveInv : null;

        if (finalInv === null) {
          // Pas de niveau d'inventaire → variante non connectée à la location
          // On tente quand même de pousser (adjustInventoryWithRetry gère le 422)
          console.warn(`[sync-return] No inventory level for item ${invItemId} — will attempt push anyway`);
        }

        if (finalInv !== null && finalInv > 0) {
          // Stock dispo sur Shopify → mettre à jour le cache et sauter
          await fetch(`${SB_URL}/rest/v1/shopify_variants_cache?variant_id=eq.${match.variant_id}`, {
            method: 'PATCH', headers: supabaseHeaders(),
            body: JSON.stringify({ inventory_quantity: finalInv, updated_at: new Date().toISOString() }),
          });
          results.skipped_has_stock++;
          results.details.push({ status: 'skipped_has_stock', product: grp.product, size: grp.size, color: grp.color, qty: grp.totalQty, shopify_inventory: finalInv });
          continue;
        }

        // Shopify = 0 → push
        if (!isDryRun) {
          await adjustInventoryWithRetry(match.inventory_item_id, match.variant_id, grp.totalQty);
          const now = new Date().toISOString();
          for (const item of grp.items) {
            const upRes = await fetch(`${SB_URL}/rest/v1/stock?id=eq.${item.id}`, {
              method: 'PATCH', headers: supabaseHeaders(),
              body: JSON.stringify({
                shopify_pushed_at: now,
                shopify_variant_id: String(match.variant_id),
                shopify_inventory_item_id: String(match.inventory_item_id),
                shopify_qty_pushed: item.qty,
              }),
            });
            if (!upRes.ok) console.warn('Stock update error:', await upRes.text());
          }
          // Mettre à jour le cache local
          await fetch(`${SB_URL}/rest/v1/shopify_variants_cache?variant_id=eq.${match.variant_id}`, {
            method: 'PATCH', headers: supabaseHeaders(),
            body: JSON.stringify({ inventory_quantity: grp.totalQty, updated_at: new Date().toISOString() }),
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
        results.details.push({ status: 'error', product: grp.product, size: grp.size, reason: e.message });
        console.error(`[sync-return] Error for ${grp.product}:`, e.message);
      }
    }

    console.log(`[sync-return] Done: pushed=${results.pushed}, skipped_stock=${results.skipped_has_stock}, no_match=${results.skipped_no_match}, errors=${results.errors}`);

    await insertSyncNotification(isDryRun, results);

    return res.status(200).json({ success: true, dry_run: isDryRun, ...results });
  } catch (e) {
    console.error('[sync-return] Fatal error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
