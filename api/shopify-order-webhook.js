// Webhook Shopify orders/create
// Pour chaque ligne de commande, vérifie si le produit + variante existe dans notre stock retours
// Si OUI → crée une entrée dans shopify_notifications (visible côté admin)
//
// L'OPÉRATRICE gère ensuite manuellement le statut (vendu / mystère) — pas d'auto-déduction.

const crypto = require('crypto');
const { SB_URL, supabaseHeaders, normalizeSize, normalizeColor } = require('./_shopify-helpers.js');

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_ORDER_WEBHOOK_SECRET || process.env.SHOPIFY_WEBHOOK_SECRET || '';

function verifySignature(rawBody, signature) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true; // dev mode : skip
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(rawBody).digest('base64');
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

async function findMatchingStock(productTitle, size, color) {
  const normSize = normalizeSize(size);
  const normColor = normalizeColor(color);
  // Fetch all matching products by title with qty > 0 and status = retour
  const url = `${SB_URL}/rest/v1/stock?select=id,size,qty,status&product=eq.${encodeURIComponent(productTitle)}&qty=gt.0&status=eq.retour`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) return [];
  const candidates = await res.json();
  if (!candidates.length) return [];
  // Filter by size + color (using stock.size format "M | Black")
  return candidates.filter(c => {
    const parts = String(c.size || '').split('|');
    const cSize = parts[0] ? parts[0].trim() : '';
    const cColor = parts.length > 1 ? parts[1].trim() : '';
    if (normalizeSize(cSize) !== normSize) return false;
    if (normColor && normalizeColor(cColor) !== normColor) return false;
    return true;
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Read raw body for HMAC verification
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString();

  const signature = req.headers['x-shopify-hmac-sha256'];
  if (!verifySignature(rawBody, signature)) {
    console.warn('[order-webhook] Invalid HMAC signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let order;
  try {
    order = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
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
        matched_qty: totalMatchedQty,
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
      headers: { ...supabaseHeaders(), Prefer: 'resolution=ignore-duplicates,return=representation' },
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
};
