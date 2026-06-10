// TEMP endpoint — all/template/update/delete produits (audit titres). À SUPPRIMER après usage.
const { SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, shopifyAdminHeaders } = require('./_shopify-helpers');
const SECRET = 'touni-sync-2026';

module.exports = async (req, res) => {
  const q = req.query || {};
  if (q.secret !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
  try {
    const headers = await shopifyAdminHeaders();

    if (q.action === 'template') {
      const r = await fetch(`${base}/products/${q.id}.json`, { headers });
      const d = await r.json();
      if (!d.product) return res.status(404).json({ error: 'not found', raw: d });
      const p = d.product;
      return res.status(200).json({
        id: p.id, title: p.title, handle: p.handle, type: p.product_type, status: p.status,
        options: (p.options || []).map(o => ({ name: o.name, values: o.values })),
        variants_count: (p.variants || []).length,
        images_count: (p.images || []).length,
        body_120: (p.body_html || '').slice(0, 120),
      });
    }

    if (q.action === 'update' && req.method === 'POST') {
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body);
      const out = [];
      for (const u of body.updates) {
        const prod = {};
        if (u.title != null) prod.title = u.title;
        if (u.body_html != null) prod.body_html = u.body_html;
        if (u.product_type != null) prod.product_type = u.product_type;
        let ok = true, err = null;
        if (Object.keys(prod).length) {
          const r = await fetch(`${base}/products/${u.id}.json`, { method: 'PUT', headers, body: JSON.stringify({ product: Object.assign({ id: u.id }, prod) }) });
          if (!r.ok) { ok = false; err = await r.text(); }
        }
        if (ok && u.seo_title) await fetch(`${base}/products/${u.id}/metafields.json`, { method: 'POST', headers, body: JSON.stringify({ metafield: { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: u.seo_title } }) });
        out.push({ id: u.id, ok, error: err, new_title: u.title });
      }
      return res.status(200).json({ updated: out });
    }

    if (q.action === 'delete' && req.method === 'POST') {
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body);
      const out = [];
      for (const id of body.ids) {
        const r = await fetch(`${base}/products/${id}.json`, { method: 'DELETE', headers });
        out.push({ id, ok: r.ok, status: r.status });
      }
      return res.status(200).json({ deleted: out });
    }

    return res.status(400).json({ error: 'bad action' });
  } catch (e) {
    return res.status(500).json({ error: String(e), stack: e.stack });
  }
};
