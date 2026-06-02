// Endpoint de diagnostic multi-mode (protégé par secret)
// GET ?secret=...&mode=match&title=...&size=...&color=... → simule le matching
// GET ?secret=...&mode=orders&limit=5             → dernières commandes Shopify + matching
// GET ?secret=...&mode=selftest&title=...&size=...→ envoie un vrai webhook HMAC-signé
// GET ?secret=...&mode=titles                     → compare admin titles vs storefront displayed titles
// GET ?secret=...&mode=fix-titles&dry=1           → corrige les titres admin (dry=1 = preview seulement)
// POST ?secret=...  (body JSON order Shopify)      → simule le matching sur un payload réel

const crypto = require('crypto');
const { SB_URL, supabaseHeaders, shopifyAdminHeaders, SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, normalizeSize, normalizeColor } = require('./_shopify-helpers.js');

const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';

function jaccardSim(a, b) {
  const tok = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  const sa = tok(a), sb = tok(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0; for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function parseVariantTitle(variantTitle) {
  if (!variantTitle) return { size: null, color: null };
  const parts = variantTitle.split(/\s*[\/\|]\s*/).map(p => p.trim());
  const SL = new Set(['XS','S','M','L','XL','XXL','2XL','3XL','4XL']);
  if (parts.length === 1) {
    return SL.has(parts[0].toUpperCase()) ? { size: parts[0], color: null } : { size: null, color: parts[0] };
  }
  return { size: parts[0]||null, color: parts.slice(1).join('/')||null };
}

async function getRetourStock() {
  const r = await fetch(`${SB_URL}/rest/v1/stock?select=id,product,size,qty&qty=gt.0&status=eq.retour&limit=500`, { headers: supabaseHeaders(true) });
  return r.ok ? r.json() : [];
}

function matchStock(retourStock, title, size, color) {
  const normSize = normalizeSize(size), normColor = normalizeColor(color);
  const filterSC = rows => rows.filter(c => {
    const p = String(c.size||'').split('|');
    const cs = p[0]?p[0].trim():'', cc = p.length>1?p[1].trim():'';
    if (normalizeSize(cs) !== normSize) return false;
    if (normColor && normalizeColor(cc) !== normColor) return false;
    return true;
  });
  // exact
  let candidates = retourStock.filter(s => s.product === title);
  let method = 'exact';
  if (!candidates.length) {
    const scored = retourStock.map(s=>({...s,_sc:jaccardSim(title,s.product)})).filter(s=>s._sc>=0.50).sort((a,b)=>b._sc-a._sc);
    if (scored.length) { const top=scored[0]._sc; candidates=scored.filter(s=>s._sc>=top-0.05); }
    method = candidates.length ? 'fuzzy' : 'none';
  }
  return { method, candidates: candidates.length, matched: filterSC(candidates), normSize, normColor };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const expected = process.env.SYNC_SECRET || 'touni-sync-2026';
  if ((req.query?.secret || req.headers['x-sync-secret']) !== expected)
    return res.status(401).json({ error: 'Unauthorized' });

  const mode = req.query.mode || (req.method === 'POST' ? 'post' : 'match');

  // ── MODE: check-scopes — affiche les scopes du token actuel ───────────────
  if (mode === 'check-scopes') {
    const adminHdrs = await shopifyAdminHeaders();
    const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/oauth/access_scopes.json`, { headers: adminHdrs });
    const data = await r.json();
    return res.status(r.ok ? 200 : r.status).json(data);
  }

  // ── MODE: match (GET) ──────────────────────────────────────────────────────
  if (mode === 'match') {
    const { title, size, color } = req.query;
    if (!title) return res.status(400).json({ error: 'Missing ?title=' });
    const retourStock = await getRetourStock();
    const result = matchStock(retourStock, title, size||null, color||null);
    return res.status(200).json({ input: { title, size, color }, ...result,
      topSimilar: retourStock.map(s=>({product:s.product,score:jaccardSim(title,s.product)})).sort((a,b)=>b.score-a.score).slice(0,5) });
  }

  // ── MODE: orders (GET) ─────────────────────────────────────────────────────
  if (mode === 'orders') {
    const limit = parseInt(req.query.limit)||5;
    const headers = await shopifyAdminHeaders();
    const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
    const ordRes = await fetch(`${base}/orders.json?limit=${limit}&status=any&order=created_at+desc`, { headers });
    const { orders } = await ordRes.json();
    const whRes = await fetch(`${base}/webhooks.json`, { headers });
    const { webhooks } = await whRes.json();
    const retourStock = await getRetourStock();

    const report = orders.map(o => ({
      order: o.name, id: o.id, created_at: o.created_at,
      customer: `${o.customer?.first_name||''} ${o.customer?.last_name||''}`.trim() || o.shipping_address?.name,
      line_items: (o.line_items||[]).map(item => {
        const {size,color} = parseVariantTitle(item.variant_title||'');
        const m = matchStock(retourStock, item.title||'', size, color);
        return { title: item.title, variant_title: item.variant_title, size, color, ...m };
      }),
    }));

    return res.status(200).json({
      secret_ok: !!SHOPIFY_CLIENT_SECRET,
      secret_prefix: SHOPIFY_CLIENT_SECRET ? SHOPIFY_CLIENT_SECRET.slice(0,6)+'...' : null,
      retour_stock_count: retourStock.length,
      webhooks: webhooks.map(w=>({id:w.id,topic:w.topic,address:w.address})),
      orders: report,
    });
  }

  // ── MODE: selftest (GET) — envoie un webhook HMAC-signé au vrai endpoint ──
  if (mode === 'selftest') {
    const title = req.query.title || 'Maillot Maroc domicile coupe du monde 2026/2027';
    const size  = req.query.size  || 'L';
    const color = req.query.color || null;
    const variantId = parseInt(req.query.variant_id) || 88000000001;
    const fakeOrder = {
      id: 99888000001, name: '#TEST-SELFTEST', order_number: 9001, total_price: '350.00',
      customer: { first_name: 'Test', last_name: 'SelfTest' },
      shipping_address: { city: 'Casablanca', name: 'Test SelfTest' },
      line_items: [{ id: 1, title, variant_title: color ? `${size} / ${color}` : size, variant_id: variantId, quantity: 1, price: '350.00' }],
    };
    const body = JSON.stringify(fakeOrder);
    const hmac = SHOPIFY_CLIENT_SECRET
      ? crypto.createHmac('sha256', SHOPIFY_CLIENT_SECRET).update(body).digest('base64')
      : 'NO_SECRET';
    const webhookRes = await fetch(`https://touni-retour.vercel.app/api/shopify-order-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Topic': 'orders/create', 'X-Shopify-Hmac-Sha256': hmac, 'X-Shopify-Shop-Domain': SHOPIFY_DOMAIN },
      body,
    });
    const webhookBody = await webhookRes.json().catch(() => webhookRes.text());
    return res.status(200).json({ test_payload: {title,size,color,variantId}, secret_configured: !!SHOPIFY_CLIENT_SECRET, webhook_status: webhookRes.status, webhook_response: webhookBody });
  }

  // ── MODE: post (POST body JSON) ────────────────────────────────────────────
  if (mode === 'post' || req.method === 'POST') {
    const body = req.body || {};
    const retourStock = await getRetourStock();
    const report = (body.line_items||[]).map(item => {
      const {size,color} = parseVariantTitle(item.variant_title||'');
      const m = matchStock(retourStock, item.title||'', size, color);
      return { title: item.title, variant_title: item.variant_title, size, color, ...m };
    });
    return res.status(200).json({ line_items_count: (body.line_items||[]).length, report });
  }

  // ── MODE: titles / fix-titles ─────────────────────────────────────────────
  if (mode === 'titles' || mode === 'fix-titles') {
    const isDry = req.query.dry !== '0'; // dry=0 pour vraiment appliquer
    const GQL_URL = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const adminHdrs = await shopifyAdminHeaders();

    // Récupérer toutes les traductions produit via GraphQL (Translate & Adapt)
    async function getAllTranslatedTitles() {
      const results = {}; // resourceId → { adminTitle, translatedTitle }
      let cursor = null;
      let page = 0;
      while (page < 20) { // max 20 pages × 100 = 2000 produits
        page++;
        const query = `{
          translatableResources(resourceType: PRODUCT, first: 100${cursor ? `, after: "${cursor}"` : ''}) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                resourceId
                translatableContent { key value locale }
                translations(locale: "fr") { key value }
              }
            }
          }
        }`;
        const r = await fetch(GQL_URL, { method: 'POST', headers: { ...adminHdrs, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
        const { data, errors } = await r.json();
        if (errors) return { error: errors };
        const { edges, pageInfo } = data.translatableResources;
        for (const { node } of edges) {
          const id = node.resourceId; // gid://shopify/Product/XXXXX
          const adminTitleObj = node.translatableContent.find(c => c.key === 'title');
          const translatedTitleObj = node.translations.find(t => t.key === 'title');
          if (adminTitleObj) {
            results[id] = {
              adminTitle: adminTitleObj.value,
              translatedTitle: translatedTitleObj ? translatedTitleObj.value : null,
            };
          }
        }
        if (!pageInfo.hasNextPage) break;
        cursor = pageInfo.endCursor;
      }
      return results;
    }

    const titles = await getAllTranslatedTitles();
    if (titles.error) return res.status(500).json({ error: titles.error });

    const mismatches = [];
    const same = [];
    for (const [gid, { adminTitle, translatedTitle }] of Object.entries(titles)) {
      const numId = gid.split('/').pop();
      if (translatedTitle && translatedTitle !== adminTitle) {
        mismatches.push({ id: numId, gid, adminTitle, translatedTitle });
      } else {
        same.push({ id: numId, adminTitle });
      }
    }

    if (mode === 'titles') {
      return res.status(200).json({
        total: Object.keys(titles).length,
        mismatches_count: mismatches.length,
        same_count: same.length,
        mismatches,
      });
    }

    // fix-titles: mettre à jour le titre admin = titre traduit, puis supprimer la traduction
    const fixed = [], errors_arr = [];
    for (const m of mismatches) {
      if (!isDry) {
        // 1. Mettre à jour le titre admin via REST
        const updateRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products/${m.id}.json`, {
          method: 'PUT',
          headers: adminHdrs,
          body: JSON.stringify({ product: { id: m.id, title: m.translatedTitle } }),
        });
        if (!updateRes.ok) {
          errors_arr.push({ id: m.id, error: await updateRes.text() });
          continue;
        }
        // 2. Supprimer la traduction (DELETE via GraphQL)
        const delQuery = `mutation { translationsRemove(resourceId: "${m.gid}", translationKeys: ["title"], locales: ["fr"]) { userErrors { field message } } }`;
        await fetch(GQL_URL, { method: 'POST', headers: { ...adminHdrs, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: delQuery }) });
      }
      fixed.push({ id: m.id, old: m.adminTitle, new: m.translatedTitle, applied: !isDry });
    }

    return res.status(200).json({
      dry_run: isDry,
      total_mismatches: mismatches.length,
      fixed_count: fixed.length,
      errors_count: errors_arr.length,
      fixed,
      errors: errors_arr,
    });
  }

  // ── MODE: restore-titles — restaure les titres admin depuis le cache Supabase ────────────
  // Utilise shopify_variants_cache (mis à jour avant les modifs d'aujourd'hui) comme source de vérité.
  // GET ?secret=...&mode=restore-titles&dry=1   → aperçu des restaurations nécessaires
  // GET ?secret=...&mode=restore-titles&dry=0   → restauration effective
  if (mode === 'restore-titles') {
    const isDry = req.query.dry !== '0';
    const adminHdrs = await shopifyAdminHeaders();

    // 1. Récupérer les titres originaux depuis le cache Supabase (le plus récent par produit)
    const cacheRes = await fetch(
      `${SB_URL}/rest/v1/rpc/get_original_titles`,
      { method: 'POST', headers: supabaseHeaders(true) }
    ).catch(() => null);

    // Récupérer toutes les lignes du cache via pagination (PostgREST limite à 1000 par défaut)
    const cacheMap = {}; // product_id → original title (le plus récent)
    let cacheOffset = 0;
    const PAGE_SIZE = 1000;
    while (true) {
      const sbRes = await fetch(
        `${SB_URL}/rest/v1/shopify_variants_cache?select=product_id,product_title,updated_at&order=product_id,updated_at.desc&limit=${PAGE_SIZE}&offset=${cacheOffset}`,
        { headers: { ...supabaseHeaders(true), Prefer: 'count=none' } }
      );
      if (!sbRes.ok) return res.status(500).json({ error: 'Cache fetch failed', status: sbRes.status });
      const rows = await sbRes.json();
      for (const row of rows) {
        // Garder le titre le plus récent par product_id (premier rencontré = plus récent grâce au tri DESC)
        if (!cacheMap[row.product_id]) cacheMap[row.product_id] = row.product_title;
      }
      if (rows.length < PAGE_SIZE) break;
      cacheOffset += PAGE_SIZE;
    }

    // 2. Récupérer tous les produits admin actuels
    const adminProducts = {};
    let adminUrl = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250&fields=id,title,handle`;
    while (adminUrl) {
      const r = await fetch(adminUrl, { headers: adminHdrs });
      if (!r.ok) break;
      const { products } = await r.json();
      for (const p of (products || [])) adminProducts[p.id] = { title: p.title, handle: p.handle };
      const link = r.headers.get('link') || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      adminUrl = nextMatch ? nextMatch[1] : null;
    }

    // 3. Trouver les produits dont le titre admin ≠ titre dans le cache (= ceux que j'ai modifiés)
    const toRestore = [];
    for (const [pidStr, cached] of Object.entries(cacheMap)) {
      const pid = parseInt(pidStr);
      const admin = adminProducts[pid];
      if (!admin) continue;
      if (admin.title.trim() !== cached.trim()) {
        toRestore.push({ id: pid, handle: admin.handle, currentTitle: admin.title, originalTitle: cached });
      }
    }

    if (isDry) {
      return res.status(200).json({
        dry_run: true,
        cache_products: Object.keys(cacheMap).length,
        admin_products: Object.keys(adminProducts).length,
        to_restore_count: toRestore.length,
        to_restore: toRestore,
      });
    }

    // 4. Restaurer séquentiellement pour respecter la limite Shopify (2 req/sec)
    // On envoie 2 requêtes à la fois avec 600ms de pause entre chaque lot
    const restored = [], errors_arr = [];
    const CHUNK = 2;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < toRestore.length; i += CHUNK) {
      const chunk = toRestore.slice(i, i + CHUNK);
      const results = await Promise.all(chunk.map(async m => {
        const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products/${m.id}.json`, {
          method: 'PUT',
          headers: adminHdrs,
          body: JSON.stringify({ product: { id: m.id, title: m.originalTitle } }),
        });
        if (r.ok) return { ok: true, ...m };
        return { ok: false, id: m.id, handle: m.handle, error: await r.text() };
      }));
      for (const r of results) {
        if (r.ok) restored.push({ id: r.id, handle: r.handle, restored: r.originalTitle, was: r.currentTitle });
        else errors_arr.push({ id: r.id, handle: r.handle, error: r.error });
      }
      if (i + CHUNK < toRestore.length) await sleep(600); // respecte la limite Shopify
    }

    return res.status(200).json({
      dry_run: false,
      to_restore_count: toRestore.length,
      restored_count: restored.length,
      errors_count: errors_arr.length,
      restored,
      errors: errors_arr,
    });
  }

  // ── MODE: check-product — debug titre storefront vs admin pour un produit donné ──────────
  // GET ?secret=...&mode=check-product&handle=wydad-ac-travel-shirt-2-2025-2026
  if (mode === 'check-product') {
    const handle = req.query.handle || 'wydad-ac-travel-shirt-2-2025-2026';
    const STOREFRONT_DOMAIN = process.env.SHOPIFY_STOREFRONT_DOMAIN || 'touni.ma';
    const adminHdrs = await shopifyAdminHeaders();

    // Fetch storefront individual product JSON
    const sfIndivRes = await fetch(`https://${STOREFRONT_DOMAIN}/products/${handle}.json`);
    const sfIndiv = sfIndivRes.ok ? (await sfIndivRes.json()).product : null;

    // Fetch storefront LIST (page 1) and search for this handle
    let sfListTitle = null;
    for (let page = 1; page <= 5; page++) {
      const r = await fetch(`https://${STOREFRONT_DOMAIN}/products.json?limit=250&page=${page}`);
      if (!r.ok) break;
      const { products } = await r.json();
      if (!products?.length) break;
      const found = products.find(p => p.handle === handle);
      if (found) { sfListTitle = found.title; break; }
      if (products.length < 250) break;
    }

    // Fetch admin product by handle
    const adminHandleRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?handle=${handle}&fields=id,title,handle`, { headers: adminHdrs });
    const adminHandle = adminHandleRes.ok ? ((await adminHandleRes.json()).products || [])[0] : null;

    return res.status(200).json({
      handle,
      storefront_individual_title: sfIndiv?.title || null,
      storefront_list_title: sfListTitle,
      admin_title: adminHandle?.title || null,
      admin_id: adminHandle?.id || null,
      storefront_domain_used: STOREFRONT_DOMAIN,
    });
  }

  // ── MODE: fix-titles-v2 — compare storefront JSON (traduit) vs admin, corrige l'admin ──────
  // Ne nécessite PAS le scope read_translations : utilise l'API publique storefront pour les titres affichés.
  // GET ?secret=...&mode=fix-titles-v2&dry=1   → aperçu des écarts
  // GET ?secret=...&mode=fix-titles-v2&dry=0   → correction effective
  if (mode === 'fix-titles-v2') {
    const isDry = req.query.dry !== '0';
    const adminHdrs = await shopifyAdminHeaders();

    // 1. Récupérer les titres storefront (API publique sur le domaine custom = locale FR traduite)
    // IMPORTANT : bjuanm-1r.myshopify.com retourne les titres admin (non traduits)
    //             touni.ma retourne les titres traduits (affichés aux visiteurs)
    const STOREFRONT_DOMAIN = process.env.SHOPIFY_STOREFRONT_DOMAIN || 'touni.ma';
    const storefrontProducts = {};
    for (let page = 1; page <= 10; page++) {
      const r = await fetch(`https://${STOREFRONT_DOMAIN}/products.json?limit=250&page=${page}`);
      if (!r.ok) break;
      const { products } = await r.json();
      if (!products?.length) break;
      for (const p of products) storefrontProducts[p.id] = { title: p.title, handle: p.handle };
      if (products.length < 250) break;
    }

    // 2. Récupérer les titres admin (REST Admin API)
    const adminProducts = {};
    let adminUrl = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250&fields=id,title,handle`;
    while (adminUrl) {
      const r = await fetch(adminUrl, { headers: adminHdrs });
      if (!r.ok) break;
      const { products } = await r.json();
      for (const p of (products || [])) adminProducts[p.id] = { title: p.title, handle: p.handle };
      const link = r.headers.get('link') || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      adminUrl = nextMatch ? nextMatch[1] : null;
    }

    // 3. Détecter les écarts (title admin ≠ title storefront/affiché)
    // On compare les versions trimmées pour ignorer espaces de fin parasites
    const mismatches = [];
    for (const [idStr, adminData] of Object.entries(adminProducts)) {
      const id = parseInt(idStr);
      const sf = storefrontProducts[id];
      if (!sf) continue; // produit non publié ou absent
      const sfTrimmed = sf.title.trim();
      const adminTrimmed = adminData.title.trim();
      if (sfTrimmed !== adminTrimmed) {
        mismatches.push({ id, handle: adminData.handle, adminTitle: adminData.title, storefrontTitle: sfTrimmed });
      }
    }

    // Debug: check the known Wydad mismatch product specifically
    const WYDAD_ID = 9337499451611;
    const wydadSf = storefrontProducts[WYDAD_ID];
    const wydadAdmin = adminProducts[WYDAD_ID];
    const debugWydad = {
      id: WYDAD_ID,
      sf_title: wydadSf?.title ?? 'NOT FOUND IN STOREFRONT',
      admin_title: wydadAdmin?.title ?? 'NOT FOUND IN ADMIN',
      sf_keys_sample: Object.keys(storefrontProducts).slice(0, 3),
      admin_keys_sample: Object.keys(adminProducts).slice(0, 3),
      sf_key_type: typeof Object.keys(storefrontProducts)[0],
      admin_key_type: typeof Object.keys(adminProducts)[0],
    };

    if (isDry) {
      return res.status(200).json({
        dry_run: true,
        storefront_count: Object.keys(storefrontProducts).length,
        admin_count: Object.keys(adminProducts).length,
        mismatches_count: mismatches.length,
        mismatches,
        debug_wydad: debugWydad,
      });
    }

    // 4. Corriger séquentiellement (2 req/600ms) pour respecter la limite Shopify
    const fixed = [], errors_arr = [];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const CHUNK = 2;
    for (let i = 0; i < mismatches.length; i += CHUNK) {
      const chunk = mismatches.slice(i, i + CHUNK);
      const results = await Promise.all(chunk.map(async m => {
        const updateRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products/${m.id}.json`, {
          method: 'PUT',
          headers: adminHdrs,
          body: JSON.stringify({ product: { id: m.id, title: m.storefrontTitle } }),
        });
        if (updateRes.ok) {
          return { ok: true, id: m.id, handle: m.handle, old: m.adminTitle, new: m.storefrontTitle };
        } else {
          return { ok: false, id: m.id, handle: m.handle, error: await updateRes.text() };
        }
      }));
      for (const r of results) {
        if (r.ok) fixed.push({ id: r.id, handle: r.handle, old: r.old, new: r.new });
        else errors_arr.push({ id: r.id, handle: r.handle, error: r.error });
      }
      if (i + CHUNK < mismatches.length) await sleep(600);
    }

    return res.status(200).json({
      dry_run: false,
      total_mismatches: mismatches.length,
      batch_offset: offset,
      batch_size: batchMismatches.length,
      fixed_count: fixed.length,
      errors_count: errors_arr.length,
      fixed,
      errors: errors_arr,
    });
  }

  // ── MODE: delete-translations — supprime les overrides Translate & Adapt sans toucher à l'admin ──
  // GET ?secret=...&mode=delete-translations&dry=1  → aperçu
  // GET ?secret=...&mode=delete-translations&dry=0  → suppression effective
  if (mode === 'delete-translations') {
    const isDry = req.query.dry !== '0';
    const GQL_URL = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const STOREFRONT_DOMAIN = process.env.SHOPIFY_STOREFRONT_DOMAIN || 'touni.ma';

    // Récupérer le token d'installation (potentiellement plus de scopes)
    let installToken = null;
    const settingsRes = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.shopify_install_token&select=value`, { headers: supabaseHeaders(true) });
    if (settingsRes.ok) {
      const rows = await settingsRes.json();
      installToken = rows[0]?.value || null;
    }
    const gqlHdrs = {
      'X-Shopify-Access-Token': installToken || (await shopifyAdminHeaders())['X-Shopify-Access-Token'],
      'Content-Type': 'application/json',
    };
    const adminHdrs = await shopifyAdminHeaders();

    // 1. Trouver les produits avec écart storefront vs admin (sans read_translations)
    const storefrontProducts = {};
    for (let page = 1; page <= 10; page++) {
      const r = await fetch(`https://${STOREFRONT_DOMAIN}/products.json?limit=250&page=${page}`);
      if (!r.ok) break;
      const { products } = await r.json();
      if (!products?.length) break;
      for (const p of products) storefrontProducts[p.id] = p.title.trim();
      if (products.length < 250) break;
    }
    const adminProducts = {};
    let adminUrl = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250&fields=id,title,handle`;
    while (adminUrl) {
      const r = await fetch(adminUrl, { headers: adminHdrs });
      if (!r.ok) break;
      const { products } = await r.json();
      for (const p of (products || [])) adminProducts[p.id] = { title: p.title.trim(), handle: p.handle };
      const link = r.headers.get('link') || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      adminUrl = nextMatch ? nextMatch[1] : null;
    }

    // Construire la liste des produits dont le titre storefront ≠ titre admin
    const toDelete = [];
    for (const [idStr, adminData] of Object.entries(adminProducts)) {
      const id = parseInt(idStr);
      const sfTitle = storefrontProducts[id];
      if (!sfTitle || sfTitle === adminData.title) continue;
      toDelete.push({
        id,
        gid: `gid://shopify/Product/${id}`,
        handle: adminData.handle,
        adminTitle: adminData.title,
        storefrontTitle: sfTitle,
      });
    }

    if (isDry) {
      return res.status(200).json({
        dry_run: true,
        token_used: installToken ? 'install_token' : 'client_credentials',
        overrides_found: toDelete.length,
        sample: toDelete.slice(0, 5),
      });
    }

    // 2. Tenter translationsRemove directement (nécessite write_translations)
    const deleted = [], errors_arr = [];
    for (let i = 0; i < toDelete.length; i++) {
      const m = toDelete[i];
      const delQuery = `mutation { translationsRemove(resourceId: "${m.gid}", translationKeys: ["title"], locales: ["fr"]) { userErrors { field message } } }`;
      const delRes = await fetch(GQL_URL, { method: 'POST', headers: gqlHdrs, body: JSON.stringify({ query: delQuery }) });
      const delData = await delRes.json();
      if (delData.errors) {
        errors_arr.push({ gid: m.gid, adminTitle: m.adminTitle, errors: delData.errors });
        if (i === 0) break; // Si le premier échoue par scope, inutile de continuer
      } else {
        const userErrors = delData?.data?.translationsRemove?.userErrors || [];
        if (userErrors.length) errors_arr.push({ gid: m.gid, adminTitle: m.adminTitle, errors: userErrors });
        else deleted.push({ gid: m.gid, handle: m.handle, adminTitle: m.adminTitle, removedTranslation: m.storefrontTitle });
      }
      if (i < toDelete.length - 1) await sleep(550);
    }

    return res.status(200).json({
      dry_run: false,
      token_used: installToken ? 'install_token' : 'client_credentials',
      overrides_found: toDelete.length,
      deleted_count: deleted.length,
      errors_count: errors_arr.length,
      deleted,
      errors: errors_arr,
    });
  }

  // ── MODE: fix-via-metafield — crée/met à jour un metafield touni.admin_title pour chaque produit
  // dont le titre storefront (touni.ma) ≠ titre admin (Shopify Admin API).
  // Ne nécessite PAS write_translations — utilise uniquement metafields + REST Admin.
  // GET ?secret=...&mode=fix-via-metafield&dry=1   → aperçu des écarts (aucune écriture)
  // GET ?secret=...&mode=fix-via-metafield&dry=0   → crée/met à jour les metafields
  if (mode === 'fix-via-metafield') {
    const isDry = req.query.dry !== '0';
    const STOREFRONT_DOMAIN = process.env.SHOPIFY_STOREFRONT_DOMAIN || 'touni.ma';
    const adminHdrs = await shopifyAdminHeaders();
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const CHUNK = 2;

    // 1. Récupérer les titres storefront (touni.ma = titres traduits affichés aux visiteurs)
    const storefrontProducts = {};
    for (let page = 1; page <= 10; page++) {
      const r = await fetch(`https://${STOREFRONT_DOMAIN}/products.json?limit=250&page=${page}`);
      if (!r.ok) break;
      const { products } = await r.json();
      if (!products?.length) break;
      for (const p of products) storefrontProducts[p.id] = p.title.trim();
      if (products.length < 250) break;
    }

    // 2. Récupérer les titres admin (REST Admin API = titre original non traduit)
    const adminProducts = {};
    let adminUrl = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250&fields=id,title,handle`;
    while (adminUrl) {
      const r = await fetch(adminUrl, { headers: adminHdrs });
      if (!r.ok) break;
      const { products } = await r.json();
      for (const p of (products || [])) adminProducts[p.id] = { title: p.title.trim(), handle: p.handle };
      const link = r.headers.get('link') || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      adminUrl = nextMatch ? nextMatch[1] : null;
    }

    // 3. Détecter les écarts : storefront affiche le titre traduit, admin a un titre différent
    // → On veut stocker le titre ADMIN dans un metafield pour l'utiliser dans le thème
    const mismatches = [];
    for (const [idStr, adminData] of Object.entries(adminProducts)) {
      const id = parseInt(idStr);
      const sfTitle = storefrontProducts[id];
      if (!sfTitle) continue; // produit non publié
      if (sfTitle !== adminData.title) {
        mismatches.push({
          id,
          handle: adminData.handle,
          adminTitle: adminData.title,   // titre qu'on veut afficher (correct)
          storefrontTitle: sfTitle,       // titre affiché actuellement (override traduit)
        });
      }
    }

    if (isDry) {
      return res.status(200).json({
        dry_run: true,
        storefront_count: Object.keys(storefrontProducts).length,
        admin_count: Object.keys(adminProducts).length,
        mismatches_count: mismatches.length,
        sample: mismatches.slice(0, 10),
        note: 'Passe dry=0 pour créer/mettre à jour les metafields touni.admin_title',
      });
    }

    // 4. Créer/mettre à jour le metafield touni.admin_title pour chaque mismatch
    const created = [], errors_arr = [];
    for (let i = 0; i < mismatches.length; i += CHUNK) {
      const chunk = mismatches.slice(i, i + CHUNK);
      const results = await Promise.all(chunk.map(async m => {
        const body = JSON.stringify({
          metafield: {
            namespace: 'touni',
            key: 'admin_title',
            value: m.adminTitle,
            type: 'single_line_text_field',
          },
        });
        const r = await fetch(
          `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products/${m.id}/metafields.json`,
          { method: 'POST', headers: adminHdrs, body }
        );
        const data = await r.json();
        if (r.ok) {
          return { ok: true, id: m.id, handle: m.handle, adminTitle: m.adminTitle, storefrontTitle: m.storefrontTitle, metafield_id: data.metafield?.id };
        } else {
          // Si le metafield existe déjà, tenter un PUT via lookup + update
          // Shopify retourne 422 si on POST un metafield déjà existant → on le recherche et met à jour
          const listRes = await fetch(
            `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products/${m.id}/metafields.json?namespace=touni&key=admin_title`,
            { headers: adminHdrs }
          );
          if (listRes.ok) {
            const listData = await listRes.json();
            const existing = (listData.metafields || [])[0];
            if (existing) {
              const putRes = await fetch(
                `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products/${m.id}/metafields/${existing.id}.json`,
                { method: 'PUT', headers: adminHdrs, body: JSON.stringify({ metafield: { id: existing.id, value: m.adminTitle, type: 'single_line_text_field' } }) }
              );
              if (putRes.ok) {
                const putData = await putRes.json();
                return { ok: true, id: m.id, handle: m.handle, adminTitle: m.adminTitle, storefrontTitle: m.storefrontTitle, metafield_id: putData.metafield?.id, updated: true };
              }
              return { ok: false, id: m.id, handle: m.handle, error: `PUT failed: ${await putRes.text()}` };
            }
          }
          return { ok: false, id: m.id, handle: m.handle, error: `POST failed: ${JSON.stringify(data)}` };
        }
      }));
      for (const r of results) {
        if (r.ok) created.push(r);
        else errors_arr.push(r);
      }
      if (i + CHUNK < mismatches.length) await sleep(600);
    }

    return res.status(200).json({
      dry_run: false,
      total_mismatches: mismatches.length,
      created_count: created.length,
      errors_count: errors_arr.length,
      created,
      errors: errors_arr,
      next_step: 'Modifier le thème Bee pour utiliser product.metafields.touni.admin_title | default: product.title',
    });
  }

  // ── MODE: theme-inspect — lit les fichiers du thème actif pour trouver product.title ──────
  // GET ?secret=...&mode=theme-inspect&asset=sections/main-product.liquid
  if (mode === 'theme-inspect') {
    const adminHdrs = await shopifyAdminHeaders();
    const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;

    // 1. Trouver le thème actif
    const themesRes = await fetch(`${base}/themes.json`, { headers: adminHdrs });
    const { themes } = await themesRes.json();
    const activeTheme = themes.find(t => t.role === 'main') || themes[0];
    if (!activeTheme) return res.status(500).json({ error: 'No active theme found' });

    const themeId = activeTheme.id;
    const assetKey = req.query.asset || null;

    if (!assetKey) {
      // Lister tous les assets du thème
      const assetsRes = await fetch(`${base}/themes/${themeId}/assets.json`, { headers: adminHdrs });
      const { assets } = await assetsRes.json();
      // Filtrer les assets intéressants (sections, templates, layout)
      const relevant = (assets || []).filter(a =>
        a.key.startsWith('sections/') || a.key.startsWith('templates/') || a.key.startsWith('layout/')
      ).map(a => a.key);
      return res.status(200).json({
        theme_id: themeId,
        theme_name: activeTheme.name,
        theme_role: activeTheme.role,
        relevant_assets: relevant,
        all_count: (assets || []).length,
      });
    }

    // Lire le contenu d'un asset spécifique
    const assetRes = await fetch(`${base}/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(assetKey)}`, { headers: adminHdrs });
    if (!assetRes.ok) return res.status(assetRes.status).json({ error: `Asset fetch failed: ${assetRes.status}` });
    const assetData = await assetRes.json();
    const content = assetData.asset?.value || '';

    // Rechercher toutes les occurrences de product.title
    const lines = content.split('\n');
    const titleLines = lines.reduce((acc, line, idx) => {
      if (line.includes('product.title')) acc.push({ line: idx + 1, content: line.trim() });
      return acc;
    }, []);

    return res.status(200).json({
      theme_id: themeId,
      theme_name: activeTheme.name,
      asset_key: assetKey,
      total_lines: lines.length,
      product_title_occurrences: titleLines.length,
      product_title_lines: titleLines,
      // Inclure le contenu complet si moins de 500 lignes
      full_content: lines.length <= 500 ? content : `[FILE TOO LARGE: ${lines.length} lines — use ?asset= to narrow down]`,
    });
  }

  // ── MODE: fix-theme — modifie le thème actif pour utiliser product.metafields.touni.admin_title ──
  // GET ?secret=...&mode=fix-theme&asset=sections/main-product.liquid&dry=1
  if (mode === 'fix-theme') {
    const adminHdrs = await shopifyAdminHeaders();
    const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
    const isDry = req.query.dry !== '0';

    // 1. Trouver le thème actif
    const themesRes = await fetch(`${base}/themes.json`, { headers: adminHdrs });
    const { themes } = await themesRes.json();
    const activeTheme = themes.find(t => t.role === 'main') || themes[0];
    if (!activeTheme) return res.status(500).json({ error: 'No active theme found' });
    const themeId = activeTheme.id;

    const assetKey = req.query.asset;
    if (!assetKey) return res.status(400).json({ error: 'Missing ?asset= parameter (e.g. sections/main-product.liquid)' });

    // 2. Lire l'asset
    const assetRes = await fetch(`${base}/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(assetKey)}`, { headers: adminHdrs });
    if (!assetRes.ok) return res.status(assetRes.status).json({ error: `Asset fetch failed: ${assetRes.status}` });
    const assetData = await assetRes.json();
    let content = assetData.asset?.value || '';
    const originalContent = content;

    // 3. Remplacer les occurrences de product.title par le metafield avec fallback
    // Pattern 1: {{ product.title | escape }} → {{ product.metafields.touni.admin_title | default: product.title | escape }}
    // Pattern 2: {{ product.title }}            → {{ product.metafields.touni.admin_title | default: product.title }}
    let replacements = 0;
    const original_snippets = [];

    // Remplacer {{ product.title | escape }}
    const re1 = /\{\{\s*product\.title\s*\|\s*escape\s*\}\}/g;
    content = content.replace(re1, match => {
      original_snippets.push(match);
      replacements++;
      return '{{ product.metafields.touni.admin_title | default: product.title | escape }}';
    });

    // Remplacer {{ product.title }} (sans filtre)
    const re2 = /\{\{\s*product\.title\s*\}\}/g;
    content = content.replace(re2, match => {
      original_snippets.push(match);
      replacements++;
      return '{{ product.metafields.touni.admin_title | default: product.title }}';
    });

    if (isDry) {
      const lines = originalContent.split('\n');
      const titleLines = lines.reduce((acc, line, idx) => {
        if (line.includes('product.title')) acc.push({ line: idx + 1, content: line.trim() });
        return acc;
      }, []);
      return res.status(200).json({
        dry_run: true,
        theme_id: themeId,
        theme_name: activeTheme.name,
        asset_key: assetKey,
        replacements_that_would_be_made: replacements,
        original_snippets,
        product_title_lines: titleLines,
      });
    }

    if (replacements === 0) {
      return res.status(200).json({
        dry_run: false,
        theme_id: themeId,
        asset_key: assetKey,
        message: 'No {{ product.title }} patterns found — no changes made',
        replacements: 0,
      });
    }

    // 4. Écrire l'asset modifié
    const putRes = await fetch(`${base}/themes/${themeId}/assets.json`, {
      method: 'PUT',
      headers: adminHdrs,
      body: JSON.stringify({ asset: { key: assetKey, value: content } }),
    });
    if (!putRes.ok) {
      return res.status(putRes.status).json({ error: `Asset write failed: ${putRes.status} ${await putRes.text()}` });
    }

    return res.status(200).json({
      dry_run: false,
      theme_id: themeId,
      theme_name: activeTheme.name,
      asset_key: assetKey,
      replacements_made: replacements,
      original_snippets,
      message: 'Theme asset updated. product.metafields.touni.admin_title will now be used with product.title as fallback.',
    });
  }

  return res.status(400).json({ error: 'Unknown mode. Use ?mode=match|orders|selftest|titles|fix-titles|fix-titles-v2|delete-translations|fix-via-metafield|theme-inspect|fix-theme or POST.' });
};
