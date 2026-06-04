// TEMP - debug inventory failures for Brésil + Allemagne
// DELETE AFTER USE
export default async function handler(req, res) {
  const SHOP = 'bjuanm-1r.myshopify.com';
  const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
  const LOC = '85067202779';
  const HEADERS = { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' };

  // Exact titles from prior failed batch
  const TARGET_TITLES = [
    'Brésil - Maillot Domicile 2024/25',
    'Brésil - Maillot Domicile Manches Longues 2025/26',
    'Maillot Brésil Domicile 1998',
    'Allemagne - Maillot Domicile 2026',
    'Maillot Domicile Allemagne 26 Manches Longues Blanc',
  ];
  const TARGET_SIZES = ['S','M','L','XL','2XL'];

  const log = [];
  let pageUrl = `https://${SHOP}/admin/api/2024-01/products.json?limit=250&status=any`;
  let allProducts = [];

  // Paginate through all products
  while (pageUrl) {
    const r = await fetch(pageUrl, { headers: HEADERS });
    const d = await r.json();
    allProducts = allProducts.concat(d.products || []);
    const linkHeader = r.headers.get('Link') || '';
    const next = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    pageUrl = next ? next[1] : null;
    if (allProducts.length > 500) break; // safety limit
  }

  // Find matching products
  const matched = allProducts.filter(p =>
    TARGET_TITLES.some(t => p.title.includes(t.split(' ')[1] || t)) ||
    TARGET_TITLES.some(t => p.title === t || p.title.startsWith(t.substring(0, 20)))
  );

  log.push({ total_products_scanned: allProducts.length, matched_count: matched.length });

  // Better: find all Brésil and Allemagne products
  const relevant = allProducts.filter(p =>
    p.title.toLowerCase().includes('brésil') ||
    p.title.toLowerCase().includes('bresil') ||
    p.title.toLowerCase().includes('allemagne')
  );
  log.push({ relevant_products: relevant.map(p => ({ id: p.id, title: p.title, status: p.status })) });

  // Now try inventory set on the relevant variants
  for (const product of relevant) {
    for (const variant of product.variants) {
      const sizeMatch = TARGET_SIZES.some(s =>
        variant.title === s || variant.option1 === s
      );
      if (!sizeMatch) continue;

      const entry = {
        product_title: product.title,
        variant_title: variant.title,
        variant_id: variant.id,
        inventory_item_id: variant.inventory_item_id,
        inventory_management: variant.inventory_management,
      };

      // Enable tracking if needed
      if (variant.inventory_management !== 'shopify') {
        const putRes = await fetch(`https://${SHOP}/admin/api/2024-01/variants/${variant.id}.json`, {
          method: 'PUT',
          headers: HEADERS,
          body: JSON.stringify({ variant: { id: variant.id, inventory_management: 'shopify' } })
        });
        entry.enable_tracking_status = putRes.status;
        if (putRes.status !== 200) {
          entry.enable_tracking_body = await putRes.text();
        }

        // Connect to location
        const conRes = await fetch(`https://${SHOP}/admin/api/2024-01/inventory_levels/connect.json`, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ location_id: LOC, inventory_item_id: variant.inventory_item_id })
        });
        entry.connect_status = conRes.status;
        if (conRes.status !== 201) {
          entry.connect_body = await conRes.text();
        }
      }

      // Set inventory
      const setRes = await fetch(`https://${SHOP}/admin/api/2024-01/inventory_levels/set.json`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ location_id: LOC, inventory_item_id: variant.inventory_item_id, available: 50 })
      });
      entry.set_status = setRes.status;
      entry.set_body = await setRes.text();

      log.push(entry);
    }
  }

  return res.json({ log });
}
