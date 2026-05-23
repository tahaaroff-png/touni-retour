// Auto-test du webhook orders/create — appelle /api/shopify-order-webhook
// avec un HMAC valide généré côté serveur (utilise SHOPIFY_CLIENT_SECRET réel)
// GET /api/selftest-webhook?secret=touni-sync-2026&title=...&size=...&variant_id=...

const crypto = require('crypto');

const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const expectedSecret = process.env.SYNC_SECRET || 'touni-sync-2026';
  if ((req.query?.secret || req.headers['x-sync-secret']) !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const title = req.query.title || 'Maillot Maroc domicile coupe du monde 2026/2027';
  const size  = req.query.size  || 'L';
  const color = req.query.color || null;
  const variantId = parseInt(req.query.variant_id) || 88000000001;

  // Build a fake but realistic Shopify order payload
  const fakeOrder = {
    id: 99888000001,
    name: '#TEST-SELFTEST',
    order_number: 9001,
    total_price: '350.00',
    customer: { first_name: 'Test', last_name: 'SelfTest' },
    shipping_address: { city: 'Casablanca', name: 'Test SelfTest' },
    line_items: [
      {
        id: 1,
        title: title,
        variant_title: color ? `${size} / ${color}` : size,
        variant_id: variantId,
        quantity: 1,
        price: '350.00',
      },
    ],
  };

  const body = JSON.stringify(fakeOrder);

  // Compute HMAC with the real client secret
  let hmac = 'NO_SECRET_CONFIGURED';
  let secretConfigured = false;
  if (SHOPIFY_CLIENT_SECRET) {
    hmac = crypto.createHmac('sha256', SHOPIFY_CLIENT_SECRET).update(body).digest('base64');
    secretConfigured = true;
  }

  // Call the real webhook endpoint
  const webhookUrl = `https://touni-retour.vercel.app/api/shopify-order-webhook`;
  let webhookRes, webhookBody;
  try {
    webhookRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': 'orders/create',
        'X-Shopify-Hmac-Sha256': hmac,
        'X-Shopify-Shop-Domain': process.env.SHOPIFY_DOMAIN || 'bjuanm-1r.myshopify.com',
      },
      body,
    });
    webhookBody = await webhookRes.json().catch(() => webhookRes.text());
  } catch (e) {
    return res.status(500).json({ error: 'Fetch to webhook failed: ' + e.message });
  }

  return res.status(200).json({
    test_payload: { title, size, color, variantId },
    secret_configured: secretConfigured,
    secret_prefix: SHOPIFY_CLIENT_SECRET ? SHOPIFY_CLIENT_SECRET.slice(0, 6) + '...' : null,
    hmac_sent: hmac.slice(0, 16) + '...',
    webhook_status: webhookRes.status,
    webhook_response: webhookBody,
  });
};
