// Webhook Shopify orders/create
// Pour chaque ligne de commande, vérifie si le produit + variante existe dans notre stock retours
// Si OUI → crée une entrée dans shopify_notifications (visible côté admin)
//
// IMPORTANT: bodyParser must be disabled so we can read the raw body for HMAC verification
// L'OPÉRATRICE gère ensuite manuellement le statut (vendu / mystère) — pas d'auto-déduction.

const crypto = require('crypto');
const { SB_URL, supabaseHeaders, normalizeSize, normalizeColor } = require('./_shopify-helpers.js');
const lv = require('./_lv-shopify.js');

// Shopify REST API webhooks are signed with the app's CLIENT_SECRET (not a separate webhook secret)
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_CLIENT_SECRET
  || process.env.SHOPIFY_ORDER_WEBHOOK_SECRET
  || process.env.SHOPIFY_WEBHOOK_SECRET
  || '';

function verifySignature(rawBody, signature, secret) {
  const key = secret || SHOPIFY_WEBHOOK_SECRET;
  if (!key) return true; // dev mode : skip
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', key).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// Extract size + color from a Shopify line_item via variant_title
// Variant title pattern : "S / Black" or "M" or "Black"
function parseVariantTitle(variantTitle) {
  if (!variantTitle) return { size: null, color: null };
  const parts = variantTitle.split(/\s*[\/\|]\s*/).map(p => p.trim());
  // Heuristic : if first part is a size (S/M/L/XL/2XL/3XL/4XL/XS), it's size
  const SIZE_LITERALS = new Set(['XS','S','M','L','XL','XXL','2XL','3XL','4XL']);
  if (parts.length === 1) {
    // Could be size or color
    return SIZE_LITERALS.has(parts[0].toUpperCase()) ? { size: parts[0], color: null } : { size: null, color: parts[0] };
  }
  return { size: parts[0] || null, color: parts.slice(1).join(' / ') || null };
}

// Jaccard token similarity (same as sync-return-to-shopify.js)
function jaccardSim(a, b) {
  const tokenize = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

const FUZZY_THRESHOLD = 0.55; // slightly lower than sync (0.65) to catch more variants

async function findMatchingStock(productTitle, size, color) {
  const normSize = normalizeSize(size);
  const normColor = normalizeColor(color);

  // 1) Try exact title match first (fast path)
  const exactUrl = `${SB_URL}/rest/v1/stock?select=id,product,size,qty,status&product=eq.${encodeURIComponent(productTitle)}&qty=gt.0&status=in.(retour,stock)`;
  const exactRes = await fetch(exactUrl, { headers: supabaseHeaders(true) });
  let exactCandidates = exactRes.ok ? (await exactRes.json()) : [];

  // Filter by size+color
  const filterBySizeColor = (rows) => rows.filter(c => {
    const parts = String(c.size || '').split('|');
    const cSize = parts[0] ? parts[0].trim() : '';
    const cColor = parts.length > 1 ? parts[1].trim() : '';
    if (normalizeSize(cSize) !== normSize) return false;
    if (normColor && normalizeColor(cColor) !== normColor) return false;
    return true;
  });

  const exactMatched = filterBySizeColor(exactCandidates);
  if (exactMatched.length) return exactMatched;

  // 2) Fuzzy fallback: fetch all retour stock items and score by title similarity
  const allUrl = `${SB_URL}/rest/v1/stock?select=id,product,size,qty,status&qty=gt.0&status=in.(retour,stock)&limit=500`;
  const allRes = await fetch(allUrl, { headers: supabaseHeaders(true) });
  if (!allRes.ok) return [];
  const allStock = await allRes.json();

  // Group by product title, take best title match above threshold
  const scored = allStock
    .map(s => ({ ...s, _score: jaccardSim(productTitle, s.product) }))
    .filter(s => s._score >= FUZZY_THRESHOLD)
    .sort((a, b) => b._score - a._score);

  if (!scored.length) {
    console.log(`[order-webhook] No fuzzy match for "${productTitle}" (threshold ${FUZZY_THRESHOLD})`);
    return [];
  }

  // Take the best score cluster (within 5% of top score)
  const topScore = scored[0]._score;
  const bestGroup = scored.filter(s => s._score >= topScore - 0.05);
  console.log(`[order-webhook] Fuzzy match "${productTitle}" → "${bestGroup[0].product}" (score=${topScore.toFixed(2)})`);

  return filterBySizeColor(bestGroup);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Read raw body for HMAC verification (bodyParser: false is required above)
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString();

  const signature = req.headers['x-shopify-hmac-sha256'];
  const topic = req.headers['x-shopify-topic'] || 'unknown';
  console.log(`[order-webhook] Received topic=${topic} rawBody.length=${rawBody.length} sig=${signature ? 'present' : 'MISSING'} secret_env=${SHOPIFY_WEBHOOK_SECRET ? 'SET('+SHOPIFY_WEBHOOK_SECRET.slice(0,6)+'...)' : 'EMPTY→skip'}`);

  // ── LE VESTIAIRE : commande → déduction immédiate du stock + resync partout ──
  const shopDomain = String(req.headers['x-shopify-shop-domain'] || '');
  if (shopDomain.includes('gvsffq-rq') || shopDomain.includes('levestiaire')) {
    if (!verifySignature(rawBody, signature, lv.LV_CLIENT_SECRET)) {
      console.warn('[lv-webhook] HMAC FAILED');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    let lvOrder;
    try { lvOrder = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    try {
      const orderName = 'LV ' + (lvOrder.name || lvOrder.order_number || lvOrder.id);
      const cust = lvOrder.customer || lvOrder.shipping_address || {};
      const custName = [cust.first_name, cust.last_name].filter(Boolean).join(' ') || (lvOrder.shipping_address?.name) || 'Client';
      const custCity = lvOrder.shipping_address?.city || cust.city || '';
      const results = [];
      for (const item of (lvOrder.line_items || [])) {
        const title = item.title || '';
        if (!title || /^(flocage|patch)\b/i.test(title)) continue; // options perso : pas de stock physique
        const { size, color } = parseVariantTitle(item.variant_title || '');
        const matches = await findMatchingStock(title, size, color);
        const qty = Number(item.quantity) || 1;
        let dec = { updates: [], remaining: qty };
        if (matches.length) dec = await lv.decrementStockRows(matches, qty);
        results.push({ title, size, ordered: qty, decremented: qty - dec.remaining, unmatched: dec.remaining });
        // notification pour l'opératrice (visibilité côté gestionnaire)
        await fetch(`${SB_URL}/rest/v1/shopify_notifications?on_conflict=shopify_order_id,shopify_variant_id`, {
          method: 'POST',
          headers: { ...supabaseHeaders(true), Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify([{
            shopify_order_id: lvOrder.id,
            shopify_order_number: orderName,
            customer_name: custName,
            customer_city: custCity,
            product_title: title,
            variant_size: size,
            variant_color: color,
            shopify_variant_id: item.variant_id ? String(item.variant_id) : null,
            matched_stock_ids: matches.map(m => m.id),
            matched_qty: matches.reduce((sm, m) => sm + (m.qty || 0), 0),
            ordered_qty: qty,
            total_amount_mad: parseFloat(lvOrder.total_price || 0),
          }]),
        }).catch(() => {});
      }
      let sync = null;
      try { sync = await lv.reconcileInventory(); } catch (e) { console.error('[lv-webhook] reconcile:', e.message); }
      console.log(`[lv-webhook] ${orderName}:`, JSON.stringify(results));
      return res.status(200).json({ shop: 'levestiaire', order: orderName, items: results, sync });
    } catch (e) {
      console.error('[lv-webhook] Error:', e.message);
      return res.status(200).json({ error: e.message }); // 200 pour éviter les retries en boucle
    }
  }

  if (!verifySignature(rawBody, signature)) {
    console.warn('[order-webhook] HMAC FAILED — secret may be wrong. sig=', signature, 'secret_prefix=', SHOPIFY_WEBHOOK_SECRET.slice(0,6));
    // Log to Supabase for visibility
    await fetch(`${SB_URL}/rest/v1/shopify_notifications`, {
      method: 'POST',
      headers: { ...supabaseHeaders(true), Prefer: 'return=minimal' },
      body: JSON.stringify([{ type: 'webhook_error', status: 'unread', message: `HMAC failed — topic:${topic} sig:${signature?.slice(0,12)} rawLen:${rawBody.length}` }]),
    }).catch(() => {});
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let order;
  try {
    order = JSON.parse(rawBody);
  } catch (e) {
    console.error('[order-webhook] JSON parse error:', e.message, '| rawBody[:100]:', rawBody.slice(0, 100));
    return res.status(400).json({ error: 'Invalid JSON', detail: e.message });
  }

  try {
    const orderId = order.id;
    const orderName = order.name || order.order_number || `#${orderId}`;
    const customer = order.customer || order.shipping_address || {};
    const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || (order.shipping_address?.name) || 'Client';
    const customerCity = order.shipping_address?.city || customer.city || '';
    const totalAmount = parseFloat(order.total_price || 0);

    const lineItems = order.line_items || [];
    console.log(`[order-webhook] Order ${orderName} : ${lineItems.length} line items`);

    const notifications = [];
    for (const item of lineItems) {
      const productTitle = item.title || item.name?.split(' - ')[0] || '';
      const variantTitle = item.variant_title || '';
      const { size, color } = parseVariantTitle(variantTitle);
      const variantId = item.variant_id;

      // Skip if no product title
      if (!productTitle) continue;

      // Look for matching stock items
      const matches = await findMatchingStock(productTitle, size, color);
      if (!matches.length) continue;

      // We have a match → create notification
      const totalMatchedQty = matches.reduce((sum, m) => sum + (m.qty || 0), 0);
      const stockIds = matches.map(m => m.id);

      notifications.push({
        shopify_order_id: orderId,
        shopify_order_number: orderName,
        customer_name: customerName,
        customer_city: customerCity,
        product_title: productTitle,
        variant_size: size,
        variant_color: color,
        shopify_variant_id: variantId ? String(variantId) : null,
        matched_stock_ids: stockIds,
        matched_qty: totalMatchedQty,          // stock disponible (info)
        ordered_qty: Number(item.quantity) || 1, // quantité commandée → à décrémenter à l'expédition
        total_amount_mad: totalAmount,
      });
    }

    if (notifications.length === 0) {
      console.log(`[order-webhook] No matches for order ${orderName}`);
      return res.status(200).json({ created: 0, message: 'No matches' });
    }

    // Insert notifications (upsert to handle Shopify webhook retries — dedup on order+variant)
    const insertUrl = `${SB_URL}/rest/v1/shopify_notifications?on_conflict=shopify_order_id,shopify_variant_id`;
    const insertRes = await fetch(insertUrl, {
      method: 'POST',
      headers: { ...supabaseHeaders(true), Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify(notifications),
    });
    if (!insertRes.ok) {
      const errTxt = await insertRes.text();
      console.error('[order-webhook] Insert error:', errTxt);
      return res.status(500).json({ error: 'DB insert failed', details: errTxt });
    }
    const inserted = await insertRes.json();
    console.log(`[order-webhook] Created ${inserted.length} notifications for order ${orderName}`);
    return res.status(200).json({ created: inserted.length, order: orderName });
  } catch (e) {
    console.error('[order-webhook] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// MUST be set after function declaration — disables Vercel body auto-parsing
// so we can read the raw body and verify Shopify's HMAC signature
handler.config = { api: { bodyParser: false } };
// Exports nommés pour réutilisation (ex : scan-orders-stock)
handler.findMatchingStock = findMatchingStock;
handler.parseVariantTitle = parseVariantTitle;
module.exports = handler;
