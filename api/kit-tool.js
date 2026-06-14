// TEMP endpoint — scan/update produits (retrait "Puma"). À SUPPRIMER après usage.
const { SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, shopifyAdminHeaders } = require('./_shopify-helpers');
const SECRET = 'touni-sync-2026';

module.exports = async (req, res) => {
  const q = req.query || {};
  if (q.secret !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
  try {
    const headers = await shopifyAdminHeaders();

    // scan tous les produits dont title|body|tags contient "puma"
    if (q.action === 'scan') {
      const needle = (q.q || 'puma').toLowerCase();
      const out = [];
      let url = `${base}/products.json?limit=250&fields=id,title,handle,body_html,tags`;
      while (url) {
        const r = await fetch(url, { headers }); const d = await r.json();
        for (const p of (d.products || [])) {
          const hay = ((p.title || '') + ' ' + (p.body_html || '') + ' ' + (p.tags || '')).toLowerCase();
          if (hay.includes(needle)) out.push({ id: p.id, title: p.title, body_html: p.body_html, tags: p.tags });
        }
        const link = r.headers.get('link') || ''; const m = link.match(/<([^>]+)>;\s*rel="next"/); url = m ? m[1] : null;
      }
      return res.status(200).json({ count: out.length, matches: out });
    }

    // métafields SEO d'un produit
    if (q.action === 'seo') {
      const mr = await fetch(`${base}/products/${q.id}/metafields.json`, { headers }); const md = await mr.json();
      return res.status(200).json({ metafields: (md.metafields || []).filter(m => m.key === 'title_tag' || m.key === 'description_tag').map(m => ({ key: m.key, value: m.value })) });
    }

    // mise à jour title/body/tags + SEO
    if (q.action === 'update' && req.method === 'POST') {
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body);
      const out = [];
      for (const u of body.updates) {
        const prod = { id: u.id };
        if (u.title != null) prod.title = u.title;
        if (u.body_html != null) prod.body_html = u.body_html;
        if (u.tags != null) prod.tags = u.tags;
        let ok = true, err = null;
        const r = await fetch(`${base}/products/${u.id}.json`, { method: 'PUT', headers, body: JSON.stringify({ product: prod }) });
        if (!r.ok) { ok = false; err = (await r.text()).slice(0, 120); }
        if (ok && u.seo_title != null) await fetch(`${base}/products/${u.id}/metafields.json`, { method: 'POST', headers, body: JSON.stringify({ metafield: { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: u.seo_title } }) });
        if (ok && u.seo_description != null) await fetch(`${base}/products/${u.id}/metafields.json`, { method: 'POST', headers, body: JSON.stringify({ metafield: { namespace: 'global', key: 'description_tag', type: 'multi_line_text_field', value: u.seo_description } }) });
        out.push({ id: u.id, ok, error: err });
      }
      return res.status(200).json({ updated: out });
    }

    return res.status(400).json({ error: 'bad action' });
  } catch (e) { return res.status(500).json({ error: String(e), stack: e.stack }); }
};
