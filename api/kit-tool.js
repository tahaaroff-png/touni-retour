// TEMP endpoint — find/template/create + collections + publications. À SUPPRIMER après usage.
const { SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, SHOPIFY_LOCATION_ID, shopifyAdminHeaders } = require('./_shopify-helpers');
const SECRET = 'touni-sync-2026';
async function gql(headers, query, variables) {
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  return r.json();
}
const gidP = (id) => `gid://shopify/Product/${id}`;
const gidC = (id) => `gid://shopify/Collection/${id}`;

module.exports = async (req, res) => {
  const q = req.query || {};
  if (q.secret !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
  try {
    const headers = await shopifyAdminHeaders();

    if (q.action === 'find') {
      const needle = (q.q || '').toLowerCase(); const out = [];
      let url = `${base}/products.json?limit=250&fields=id,title,handle,product_type`;
      while (url) {
        const r = await fetch(url, { headers }); const d = await r.json();
        for (const p of (d.products || [])) if ((p.title + ' ' + (p.handle || '')).toLowerCase().includes(needle)) out.push({ id: p.id, title: p.title, handle: p.handle, type: p.product_type });
        const link = r.headers.get('link') || ''; const m = link.match(/<([^>]+)>;\s*rel="next"/); url = m ? m[1] : null;
      }
      return res.status(200).json({ matches: out });
    }

    if (q.action === 'template') {
      const r = await fetch(`${base}/products/${q.id}.json`, { headers }); const d = await r.json();
      if (!d.product) return res.status(404).json({ error: 'not found' });
      const p = d.product;
      const mr = await fetch(`${base}/products/${q.id}/metafields.json`, { headers }); const md = await mr.json();
      return res.status(200).json({ id: p.id, title: p.title, type: p.product_type, vendor: p.vendor, tags: p.tags, body_html: p.body_html, options: (p.options || []).map(o => ({ name: o.name, values: o.values })), price: p.variants[0] && p.variants[0].price, compare_at: p.variants[0] && p.variants[0].compare_at_price, metafields: (md.metafields || []).filter(m => m.key === 'title_tag' || m.key === 'description_tag').map(m => ({ key: m.key, value: m.value })) });
    }

    if (q.action === 'prodcols') {
      const data = await gql(headers, `query($id:ID!){ product(id:$id){ title collections(first:60){ nodes{ id title ruleSet{ rules{ column } } } } } }`, { id: gidP(q.id) });
      const p = data.data && data.data.product; if (!p) return res.status(404).json({ error: 'not found' });
      return res.status(200).json({ product: p.title, collections: p.collections.nodes.map(c => ({ id: c.id.split('/').pop(), title: c.title, type: c.ruleSet ? 'smart' : 'manual' })) });
    }

    if (q.action === 'publish' && req.method === 'POST') {
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body);
      let pubIds = body.publication_ids;
      if (!pubIds || !pubIds.length) { const pd = await gql(headers, `query{ publications(first:25){ nodes{ id } } }`, {}); pubIds = ((pd.data && pd.data.publications && pd.data.publications.nodes) || []).map(n => n.id); }
      const input = pubIds.map(id => ({ publicationId: id })); const out = [];
      for (const pid of body.product_ids) {
        const data = await gql(headers, `mutation($id:ID!,$input:[PublicationInput!]!){ publishablePublish(id:$id, input:$input){ userErrors{ message } } }`, { id: gidP(pid), input });
        const ue = (data.data && data.data.publishablePublish && data.data.publishablePublish.userErrors) || data.errors || [];
        out.push({ product_id: pid, ok: ue.length === 0, channels: input.length });
      }
      return res.status(200).json({ published: out });
    }

    if (q.action === 'create' && req.method === 'POST') {
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body); const out = [];
      for (const spec of body.products) {
        const baseV = { price: String(spec.price), compare_at_price: spec.compare_at_price != null ? String(spec.compare_at_price) : null, inventory_management: 'shopify', inventory_policy: 'deny', taxable: spec.taxable !== false, requires_shipping: true };
        const options = [{ name: spec.option_name || 'Taille' }];
        const variants = (spec.sizes || ['Standard']).map(s => Object.assign({ option1: s }, baseV));
        const payload = { product: { title: spec.title, body_html: spec.body_html, vendor: spec.vendor, product_type: spec.product_type, tags: spec.tags, status: spec.status || 'active', handle: spec.handle, options, variants } };
        const cr = await fetch(`${base}/products.json`, { method: 'POST', headers, body: JSON.stringify(payload) }); const cd = await cr.json();
        if (!cr.ok) { out.push({ title: spec.title, error: cd }); continue; }
        const prod = cd.product;
        if (spec.seo_title) await fetch(`${base}/products/${prod.id}/metafields.json`, { method: 'POST', headers, body: JSON.stringify({ metafield: { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: spec.seo_title } }) });
        if (spec.seo_description) await fetch(`${base}/products/${prod.id}/metafields.json`, { method: 'POST', headers, body: JSON.stringify({ metafield: { namespace: 'global', key: 'description_tag', type: 'multi_line_text_field', value: spec.seo_description } }) });
        if (spec.inventory != null) for (const v of prod.variants) await fetch(`${base}/inventory_levels/set.json`, { method: 'POST', headers, body: JSON.stringify({ location_id: parseInt(SHOPIFY_LOCATION_ID), inventory_item_id: v.inventory_item_id, available: parseInt(spec.inventory) }) });
        if (spec.collection_ids) for (const cid of spec.collection_ids) await gql(headers, `mutation($id:ID!,$pids:[ID!]!){ collectionAddProducts(id:$id, productIds:$pids){ collection{ id } userErrors{ message } } }`, { id: gidC(cid), pids: [gidP(prod.id)] });
        out.push({ id: prod.id, handle: prod.handle, title: prod.title });
      }
      return res.status(200).json({ created: out });
    }

    return res.status(400).json({ error: 'bad action' });
  } catch (e) { return res.status(500).json({ error: String(e), stack: e.stack }); }
};
