// TEMP endpoint — find/template/create kit products. À SUPPRIMER après usage.
const { SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, SHOPIFY_LOCATION_ID, shopifyAdminHeaders } = require('./_shopify-helpers');
const SECRET = 'touni-sync-2026';

module.exports = async (req, res) => {
  const q = req.query || {};
  if (q.secret !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
  try {
    const headers = await shopifyAdminHeaders();

    if (q.action === 'find') {
      const needle = (q.q || '').toLowerCase();
      const out = [];
      let url = `${base}/products.json?limit=250&fields=id,title,handle,product_type`;
      while (url) {
        const r = await fetch(url, { headers });
        const d = await r.json();
        for (const p of (d.products || [])) {
          if ((p.title + ' ' + (p.handle || '')).toLowerCase().includes(needle)) {
            out.push({ id: p.id, title: p.title, handle: p.handle, type: p.product_type });
          }
        }
        const link = r.headers.get('link') || '';
        const m = link.match(/<([^>]+)>;\s*rel="next"/);
        url = m ? m[1] : null;
      }
      return res.status(200).json({ matches: out });
    }

    if (q.action === 'template') {
      const r = await fetch(`${base}/products/${q.id}.json`, { headers });
      const d = await r.json();
      if (!d.product) return res.status(404).json({ error: 'not found', raw: d });
      const mr = await fetch(`${base}/products/${q.id}/metafields.json`, { headers });
      const md = await mr.json();
      return res.status(200).json({ product: d.product, metafields: md.metafields || [] });
    }

    if (q.action === 'create' && req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      const out = [];
      for (const spec of body.products) {
        const variants = spec.sizes.map(s => ({
          option1: s,
          price: String(spec.price),
          compare_at_price: spec.compare_at_price != null ? String(spec.compare_at_price) : null,
          inventory_management: 'shopify',
          inventory_policy: 'deny',
          taxable: spec.taxable !== false,
          requires_shipping: true,
        }));
        const payload = { product: {
          title: spec.title, body_html: spec.body_html, vendor: spec.vendor,
          product_type: spec.product_type, tags: spec.tags, status: spec.status || 'active',
          handle: spec.handle, options: [{ name: spec.option_name || 'Taille' }], variants,
        }};
        const cr = await fetch(`${base}/products.json`, { method: 'POST', headers, body: JSON.stringify(payload) });
        const cd = await cr.json();
        if (!cr.ok) { out.push({ title: spec.title, error: cd }); continue; }
        const prod = cd.product;

        const mfs = [];
        if (spec.seo_title) mfs.push({ namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: spec.seo_title });
        if (spec.seo_description) mfs.push({ namespace: 'global', key: 'description_tag', type: 'multi_line_text_field', value: spec.seo_description });
        for (const mf of mfs) {
          await fetch(`${base}/products/${prod.id}/metafields.json`, { method: 'POST', headers, body: JSON.stringify({ metafield: mf }) });
        }

        let img = null;
        if (spec.image_base64) {
          const ir = await fetch(`${base}/products/${prod.id}/images.json`, { method: 'POST', headers, body: JSON.stringify({ image: { attachment: spec.image_base64, position: 1 } }) });
          const id = await ir.json(); img = (id.image && id.image.id) || id;
        } else if (spec.image_url) {
          const ir = await fetch(`${base}/products/${prod.id}/images.json`, { method: 'POST', headers, body: JSON.stringify({ image: { src: spec.image_url, position: 1 } }) });
          const id = await ir.json(); img = (id.image && id.image.id) || id;
        }

        if (spec.inventory != null) {
          for (const v of prod.variants) {
            await fetch(`${base}/inventory_levels/set.json`, { method: 'POST', headers, body: JSON.stringify({ location_id: parseInt(SHOPIFY_LOCATION_ID), inventory_item_id: v.inventory_item_id, available: parseInt(spec.inventory) }) });
          }
        }

        if (spec.collection_ids) {
          for (const cid of spec.collection_ids) {
            await fetch(`${base}/collects.json`, { method: 'POST', headers, body: JSON.stringify({ collect: { product_id: prod.id, collection_id: cid } }) });
          }
        }

        out.push({ id: prod.id, handle: prod.handle, title: prod.title, variants: prod.variants.length, image: img });
      }
      return res.status(200).json({ created: out });
    }

    return res.status(400).json({ error: 'bad action' });
  } catch (e) {
    return res.status(500).json({ error: String(e), stack: e.stack });
  }
};
