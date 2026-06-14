// TEMP endpoint — upload image produit. À SUPPRIMER après usage.
const { SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, shopifyAdminHeaders } = require('./_shopify-helpers');
const SECRET = 'touni-sync-2026';

module.exports = async (req, res) => {
  const q = req.query || {};
  if (q.secret !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
  try {
    const headers = await shopifyAdminHeaders();
    if (q.action === 'img' && req.method === 'POST') {
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body);
      const out = [];
      for (const it of body.images) {
        const payload = { image: { attachment: it.b64, position: it.position || 1 } };
        if (it.alt) payload.image.alt = it.alt;
        if (it.variant_ids) payload.image.variant_ids = it.variant_ids;
        const r = await fetch(`${base}/products/${it.product_id}/images.json`, { method: 'POST', headers, body: JSON.stringify(payload) });
        const d = await r.json();
        out.push({ product_id: it.product_id, ok: r.ok, image_id: d.image && d.image.id, error: r.ok ? undefined : JSON.stringify(d).slice(0, 150) });
      }
      return res.status(200).json({ uploaded: out });
    }
    return res.status(400).json({ error: 'bad action' });
  } catch (e) { return res.status(500).json({ error: String(e), stack: e.stack }); }
};
