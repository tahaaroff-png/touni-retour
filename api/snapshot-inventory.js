// snapshot-inventory.js — capture l'état inventaire LIVE dans inventory_snapshots
// Permet de revenir en arrière plus tard (restauration par label).
//
// Capturer : ?secret=touni-sync-2026&label=mon-label[&cursor=CURSOR]
//            (appeler en boucle jusqu'à done:true)
// Restaurer un label : ?secret=...&restore=mon-label[&cursor=CURSOR]
// Lister les labels :  ?secret=...&list=1

const {
  shopifyAdminHeaders, SHOPIFY_DOMAIN, SHOPIFY_API_VERSION,
  SB_URL, SB_ANON_KEY,
} = require('./_shopify-helpers.js');

const GQL = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sbHeaders = { apikey: SB_ANON_KEY, Authorization: `Bearer ${SB_ANON_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' };

async function gql(headers, query, variables) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(GQL, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
    const j = await res.json();
    if (j.errors && JSON.stringify(j.errors).includes('Throttled')) { await sleep(1000 * (i + 1)); continue; }
    return j;
  }
  throw new Error('Throttled');
}

const PAGE_Q = `query($cursor:String){
  products(first:25, after:$cursor){
    pageInfo{ hasNextPage endCursor }
    nodes{
      title
      variants(first:100){ nodes{
        id title inventoryPolicy inventoryQuantity
        inventoryItem{ id tracked }
      } }
    }
  }
}`;

async function getLocId(headers) {
  const r = await gql(headers, `{ locations(first:1){ nodes{ id } } }`, {});
  return r.data.locations.nodes[0].id;
}

async function loadCacheQty() {
  const map = new Map();
  let offset = 0; const limit = 1000;
  while (true) {
    const url = `${SB_URL}/rest/v1/shopify_variants_cache?select=variant_id,inventory_quantity&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${SB_ANON_KEY}` } });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;
    for (const r of rows) map.set(String(r.variant_id), r.inventory_quantity);
    if (rows.length < limit) break;
    offset += limit;
  }
  return map;
}

module.exports = async function handler(req, res) {
  if ((req.query?.secret || req.headers['x-sync-secret']) !== (process.env.SYNC_SECRET || 'touni-sync-2026')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const headers = { ...(await shopifyAdminHeaders()), 'Content-Type': 'application/json' };

  // ── REVERT état initial : produit tout-zéro → dé-tracker ; produit avec stock → dispo=cache ──
  if (req.query.revert === '1') {
    const cursor2 = req.query.cursor || null;
    const cacheQty = await loadCacheQty();
    const REVQ = `query($c:String){ products(first:25, after:$c){ pageInfo{ hasNextPage endCursor } nodes{ title variants(first:100){ nodes{ id title inventoryItem{ id tracked } } } } } }`;
    const d = await gql(headers, REVQ, { c: cursor2 });
    if (!d.data) return res.status(500).json({ error: JSON.stringify(d.errors) });
    const { nodes: products, pageInfo } = d.data.products;
    const locId = await getLocId(headers);

    let untracked = 0, availSet = 0, errors = 0;
    const toUntrack = [];   // inventoryItem gids
    const toSetAvail = [];  // {inventoryItemId, locationId, quantity}

    for (const p of products) {
      let hasStock = false;
      for (const v of p.variants.nodes) {
        const q = cacheQty.get(String(Number(v.id.split('/').pop())));
        if (q > 0) { hasStock = true; break; }
      }
      for (const v of p.variants.nodes) {
        const vid = String(Number(v.id.split('/').pop()));
        const q = cacheQty.has(vid) ? cacheQty.get(vid) : 0;
        if (hasStock) {
          toSetAvail.push({ inventoryItemId: v.inventoryItem.id, locationId: locId, quantity: q });
          availSet++;
        } else {
          if (v.inventoryItem.tracked) { toUntrack.push(v.inventoryItem.id); untracked++; }
        }
      }
    }

    // dé-tracker (aliasé par 20)
    for (let i = 0; i < toUntrack.length; i += 20) {
      const chunk = toUntrack.slice(i, i + 20);
      const al = chunk.map((id, k) => `u${k}: inventoryItemUpdate(id:"${id}", input:{tracked:false}){ userErrors{ message } }`).join('\n');
      const r = await gql(headers, `mutation{ ${al} }`, {});
      if (r.errors) errors += chunk.length;
      await sleep(120);
    }
    // dispo = cache (par 100)
    for (let i = 0; i < toSetAvail.length; i += 100) {
      const chunk = toSetAvail.slice(i, i + 100);
      const r = await gql(headers, `mutation($in:InventorySetQuantitiesInput!){ inventorySetQuantities(input:$in){ userErrors{ message } } }`,
        { in: { name: 'available', reason: 'correction', ignoreCompareQuantity: true, quantities: chunk } });
      if (r.errors || r.data?.inventorySetQuantities?.userErrors?.length) errors += chunk.length;
      await sleep(150);
    }

    return res.status(200).json({ ok: true, done: !pageInfo.hasNextPage, nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null, this_batch: { untracked, availSet, errors } });
  }

  // ── LISTE PRIX produits actifs (image, prix, prix barré, type) pour checklist ──
  if (req.query.prices === '1') {
    const cursorP = req.query.cursor || null;
    const PQ = `query($c:String){ products(first:40, after:$c, query:"status:active"){ pageInfo{ hasNextPage endCursor } nodes{ id title productType featuredImage{ url } variants(first:1){ nodes{ id price compareAtPrice } } } } }`;
    const d = await gql(headers, PQ, { c: cursorP });
    if (!d.data) return res.status(500).json({ error: JSON.stringify(d.errors) });
    const out = d.data.products.nodes.map(p => {
      const v = p.variants.nodes[0] || {};
      return { id: Number(p.id.split('/').pop()), title: p.title, type: p.productType || '', image: p.featuredImage ? p.featuredImage.url : '', price: v.price, compareAt: v.compareAtPrice };
    });
    const pi = d.data.products.pageInfo;
    return res.status(200).json({ ok: true, done: !pi.hasNextPage, nextCursor: pi.hasNextPage ? pi.endCursor : null, items: out });
  }

  // ── CHANGER PRIX : ?setprices=1 POST body {items:[{id, price}]} → met price (garde compareAt) sur tous variants ──
  if (req.query.setprices === '1') {
    let body=''; await new Promise(r=>{req.on('data',c=>body+=c);req.on('end',r);});
    const items = JSON.parse(body).items || [];
    let done=0, errors=0; const results=[];
    for (const it of items) {
      try {
        const q = `query($id:ID!){ product(id:$id){ title variants(first:100){ nodes{ id } } } }`;
        const r = await gql(headers, q, { id: `gid://shopify/Product/${it.id}` });
        const p = r.data?.product;
        if (!p) { errors++; results.push({id:it.id,status:'introuvable'}); continue; }
        const variants = p.variants.nodes.map(v => ({ id: v.id, price: String(it.price) }));
        const m = await gql(headers, `mutation($pid:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$pid, variants:$v){ userErrors{ message } } }`,
          { pid: `gid://shopify/Product/${it.id}`, v: variants });
        const errs = m.data?.productVariantsBulkUpdate?.userErrors || [];
        if (errs.length) { errors++; results.push({id:it.id,title:p.title,status:'err:'+JSON.stringify(errs)}); }
        else { done++; results.push({id:it.id,title:p.title,price:it.price,status:'ok'}); }
        await sleep(150);
      } catch(e){ errors++; results.push({id:it.id,status:'err:'+e.message}); }
    }
    return res.status(200).json({ ok:true, done, errors, results });
  }

  // ── RESTOCK par liste d'IDs produits : ?restock=id1,id2,...&qty=50 → suivi + DENY + qty ──
  if (req.query.restock) {
    const ids = req.query.restock.split(',').map(s => s.trim()).filter(Boolean);
    const qty = parseInt(req.query.qty || '50', 10);
    const locId = await getLocId(headers);
    let done = 0, errors = 0;
    const results = [];
    for (const id of ids) {
      try {
        const q = `query($id:ID!){ product(id:$id){ title variants(first:100){ nodes{ id inventoryItem{ id tracked } } } } }`;
        const r = await gql(headers, q, { id: `gid://shopify/Product/${id}` });
        const p = r.data?.product;
        if (!p) { results.push({ id, status: 'introuvable' }); errors++; continue; }
        const items = p.variants.nodes.map(v => v.inventoryItem.id);
        // 1) tracking on
        const al = items.map((iid, k) => `t${k}: inventoryItemUpdate(id:"${iid}", input:{tracked:true}){ userErrors{ message } }`).join('\n');
        await gql(headers, `mutation{ ${al} }`, {}); await sleep(120);
        // 2) policy DENY
        await gql(headers, `mutation($pid:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$pid, variants:$v){ userErrors{ message } } }`,
          { pid: `gid://shopify/Product/${id}`, v: p.variants.nodes.map(v => ({ id: v.id, inventoryPolicy: 'DENY' })) }); await sleep(120);
        // 3) available = qty
        await gql(headers, `mutation($in:InventorySetQuantitiesInput!){ inventorySetQuantities(input:$in){ userErrors{ message } } }`,
          { in: { name: 'available', reason: 'restock', ignoreCompareQuantity: true, quantities: items.map(iid => ({ inventoryItemId: iid, locationId: locId, quantity: qty })) } }); await sleep(150);
        done++; results.push({ id, title: p.title, variants: items.length, status: 'restocké à ' + qty });
      } catch (e) { errors++; results.push({ id, status: 'erreur: ' + e.message }); }
    }
    return res.status(200).json({ ok: true, done, errors, qty, results });
  }

  // ── LISTE produits ACTIFS en rupture (avec image) pour checklist ──
  if (req.query.activeRuptures === '1') {
    const cursorA = req.query.cursor || null;
    const AQ = `query($c:String){ products(first:30, after:$c, query:"status:active"){ pageInfo{ hasNextPage endCursor } nodes{ id handle title status featuredImage{ url } variants(first:100){ nodes{ id title inventoryQuantity inventoryItem{ tracked } } } } } }`;
    const d = await gql(headers, AQ, { c: cursorA });
    if (!d.data) return res.status(500).json({ error: JSON.stringify(d.errors) });
    const out = [];
    for (const p of d.data.products.nodes) {
      const sold = p.variants.nodes.filter(v => v.inventoryItem.tracked && (v.inventoryQuantity == null || v.inventoryQuantity <= 0));
      if (!sold.length) continue;
      out.push({
        id: Number(p.id.split('/').pop()),
        handle: p.handle,
        title: p.title,
        image: p.featuredImage ? p.featuredImage.url : '',
        full: sold.length === p.variants.nodes.length,
        sizes: sold.map(v => v.title),
        variantIds: sold.map(v => Number(v.id.split('/').pop())),
      });
    }
    const pi = d.data.products.pageInfo;
    return res.status(200).json({ ok: true, done: !pi.hasNextPage, nextCursor: pi.hasNextPage ? pi.endCursor : null, items: out });
  }

  // ── RECONCILE état initial complet : tracker(handle CSV 9 mai) + quantité(cache 4 juin par variant_id) ──
  if (req.query.reconcile === '1') {
    const cls = require('./_csv_handle_class.json');
    const trackedH = new Set(cls.tracked);
    const notManagedH = new Set(cls.not_managed);
    const cacheQty = await loadCacheQty();
    const locId = await getLocId(headers);
    const cursorR = req.query.cursor || null;

    const RQ = `query($c:String){ products(first:20, after:$c){ pageInfo{ hasNextPage endCursor } nodes{ handle variants(first:100){ nodes{ id inventoryPolicy inventoryItem{ id tracked } } } } } }`;
    const d = await gql(headers, RQ, { c: cursorR });
    if (!d.data) return res.status(500).json({ error: JSON.stringify(d.errors) });
    const { nodes: products, pageInfo } = d.data.products;

    const trackOn = [], trackOff = [];   // inventoryItem gids
    const setAvail = [];                  // {inventoryItemId, locationId, quantity}
    const policyByProduct = {};
    let untrackP = 0, trackP = 0;

    for (const p of products) {
      // décision tracker
      let target; // 'track' | 'untrack'
      let hasStock = false;
      for (const v of p.variants.nodes) {
        const cq = cacheQty.get(String(Number(v.id.split('/').pop())));
        if (cq > 0) { hasStock = true; break; }
      }
      if (notManagedH.has(p.handle) && !hasStock) target = 'untrack';
      else if (trackedH.has(p.handle) || hasStock) target = 'track';
      else target = 'untrack'; // nouveau produit sans stock → dispo

      if (target === 'untrack') {
        untrackP++;
        for (const v of p.variants.nodes) if (v.inventoryItem.tracked) trackOff.push(v.inventoryItem.id);
      } else {
        trackP++;
        for (const v of p.variants.nodes) {
          const cq = cacheQty.get(String(Number(v.id.split('/').pop())));
          if (!v.inventoryItem.tracked) trackOn.push(v.inventoryItem.id);
          if (v.inventoryPolicy !== 'DENY') (policyByProduct[p.id || p.handle] = policyByProduct[p.id || p.handle] || { pid: p.id, items: [] });
          setAvail.push({ inventoryItemId: v.inventoryItem.id, locationId: locId, quantity: cq != null ? cq : 0 });
        }
        // policy: rassembler tous les variants du produit
        const need = p.variants.nodes.filter(v => v.inventoryPolicy !== 'DENY');
        if (need.length) policyByProduct[p.handle] = { pid: p.id, items: need.map(v => ({ id: v.id, inventoryPolicy: 'DENY' })) };
      }
    }

    let errors = 0;
    // track off (untrack) par 20
    for (let i = 0; i < trackOff.length; i += 20) {
      const ch = trackOff.slice(i, i + 20);
      const al = ch.map((id, k) => `u${k}: inventoryItemUpdate(id:"${id}", input:{tracked:false}){ userErrors{ message } }`).join('\n');
      const r = await gql(headers, `mutation{ ${al} }`, {}); if (r.errors) errors += ch.length; await sleep(120);
    }
    // track on par 20
    for (let i = 0; i < trackOn.length; i += 20) {
      const ch = trackOn.slice(i, i + 20);
      const al = ch.map((id, k) => `t${k}: inventoryItemUpdate(id:"${id}", input:{tracked:true}){ userErrors{ message } }`).join('\n');
      const r = await gql(headers, `mutation{ ${al} }`, {}); if (r.errors) errors += ch.length; await sleep(120);
    }
    // policy DENY
    for (const k of Object.keys(policyByProduct)) {
      const { pid, items } = policyByProduct[k];
      if (!pid || !items.length) continue;
      await gql(headers, `mutation($pid:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$pid, variants:$v){ userErrors{ message } } }`, { pid, v: items }); await sleep(120);
    }
    // available = cache (par 100)
    for (let i = 0; i < setAvail.length; i += 100) {
      const ch = setAvail.slice(i, i + 100);
      const r = await gql(headers, `mutation($in:InventorySetQuantitiesInput!){ inventorySetQuantities(input:$in){ userErrors{ message } } }`,
        { in: { name: 'available', reason: 'correction', ignoreCompareQuantity: true, quantities: ch } });
      if (r.errors || r.data?.inventorySetQuantities?.userErrors?.length) errors += ch.length; await sleep(150);
    }

    return res.status(200).json({ ok: true, done: !pageInfo.hasNextPage, nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null, this_batch: { untrackProducts: untrackP, trackProducts: trackP, trackOff: trackOff.length, trackOn: trackOn.length, availSet: setAvail.length, errors } });
  }

  // ── RESTORE RUPTURES : re-tracker + DENY + 0 les produits ruptures longue date (handles du CSV 9 mai) ──
  // Sécurité : ne touche que si la cache confirme tout-zéro (sinon laisse dispo)
  if (req.query.ruptures === '1') {
    const handles = require('./_rupture_handles.json');
    const cacheQty = await loadCacheQty();
    const locId = await getLocId(headers);
    const startIdx = parseInt(req.query.idx || '0', 10);
    const BATCH_HANDLES = 12; // par invocation pour éviter timeout
    const slice = handles.slice(startIdx, startIdx + BATCH_HANDLES);

    let restored = 0, skippedHasStock = 0, notFound = 0, errors = 0;
    const details = [];

    for (const h of slice) {
      const q = `query($h:String!){ productByHandle(handle:$h){ id title variants(first:50){ nodes{ id title inventoryItem{ id tracked } } } } }`;
      const r = await gql(headers, q, { h });
      const p = r.data?.productByHandle;
      if (!p) { notFound++; continue; }
      // cache all-zero ?
      let anyStock = false;
      for (const v of p.variants.nodes) {
        const cq = cacheQty.get(String(Number(v.id.split('/').pop())));
        if (cq > 0) { anyStock = true; break; }
      }
      if (anyStock) { skippedHasStock++; details.push({ h, action: 'skip_has_stock' }); continue; }

      // re-tracker + DENY + available 0
      const itemIds = p.variants.nodes.map(v => v.inventoryItem.id);
      // tracking on
      const al = itemIds.map((id, k) => `t${k}: inventoryItemUpdate(id:"${id}", input:{tracked:true}){ userErrors{ message } }`).join('\n');
      const rt = await gql(headers, `mutation{ ${al} }`, {});
      if (rt.errors) { errors++; continue; }
      await sleep(150);
      // policy DENY
      await gql(headers, `mutation($pid:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$pid, variants:$v){ userErrors{ message } } }`,
        { pid: p.id, v: p.variants.nodes.map(v => ({ id: v.id, inventoryPolicy: 'DENY' })) });
      await sleep(150);
      // available 0
      await gql(headers, `mutation($in:InventorySetQuantitiesInput!){ inventorySetQuantities(input:$in){ userErrors{ message } } }`,
        { in: { name: 'available', reason: 'correction', ignoreCompareQuantity: true, quantities: itemIds.map(id => ({ inventoryItemId: id, locationId: locId, quantity: 0 })) } });
      await sleep(150);
      restored++;
      details.push({ h, action: 'sold_out' });
    }

    const nextIdx = startIdx + BATCH_HANDLES;
    return res.status(200).json({ ok: true, done: nextIdx >= handles.length, nextIdx, total: handles.length, this_batch: { restored, skippedHasStock, notFound, errors }, details });
  }

  // ── VERIFY live par product_id ──
  if (req.query.verify) {
    const out = {};
    for (const id of req.query.verify.split(',')) {
      const q = `query($id:ID!){ product(id:$id){ title variants(first:20){ nodes{ title inventoryPolicy inventoryQuantity inventoryItem{ tracked } } } } }`;
      const r = await gql(headers, q, { id: `gid://shopify/Product/${id}` });
      const p = r.data?.product;
      out[id] = p ? { title: p.title, variants: p.variants.nodes.map(v => ({ t: v.title, policy: v.inventoryPolicy, qty: v.inventoryQuantity, tracked: v.inventoryItem.tracked, available: (!v.inventoryItem.tracked) || v.inventoryQuantity > 0 })) } : 'not found';
    }
    return res.status(200).json(out);
  }

  // ── LISTER les snapshots disponibles ──
  if (req.query.list) {
    const r = await fetch(`${SB_URL}/rest/v1/inventory_snapshots?select=label,created_at&order=created_at.desc`, { headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${SB_ANON_KEY}` } });
    const rows = await r.json();
    const labels = {};
    for (const row of rows) { if (!labels[row.label]) labels[row.label] = { label: row.label, first: row.created_at, count: 0 }; labels[row.label].count++; }
    return res.status(200).json({ snapshots: Object.values(labels) });
  }

  // ── RESTAURER un label (remet tracked/policy/quantité de ce snapshot) ──
  if (req.query.restore) {
    const label = req.query.restore;
    const offset = parseInt(req.query.offset || '0', 10);
    const limit = 80;
    const r = await fetch(`${SB_URL}/rest/v1/inventory_snapshots?label=eq.${encodeURIComponent(label)}&select=variant_id,inventory_item_id,tracked,policy,quantity&order=variant_id&limit=${limit}&offset=${offset}`, { headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${SB_ANON_KEY}` } });
    const rows = await r.json();
    if (!rows.length) return res.status(200).json({ ok: true, done: true });
    const locId = await getLocId(headers);
    let restored = 0, errors = 0;
    // tracking (lots de 20)
    const toTrack = rows.filter(x => x.tracked).map(x => `gid://shopify/InventoryItem/${x.inventory_item_id}`);
    for (let i = 0; i < toTrack.length; i += 20) {
      const chunk = toTrack.slice(i, i + 20);
      const al = chunk.map((id, k) => `t${k}: inventoryItemUpdate(id:"${id}", input:{tracked:true}){ userErrors{ message } }`).join('\n');
      await gql(headers, `mutation{ ${al} }`, {}); await sleep(120);
    }
    // quantités (lots de 100) — uniquement les trackés
    const setQ = rows.filter(x => x.tracked).map(x => ({ inventoryItemId: `gid://shopify/InventoryItem/${x.inventory_item_id}`, locationId: locId, quantity: x.quantity ?? 0 }));
    for (let i = 0; i < setQ.length; i += 100) {
      const chunk = setQ.slice(i, i + 100);
      const r2 = await gql(headers, `mutation($in:InventorySetOnHandQuantitiesInput!){ inventorySetOnHandQuantities(input:$in){ userErrors{ message } } }`, { in: { reason: 'correction', setQuantities: chunk } });
      if (r2.errors) errors += chunk.length; else restored += chunk.length;
      await sleep(150);
    }
    return res.status(200).json({ ok: true, done: false, nextOffset: offset + limit, this_batch: { restored, errors } });
  }

  // ── FIX disponible : POST body {items:[{inventory_item_id, quantity}]} → set available ──
  if (req.query.setavail) {
    let body = '';
    await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
    const items = JSON.parse(body).items || [];
    const locId = await getLocId(headers);
    let done = 0, errors = 0;
    for (let i = 0; i < items.length; i += 100) {
      const chunk = items.slice(i, i + 100);
      const quantities = chunk.map(x => ({ inventoryItemId: `gid://shopify/InventoryItem/${x.inventory_item_id}`, locationId: locId, quantity: x.quantity }));
      const r = await gql(headers,
        `mutation($in:InventorySetQuantitiesInput!){ inventorySetQuantities(input:$in){ userErrors{ message } } }`,
        { in: { name: 'available', reason: 'correction', ignoreCompareQuantity: true, quantities } });
      if (r.errors || r.data?.inventorySetQuantities?.userErrors?.length) {
        errors += chunk.length;
        return res.status(200).json({ ok: false, done, errors, detail: r.errors || r.data?.inventorySetQuantities?.userErrors });
      }
      done += chunk.length;
      await sleep(150);
    }
    return res.status(200).json({ ok: true, done, errors });
  }

  // ── CAPTURER l'état live ──
  const label = req.query.label;
  if (!label) return res.status(400).json({ error: 'label requis' });
  const cursor = req.query.cursor || null;

  const data = await gql(headers, PAGE_Q, { cursor });
  if (!data.data) return res.status(500).json({ error: JSON.stringify(data.errors) });
  const { nodes: products, pageInfo } = data.data.products;

  const rows = [];
  for (const p of products) for (const v of p.variants.nodes) {
    rows.push({
      label,
      variant_id: Number(v.id.split('/').pop()),
      inventory_item_id: Number(v.inventoryItem.id.split('/').pop()),
      product_title: p.title,
      variant_title: v.title,
      tracked: v.inventoryItem.tracked,
      policy: v.inventoryPolicy,
      quantity: v.inventoryQuantity,
    });
  }

  if (rows.length) {
    const ins = await fetch(`${SB_URL}/rest/v1/inventory_snapshots`, { method: 'POST', headers: sbHeaders, body: JSON.stringify(rows) });
    if (!ins.ok) return res.status(500).json({ error: `Insert ${ins.status}: ${await ins.text()}` });
  }

  return res.status(200).json({ ok: true, done: !pageInfo.hasNextPage, nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null, captured: rows.length });
};
