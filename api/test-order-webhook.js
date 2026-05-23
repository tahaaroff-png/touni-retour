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
  const r = await fetch(`${SB_URL}/rest/v1/stock?select=id,product,size,qty&qty=gt.0&status=eq.retour&limit=500`, { headers: supabaseHeaders() });
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

  return res.status(400).json({ error: 'Unknown mode. Use ?mode=match|orders|selftest|titles|fix-titles or POST.' });
};
