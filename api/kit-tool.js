// TEMP endpoint — remove products from a collection. À SUPPRIMER après usage.
const { SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, shopifyAdminHeaders } = require('./_shopify-helpers');
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
  try {
    const headers = await shopifyAdminHeaders();
    if (q.action === 'removecols' && req.method === 'POST') {
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body);
      const pids = body.product_ids.map(gidP);
      const data = await gql(headers, `mutation($id:ID!,$pids:[ID!]!){ collectionRemoveProducts(id:$id, productIds:$pids){ job{ id done } userErrors{ field message } } }`, { id: gidC(body.collection_id), pids });
      const r = data.data && data.data.collectionRemoveProducts;
      return res.status(200).json({ ok: !!(r && r.job), job: r && r.job, errors: (r && r.userErrors) || data.errors });
    }
    return res.status(400).json({ error: 'bad action' });
  } catch (e) { return res.status(500).json({ error: String(e), stack: e.stack }); }
};
