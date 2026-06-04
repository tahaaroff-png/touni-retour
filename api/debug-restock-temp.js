// TEMP - debug inventory failures: check token + find Brésil/Allemagne products
// DELETE AFTER USE
export default async function handler(req, res) {
  const SHOP = 'bjuanm-1r.myshopify.com';
  const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
  const LOC = '85067202779';
  const HEADERS = { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' };

  const log = [];

  // Step 1: Test token with a simple shop call
  const shopRes = await fetch(`https://${SHOP}/admin/api/2024-01/shop.json`, { headers: HEADERS });
  const shopText = await shopRes.text();
  log.push({ step: 'token_test', status: shopRes.status, body: shopText.substring(0, 200) });

  if (shopRes.status !== 200) {
    return res.json({ error: 'Token invalid', log });
  }

  // Step 2: Count products
  const countRes = await fetch(`https://${SHOP}/admin/api/2024-01/products/count.json`, { headers: HEADERS });
  const countData = await countRes.json();
  log.push({ step: 'product_count', count: countData.count });

  // Step 3: Search specifically for failing products
  const searches = ['Br%C3%A9sil', 'Allemagne', 'Maillot+Br%C3%A9sil', 'Maillot+Domicile+Allemagne'];
  for (const q of searches) {
    const url = `https://${SHOP}/admin/api/2024-01/products.json?title=${q}&limit=10&fields=id,title,status`;
    const r = await fetch(url, { headers: HEADERS });
    const d = await r.json();
    log.push({ search: q, status: r.status, products: (d.products || []).map(p => ({ id: p.id, title: p.title, status: p.status })) });
  }

  return res.json({ log });
}
