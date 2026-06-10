// TEMP endpoint — find/template/update produits (audit titres). À SUPPRIMER après usage.
const { SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, shopifyAdminHeaders } = require('./_shopify-helpers');
const SECRET = 'touni-sync-2026';

module.exports = async (req, res) => {
  const q = req.query || {};
  if (q.secret !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
  try {
    const headers = await shopifyAdminHeaders();

    // liste TOUS les produits (id,title,type,handle) — pour audit doublons
    if (q.action === 'all') {
      const out = [];
      let url = `${base}/products.json?limit=250&fields=id,title,handle,product_type,status`;
      while (url) {
        const r = await fetch(url, { headers });
        const d = await r.json();
        for (const p of (d.products || [])) out.push({ id: p.id, title: p.title, handle: p.handle, type: p.product_type, status: p.status });
        const link = r.headers.get('link') || '';
        const m = link.match(/<([^>]+)>;\s*rel="next"/);
        url = m ? m[1] : null;
      }
      return res.status(200).json({ count: out.length, products: out });
    }

    if (q.action === 'template') {
      const r = await fetch(`${base}/products/${q.id}.json`, { headers });
      const d = await r.json();
      if (!d.product) return res.status(404).json({ error: 'not found', raw: d });
      const p = d.product;
      const mr = await fetch(`${base}/products/${q.id}/metafields.json`, { headers });
      const md = await mr.json();
      return res.status(200).json({
        id: p.id, title: p.title, handle: p.handle, type: p.product_type, vendor: p.vendor, status: p.status,
        tags: p.tags, body_html: p.body_html,
        images: (p.images || []).map(i => ({ id: i.id, src: i.src, alt: i.alt })),
        options: (p.options || []).map(o => ({ name: o.name, values: o.values })),
        price: p.variants && p.variants[0] ? p.variants[0].price : null,
        compare_at: p.variants && p.variants[0] ? p.variants[0].compare_at_price : null,
        metafields: (md.metafields || []).filter(m => m.key === 'title_tag' || m.key === 'description_tag').map(m => ({ key: m.key, value: m.value })),
      });
    }

    // MAJ titre/description/type/seo d'un produit
    if (q.action === 'update' && req.method === 'POST') {
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body);
      const out = [];
      for (const u of body.updates) {
        const prod = {};
        if (u.title != null) prod.title = u.title;
        if (u.body_html != null) prod.body_html = u.body_html;
        if (u.product_type != null) prod.product_type = u.product_type;
        if (u.tags != null) prod.tags = u.tags;
        let ok = true, err = null;
        if (Object.keys(prod).length) {
          const r = await fetch(`${base}/products/${u.id}.json`, { method: 'PUT', headers, body: JSON.stringify({ product: Object.assign({ id: u.id }, prod) }) });
          if (!r.ok) { ok = false; err = await r.text(); }
        }
        // SEO metafields
        if (ok && (u.seo_title || u.seo_description)) {
          const mfs = [];
          if (u.seo_title) mfs.push({ namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: u.seo_title });
          if (u.seo_description) mfs.push({ namespace: 'global', key: 'description_tag', type: 'multi_line_text_field', value: u.seo_description });
          for (const mf of mfs) await fetch(`${base}/products/${u.id}/metafields.json`, { method: 'POST', headers, body: JSON.stringify({ metafield: mf }) });
        }
        out.push({ id: u.id, ok, error: err, new_title: u.title });
      }
      return res.status(200).json({ updated: out });
    }

    return res.status(400).json({ error: 'bad action' });
  } catch (e) {
    return res.status(500).json({ error: String(e), stack: e.stack });
  }
};
