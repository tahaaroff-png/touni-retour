// TEMP endpoint — create (couleur) / delete / publish. À SUPPRIMER après usage.
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

    if (q.action === 'delete' && req.method === 'POST') {
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body);
      const out = [];
      for (const id of body.ids) { const r = await fetch(`${base}/products/${id}.json`, { method: 'DELETE', headers }); out.push({ id, ok: r.ok }); }
      return res.status(200).json({ deleted: out });
    }

    if (q.action === 'publish' && req.method === 'POST') {
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body);
      const pd = await gql(headers, `query{ publications(first:25){ nodes{ id } } }`, {});
      const input = ((pd.data && pd.data.publications && pd.data.publications.nodes) || []).map(n => ({ publicationId: n.id }));
      const out = [];
      for (const pid of body.product_ids) { const data = await gql(headers, `mutation($id:ID!,$input:[PublicationInput!]!){ publishablePublish(id:$id, input:$input){ userErrors{ message } } }`, { id: gidP(pid), input }); const ue = (data.data && data.data.publishablePublish && data.data.publishablePublish.userErrors) || data.errors || []; out.push({ product_id: pid, ok: ue.length === 0, channels: input.length }); }
      return res.status(200).json({ published: out });
    }

    if (q.action === 'create' && req.method === 'POST') {
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body); const out = [];
      for (const spec of body.products) {
        const baseV = { price: String(spec.price), compare_at_price: spec.compare_at_price != null ? String(spec.compare_at_price) : null, inventory_management: 'shopify', inventory_policy: 'deny', taxable: true, requires_shipping: true };
        let options, variants;
        if (spec.colors && spec.colors.length && spec.sizes && spec.sizes.length) {
          options = [{ name: 'Couleur' }, { name: 'Taille' }]; variants = [];
          for (const c of spec.colors) for (const s of spec.sizes) variants.push(Object.assign({ option1: c, option2: s }, baseV));
        } else if (spec.colors && spec.colors.length) {
          options = [{ name: 'Couleur' }]; variants = spec.colors.map(c => Object.assign({ option1: c }, baseV));
        } else {
          options = [{ name: 'Taille' }]; variants = (spec.sizes || ['Standard']).map(s => Object.assign({ option1: s }, baseV));
        }
        const payload = { product: { title: spec.title, body_html: spec.body_html, vendor: spec.vendor, product_type: spec.product_type, tags: spec.tags, status: spec.status || 'active', handle: spec.handle, options, variants } };
        const cr = await fetch(`${base}/products.json`, { method: 'POST', headers, body: JSON.stringify(payload) }); const cd = await cr.json();
        if (!cr.ok) { out.push({ title: spec.title, error: cd }); continue; }
        const prod = cd.product;
        if (spec.seo_title) await fetch(`${base}/products/${prod.id}/metafields.json`, { method: 'POST', headers, body: JSON.stringify({ metafield: { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: spec.seo_title } }) });
        if (spec.seo_description) await fetch(`${base}/products/${prod.id}/metafields.json`, { method: 'POST', headers, body: JSON.stringify({ metafield: { namespace: 'global', key: 'description_tag', type: 'multi_line_text_field', value: spec.seo_description } }) });
        if (spec.inventory != null) for (const v of prod.variants) await fetch(`${base}/inventory_levels/set.json`, { method: 'POST', headers, body: JSON.stringify({ location_id: parseInt(SHOPIFY_LOCATION_ID), inventory_item_id: v.inventory_item_id, available: parseInt(spec.inventory) }) });
        if (spec.collection_ids) for (const cid of spec.collection_ids) await gql(headers, `mutation($id:ID!,$pids:[ID!]!){ collectionAddProducts(id:$id, productIds:$pids){ collection{ id } userErrors{ message } } }`, { id: gidC(cid), pids: [gidP(prod.id)] });
        out.push({ id: prod.id, handle: prod.handle, title: prod.title, variants: prod.variants.length, options: prod.options.map(o => o.name + ':' + o.values.join('/')) });
      }
      return res.status(200).json({ created: out });
    }

    return res.status(400).json({ error: 'bad action' });
  } catch (e) { return res.status(500).json({ error: String(e), stack: e.stack }); }
};
