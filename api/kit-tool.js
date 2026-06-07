// TEMP endpoint — find products + read/add collections. À SUPPRIMER après usage.
const { SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, shopifyAdminHeaders } = require('./_shopify-helpers');
const SECRET = 'touni-sync-2026';

async function gql(headers, query, variables) {
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST', headers, body: JSON.stringify({ query, variables }),
  });
  return r.json();
}
const gidProduct = (id) => String(id).startsWith('gid://') ? id : `gid://shopify/Product/${id}`;
const gidCollection = (id) => String(id).startsWith('gid://') ? id : `gid://shopify/Collection/${id}`;

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
          if ((p.title + ' ' + (p.handle || '')).toLowerCase().includes(needle))
            out.push({ id: p.id, title: p.title, handle: p.handle });
        }
        const link = r.headers.get('link') || '';
        const m = link.match(/<([^>]+)>;\s*rel="next"/);
        url = m ? m[1] : null;
      }
      return res.status(200).json({ matches: out });
    }

    // collections d'un produit (smart + manuelles)
    if (q.action === 'prodcols') {
      const data = await gql(headers, `query($id:ID!){ product(id:$id){ title collections(first:60){ nodes{ id title handle ruleSet{ appliedDisjunctively rules{ column relation condition } } } } } }`, { id: gidProduct(q.id) });
      const p = data.data && data.data.product;
      if (!p) return res.status(404).json({ error: 'not found', raw: data });
      const cols = p.collections.nodes.map(c => ({
        id: c.id.split('/').pop(), title: c.title, handle: c.handle,
        type: c.ruleSet ? 'smart' : 'manual',
        rules: c.ruleSet ? c.ruleSet.rules : null,
      }));
      return res.status(200).json({ product: p.title, collections: cols });
    }

    // ajouter un produit à des collections manuelles
    if (q.action === 'addcols' && req.method === 'POST') {
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body);
      const pid = gidProduct(body.product_id);
      const out = [];
      for (const cid of body.collection_ids) {
        const data = await gql(headers, `mutation($id:ID!,$pids:[ID!]!){ collectionAddProducts(id:$id, productIds:$pids){ collection{ id title } userErrors{ field message } } }`, { id: gidCollection(cid), pids: [pid] });
        const r = data.data && data.data.collectionAddProducts;
        out.push({ collection_id: cid, ok: !!(r && r.collection), errors: (r && r.userErrors) || data.errors });
      }
      return res.status(200).json({ added: out });
    }

    return res.status(400).json({ error: 'bad action' });
  } catch (e) {
    return res.status(500).json({ error: String(e), stack: e.stack });
  }
};
