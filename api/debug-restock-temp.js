// TEMP - debug inventory failures for Brésil + Allemagne
// DELETE AFTER USE
export default async function handler(req, res) {
  const SHOP = 'bjuanm-1r.myshopify.com';
  const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
  const LOC = '85067202779';

  const targets = [
    { search: 'Brésil Domicile 2024', sizes: ['S','M','L','XL','2XL'] },
    { search: 'Allemagne Domicile 2026', sizes: ['S','M','L','XL','2XL'] },
  ];

  const log = [];

  for (const target of targets) {
    // Search product
    const searchUrl = `https://${SHOP}/admin/api/2024-01/products.json?title=${encodeURIComponent(target.search)}&limit=5`;
    const sRes = await fetch(searchUrl, { headers: { 'X-Shopify-Access-Token': TOKEN } });
    const sData = await sRes.json();
    const products = sData.products || [];

    if (!products.length) {
      log.push({ search: target.search, error: 'product not found' });
      continue;
    }

    for (const product of products) {
      log.push({ product: product.title, id: product.id });

      for (const variant of product.variants) {
        const sizeMatch = target.sizes.some(s =>
          variant.title === s || variant.option1 === s || variant.option2 === s
        );
        if (!sizeMatch) continue;

        const variantInfo = {
          variant_id: variant.id,
          title: variant.title,
          inventory_management: variant.inventory_management,
          inventory_item_id: variant.inventory_item_id,
        };

        // Step 1: Check inventory level
        const levUrl = `https://${SHOP}/admin/api/2024-01/inventory_levels.json?inventory_item_ids=${variant.inventory_item_id}&location_ids=${LOC}`;
        const levRes = await fetch(levUrl, { headers: { 'X-Shopify-Access-Token': TOKEN } });
        const levData = await levRes.json();
        variantInfo.current_levels = levData.inventory_levels;

        // Step 2: If management not shopify, try to enable
        if (variant.inventory_management !== 'shopify') {
          const putRes = await fetch(`https://${SHOP}/admin/api/2024-01/variants/${variant.id}.json`, {
            method: 'PUT',
            headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ variant: { id: variant.id, inventory_management: 'shopify' } })
          });
          const putData = await putRes.json();
          variantInfo.enable_tracking_status = putRes.status;
          variantInfo.enable_tracking_response = putData;

          // Step 3: Connect
          const conRes = await fetch(`https://${SHOP}/admin/api/2024-01/inventory_levels/connect.json`, {
            method: 'POST',
            headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ location_id: LOC, inventory_item_id: variant.inventory_item_id })
          });
          const conData = await conRes.json();
          variantInfo.connect_status = conRes.status;
          variantInfo.connect_response = conData;
        }

        // Step 4: Set inventory
        const setRes = await fetch(`https://${SHOP}/admin/api/2024-01/inventory_levels/set.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ location_id: LOC, inventory_item_id: variant.inventory_item_id, available: 50 })
        });
        const setData = await setRes.json();
        variantInfo.set_status = setRes.status;
        variantInfo.set_response = setData;

        log.push(variantInfo);
      }
    }
  }

  return res.json({ log });
}
