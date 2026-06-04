// Setup webhooks : enregistre orders/create + products/* sur Shopify
// GET /api/setup-webhooks?secret=touni-sync-2026  → liste + crée si absent
// GET /api/setup-webhooks?secret=...&delete=ID     → supprime un webhook par ID

const {
  SHOPIFY_DOMAIN, SHOPIFY_API_VERSION,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const ORDER_WEBHOOK_URL   = 'https://touni-retour.vercel.app/api/shopify-order-webhook';
const PRODUCT_WEBHOOK_URL = 'https://touni-retour.vercel.app/api/shopify-webhook';

// topic → callback URL
const REQUIRED_WEBHOOKS = [
  { topic: 'orders/create',     url: ORDER_WEBHOOK_URL },
  { topic: 'orders/cancelled',  url: ORDER_WEBHOOK_URL },
  { topic: 'products/create',   url: PRODUCT_WEBHOOK_URL },
  { topic: 'products/update',   url: PRODUCT_WEBHOOK_URL },
  { topic: 'products/delete',   url: PRODUCT_WEBHOOK_URL },
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const expectedSecret = process.env.SYNC_SECRET || 'touni-sync-2026';
  if ((req.query?.secret || req.headers['x-sync-secret']) !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const headers = await shopifyAdminHeaders();
    const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;

    // ── DELETE mode ──────────────────────────────────────────────────────────
    if (req.query.delete) {
      const delId = parseInt(req.query.delete);
      const dr = await fetch(`${base}/webhooks/${delId}.json`, { method: 'DELETE', headers });
      return res.status(200).json({ deleted: delId, ok: dr.ok });
    }

    // ── LIST existing webhooks ───────────────────────────────────────────────
    const listRes = await fetch(`${base}/webhooks.json`, { headers });
    if (!listRes.ok) throw new Error(`List webhooks ${listRes.status}: ${await listRes.text()}`);
    const { webhooks: existing } = await listRes.json();

    const report = { existing: [], created: [], already_ok: [] };
    existing.forEach(w => report.existing.push({ id: w.id, topic: w.topic, address: w.address }));

    // ── CREATE missing webhooks ───────────────────────────────────────────────
    for (const { topic, url: callbackUrl } of REQUIRED_WEBHOOKS) {
      const found = existing.find(w => w.topic === topic && w.address === callbackUrl);
      if (found) {
        report.already_ok.push({ id: found.id, topic });
        continue;
      }
      // Remove stale entries for same topic pointing elsewhere
      const stale = existing.filter(w => w.topic === topic && w.address !== callbackUrl);
      for (const s of stale) {
        await fetch(`${base}/webhooks/${s.id}.json`, { method: 'DELETE', headers });
        console.log(`[setup-webhooks] Deleted stale webhook ${s.id} (${s.address})`);
      }
      // Create fresh webhook
      const createRes = await fetch(`${base}/webhooks.json`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          webhook: {
            topic,
            address: callbackUrl,
            format: 'json',
          },
        }),
      });
      if (!createRes.ok) {
        const err = await createRes.text();
        report.created.push({ topic, error: err });
        console.error(`[setup-webhooks] Create failed for ${topic}:`, err);
      } else {
        const { webhook: w } = await createRes.json();
        report.created.push({ id: w.id, topic: w.topic, address: w.address });
        console.log(`[setup-webhooks] Created webhook ${w.id} for ${topic}`);
      }
    }

    return res.status(200).json({
      success: true,
      ...report,
    });
  } catch (e) {
    console.error('[setup-webhooks] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
