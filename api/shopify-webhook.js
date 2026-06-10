// Vercel serverless function — Shopify product webhook handler
// Topics: products/create, products/update, products/delete
// Action: syncs the changed product's variants into Supabase shopify_variants_cache
// Uses _shopify-helpers.js for Supabase auth (service key)

const crypto = require('crypto');
const {
  SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, SHOPIFY_LOCATION_ID,
  shopifyAdminHeaders, supabaseHeaders,
  SIZE_OPTION_NAMES, COLOR_OPTION_NAMES,
  SB_URL,
} = require('./_shopify-helpers.js');

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// ── HMAC verification ─────────────────────────────────────────────────────────
function verifyHmac(rawBody, signature) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true; // skip if not configured
  const expected = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
  } catch {
    return false;
  }
}

// ── Extract size/color from product options ───────────────────────────────────
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

// ── Fetch inventory for a list of inventory_item_ids ─────────────────────────
async function fetchInventory(inventoryItemIds) {
  const map = {};
  if (!inventoryItemIds.length) return map;
  const ids = inventoryItemIds.join(',');
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels.json?inventory_item_ids=${ids}&location_ids=${SHOPIFY_LOCATION_ID}&limit=250`;
  const res = await fetch(url, { headers: await shopifyAdminHeaders() });
  if (!res.ok) {
    console.warn(`[shopify-webhook] Inventory fetch error: ${res.status}`);
    return map;
  }
  const data = await res.json();
  (data.inventory_levels || []).forEach(lvl => {
    map[lvl.inventory_item_id] = lvl.available ?? 0;
  });
  return map;
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Read raw body for HMAC
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString();

  if (!verifyHmac(rawBody, req.headers['x-shopify-hmac-sha256'])) {
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  const topic = req.headers['x-shopify-topic'] || '';
  let product;
  try {
    product = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  // ── DELETE: remove variants from cache ───────────────────────────────────
  if (topic === 'products/delete') {
    const productId = product.id;
    if (!productId) return res.status(200).json({ ok: true, action: 'delete_skipped' });
    const sbRes = await fetch(
      `${SB_URL}/rest/v1/shopify_variants_cache?product_id=eq.${productId}`,
      { method: 'DELETE', headers: supabaseHeaders(true) }
    );
    console.log(`[shopify-webhook] DELETE product ${productId}: ${sbRes.status}`);
    return res.status(200).json({ ok: true, action: 'deleted', product_id: productId });
  }

  // ── CREATE / UPDATE: upsert variants ─────────────────────────────────────
  if (!product.variants || !product.variants.length) {
    return res.status(200).json({ ok: true, action: 'no_variants' });
  }

  // Fetch inventory
  const inventoryItemIds = product.variants
    .map(v => v.inventory_item_id)
    .filter(Boolean);
  const inventoryMap = await fetchInventory(inventoryItemIds);

  // Build upsert payload
  const productImage = (product.images && product.images[0]) ? product.images[0].src : '';
  const rows = product.variants.map(variant => {
    const { size, color } = extractSizeColor(product, variant);
    return {
      product_id: product.id,
      product_title: product.title,
      product_image: productImage,
      variant_id: variant.id,
      inventory_item_id: variant.inventory_item_id,
      size: size || null,
      color: color || null,
      inventory_quantity: inventoryMap[variant.inventory_item_id] ?? 0,
      status: product.status || 'active',
      updated_at: new Date().toISOString(),
    };
  });

  // Upsert to Supabase
  const upsertRes = await fetch(
    `${SB_URL}/rest/v1/shopify_variants_cache?on_conflict=variant_id`,
    {
      method: 'POST',
      headers: {
        ...supabaseHeaders(true),
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    }
  );

  if (!upsertRes.ok) {
    const err = await upsertRes.text();
    console.error(`[shopify-webhook] Upsert error: ${upsertRes.status}`, err);
    return res.status(500).json({ error: `Supabase upsert failed: ${upsertRes.status}` });
  }

  console.log(`[shopify-webhook] ${topic} → upserted ${rows.length} variants for "${product.title}"`);
  return res.status(200).json({
    ok: true,
    action: topic,
    product_id: product.id,
    product_title: product.title,
    variants_synced: rows.length,
  });
};
