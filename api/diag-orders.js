// Diagnostic: dernières commandes Shopify + état webhook + matching stock
// GET /api/diag-orders?secret=touni-sync-2026&limit=5
const crypto = require('crypto');
const { SB_URL, supabaseHeaders, shopifyAdminHeaders, SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, normalizeSize, normalizeColor } = require('./_shopify-helpers.js');

const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';

function jaccardSim(a, b) {
  const tok = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  const sa = tok(a), sb = tok(b);
  if (!sa.size || !sb.size) return 0;
  let i = 0; for (const t of sa) if (sb.has(t)) i++;
  return i / (sa.size + sb.size - i);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const expected = process.env.SYNC_SECRET || 'touni-sync-2026';
  if ((req.query?.secret || req.headers['x-sync-secret']) !== expected)
    return res.status(401).json({ error: 'Unauthorized' });

  const limit = parseInt(req.query.limit) || 5;

  try {
    const headers = await shopifyAdminHeaders();
    const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;

    // 1. Dernières commandes Shopify
    const ordersRes = await fetch(`${base}/orders.json?limit=${limit}&status=any&order=created_at+desc`, { headers });
    const { orders } = await ordersRes.json();

    // 2. Webhooks actifs
    const whRes = await fetch(`${base}/webhooks.json`, { headers });
    const { webhooks } = await whRes.json();

    // 3. Stock retour actuel
    const stockRes = await fetch(`${SB_URL}/rest/v1/stock?select=id,product,size,qty&qty=gt.0&status=eq.retour&limit=200`, { headers: supabaseHeaders() });
    const retourStock = stockRes.ok ? await stockRes.json() : [];

    // 4. Pour chaque commande, simuler le matching
    const report = orders.map(order => {
      const lineItems = (order.line_items || []).map(item => {
        const title = item.title || '';
        const variantTitle = item.variant_title || '';
        const parts = variantTitle.split(/\s*[\/\|]\s*/).map(p => p.trim());
        const SL = new Set(['XS','S','M','L','XL','XXL','2XL','3XL','4XL']);
        let size = null, color = null;
        if (parts.length === 1) { if (SL.has(parts[0].toUpperCase())) size = parts[0]; else color = parts[0]; }
        else { size = parts[0]||null; color = parts.slice(1).join('/')||null; }

        const normSize  = normalizeSize(size);
        const normColor = normalizeColor(color);

        // Exact match
        let candidates = retourStock.filter(s => s.product === title);
        // Fuzzy if no exact
        if (!candidates.length) {
          const scored = retourStock.map(s => ({...s, _sc: jaccardSim(title, s.product)}))
            .filter(s => s._sc >= 0.50).sort((a,b)=>b._sc-a._sc);
          if (scored.length) {
            const top = scored[0]._sc;
            candidates = scored.filter(s => s._sc >= top - 0.05);
          }
        }

        // Filter by size+color
        const matched = candidates.filter(c => {
          const p = String(c.size||'').split('|');
          const cs = p[0]?p[0].trim():'', cc = p.length>1?p[1].trim():'';
          if (normalizeSize(cs) !== normSize) return false;
          if (normColor && normalizeColor(cc) !== normColor) return false;
          return true;
        });

        return { title, variantTitle, size, color, normSize, normColor, candidatesCount: candidates.length, matched: matched.map(m=>({id:m.id,product:m.product,size:m.size,qty:m.qty})) };
      });

      // Check if webhook HMAC would work (compute expected HMAC on a dummy body)
      const dummyBody = JSON.stringify({id: order.id});
      const expectedHmac = SHOPIFY_CLIENT_SECRET
        ? crypto.createHmac('sha256', SHOPIFY_CLIENT_SECRET).update(dummyBody).digest('base64').slice(0,8)+'...'
        : 'NO_SECRET';

      return {
        order: order.name,
        id: order.id,
        created_at: order.created_at,
        customer: `${order.customer?.first_name||''} ${order.customer?.last_name||''}`.trim() || order.shipping_address?.name || 'Inconnu',
        line_items: lineItems,
        would_create_notifications: lineItems.filter(i => i.matched.length > 0).length,
      };
    });

    return res.status(200).json({
      shopify_client_secret_set: !!SHOPIFY_CLIENT_SECRET,
      secret_prefix: SHOPIFY_CLIENT_SECRET ? SHOPIFY_CLIENT_SECRET.slice(0,6)+'...' : null,
      webhooks: webhooks.map(w=>({id:w.id, topic:w.topic, address:w.address, created_at:w.created_at})),
      retour_stock_count: retourStock.length,
      orders: report,
    });
  } catch(e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0,300) });
  }
};
