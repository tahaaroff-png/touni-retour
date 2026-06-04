// TEMPORARY — Publish all active products to all sales channels via GraphQL
// DELETE AFTER USE
// ?action=list        → list all publications (channels)
// ?action=fix         → publish all products to all channels (paginated via cursor)
// ?action=fix&cursor=XXX → next page

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

async function gql(query, variables, hdrs) {
  const r = await fetch(`https://${_SD}/admin/api/${_SV}/graphql.json`, {
    method: 'POST',
    headers: { ...hdrs, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const hdrs = await shopifyAdminHeaders();

  try {
    // 1. Get all publication IDs via GraphQL
    const pubQuery = `{
      publications(first: 20) {
        edges {
          node { id name supportsFuturePublishing }
        }
      }
    }`;
    const pubRes = await gql(pubQuery, {}, hdrs);
    const publications = pubRes.data?.publications?.edges?.map(e => e.node) || [];

    if (req.query.action === 'list') {
      return res.json({ publications });
    }

    // 2. Get a page of active products
    const cursor = req.query.cursor || null;
    const productQuery = `
      query getProducts($cursor: String) {
        products(first: 20, after: $cursor, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              title
              publishedOnCurrentPublication
            }
          }
        }
      }
    `;
    const prodRes = await gql(productQuery, { cursor }, hdrs);
    const pageInfo = prodRes.data?.products?.pageInfo;
    const products = prodRes.data?.products?.edges?.map(e => e.node) || [];

    if (products.length === 0) {
      return res.json({ success: true, message: 'No more products to process', hasNextPage: false });
    }

    // 3. Publish each product to all publications
    const publishMutation = `
      mutation publishProduct($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          userErrors { field message }
        }
      }
    `;

    const publicationInput = publications.map(p => ({ publicationId: p.id }));
    const results = [];

    for (const product of products) {
      const mutRes = await gql(publishMutation, {
        id: product.id,
        input: publicationInput,
      }, hdrs);

      const errors = mutRes.data?.publishablePublish?.userErrors || [];
      results.push({
        id: product.id,
        title: product.title,
        ok: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
      });
    }

    const ok = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;

    return res.json({
      success: true,
      batch: products.length,
      published_ok: ok,
      failed,
      hasNextPage: pageInfo?.hasNextPage,
      nextCursor: pageInfo?.endCursor,
      channels: publications.map(p => p.name),
      results,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
