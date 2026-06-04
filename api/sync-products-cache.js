// Synchronise le cache local des variantes Shopify (titre, size, color, inventory)
// Appelé manuellement (depuis le dashboard) ou via cron quotidien
// Auth: client_credentials via touni-master-api (auto-renouvelé)

const {
  SHOPIFY_CLIENT_ID, SHOPIFY_LOCATION_ID, SB_URL,
  shopifyAdminHeaders, supabaseHeaders,
  fetchShopifyProductsAdmin, normalizeSize, normalizeColor,
  SIZE_OPTION_NAMES, COLOR_OPTION_NAMES, SHOPIFY_DOMAIN, SHOPIFY_API_VERSION,
} = require('./_shopify-helpers.js');

function extractSizeColor(product, variant) {
  const opts = (product.options || []).map(o => ({
    name: (o.name || '').trim().toLowerCase(),
    pos: o.position - 1,
  }));
  const getOptVal = (v, pos) => {
    if (pos === 0) return v.option1;
    if (pos === 1) return v.option2;
    return v.option3;
  };
  const sizeOpt = opts.find(o => SIZE_OPTION_NAMES.has(o.name));
  const colorOpt = opts.find(o => COLOR_OPTION_NAMES.has(o.name));
  const size = sizeOpt !== undefined ? getOptVal(variant, sizeOpt.pos) : null;
  const color = colorOpt !== undefined ? getOptVal(variant, colorOpt.pos) : null;
  return { size: size || null, color: color || null };
}

// Batch fetch inventory levels (max 50 inventory_item_ids per request)
async function fetchInventoryLevelsBatch(inventoryItemIds) {
  const map = {}; // inventory_item_id → available
  const chunks = [];
  for (let i = 0; i < inventoryItemIds.length; i += 50) {
    chunks.push(inventoryItemIds.slice(i, i + 50));
  }
  for (const chunk of chunks) {
    const ids = chunk.join(',');
    const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels.json?inventory_item_ids=${ids}&location_ids=${SHOPIFY_LOCATION_ID}&limit=250`;
    const res = await fetch(url, { headers: await shopifyAdminHeaders() });
    if (!res.ok) {
      console.warn(`Inventory batch error: ${res.status} ${await res.text()}`);
      continue;
    }
    const data = await res.json();
    (data.inventory_levels || []).forEach(lvl => {
      map[lvl.inventory_item_id] = lvl.available || 0;
    });
  }
  return map;
}

module.exports = async function handler(req, res) {
  // Auth simple via secret query param ou header
  const expectedSecret = process.env.SYNC_SECRET || 'touni-sync-2026';
  const providedSecret = req.query?.secret || req.headers['x-sync-secret'];
  if (providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SHOPIFY_CLIENT_ID) {
    return res.status(503).json({
      error: 'SHOPIFY_CLIENT_ID not configured. Add it to Vercel env vars.',
    });
  }
  if (!SHOPIFY_LOCATION_ID) {
    return res.status(503).json({
      error: 'SHOPIFY_LOCATION_ID not configured. Run GET /api/list-shopify-locations to find it.',
    });
  }

  try {
    console.log('[sync-products-cache] Starting full sync...');
    const products = await fetchShopifyProductsAdmin();
    console.log(`[sync-products-cache] Fetched ${products.length} products`);

    // Build flat list of variants + collect inventory_item_ids
    const variants = [];
    const inventoryItemIds = [];
    for (const product of products) {
      for (const variant of (product.variants || [])) {
        const { size, color } = extractSizeColor(product, variant);
        variants.push({
          product_id: product.id,
          product_title: product.title,
          product_image: (product.images && product.images[0]) ? product.images[0].src : '',
          variant_id: variant.id,
          inventory_item_id: variant.inventory_item_id,
          size,
          color,
        });
        if (variant.inventory_item_id) {
          inventoryItemIds.push(variant.inventory_item_id);
        }
      }
    }
    console.log(`[sync-products-cache] Fetching inventory for ${inventoryItemIds.length} variants...`);
    const inventoryMap = await fetchInventoryLevelsBatch(inventoryItemIds);

    // Enrich variants with inventory_quantity
    const enriched = variants.map(v => ({
      ...v,
      inventory_quantity: inventoryMap[v.inventory_item_id] ?? 0,
      updated_at: new Date().toISOString(),
    }));

    // Upsert in Supabase (batch)
    console.log(`[sync-products-cache] Upserting ${enriched.length} variants in cache...`);
    const upsertUrl = `${SB_URL}/rest/v1/shopify_variants_cache?on_conflict=variant_id`;
    // Chunked inserts to avoid payload limits
    const CHUNK = 500;
    let upserted = 0;
    for (let i = 0; i < enriched.length; i += CHUNK) {
      const slice = enriched.slice(i, i + CHUNK);
      const r = await fetch(upsertUrl, {
        method: 'POST',
        headers: { ...supabaseHeaders(true), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(slice),
      });
      if (!r.ok) {
        console.error('Upsert error:', r.status, await r.text());
      } else {
        upserted += slice.length;
      }
    }

    return res.status(200).json({
      success: true,
      products_count: products.length,
      variants_count: enriched.length,
      upserted,
      out_of_stock: enriched.filter(v => v.inventory_quantity <= 0).length,
    });
  } catch (e) {
    console.error('[sync-products-cache] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
