// API simple pour les notifications Shopify (consultées par le dashboard admin)
// GET /api/notifications?secret=...&status=unread → liste
// GET /api/notifications?secret=...&meta=1&rate=10 → métriques Meta Ads en direct (Vue Directeur)
// PATCH /api/notifications?secret=...&id=XXX → marquer comme lu/archivé
// DELETE /api/notifications?secret=...&id=XXX → supprimer

const { SB_URL, supabaseHeaders, shopifyAdminHeaders, SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, normalizeSize, normalizeColor } = require('./_shopify-helpers.js');
// Réutilise le parsing du webhook (fonction exportée) — pour rester sous la limite de 12 fonctions Vercel
const { parseVariantTitle } = require('./shopify-order-webhook.js');

// Similarité de titres (identique au webhook) — pour le matching flou EN MÉMOIRE (évite les fetch par ligne = timeout)
function jaccardSim(a, b) {
  const tok = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  const sa = tok(a), sb = tok(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0; for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
const SCAN_FUZZY_THRESHOLD = 0.55;

// Inscription newsletter « Le Vestiaire » (footer du site, public, sans reCAPTCHA).
async function newsletterSignup(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const email = ((body && body.email) || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Email invalide' });
  try {
    const headers = await shopifyAdminHeaders();
    const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/customers.json`;
    const payload = { customer: { email, tags: 'newsletter', email_marketing_consent: { state: 'subscribed', opt_in_level: 'single_opt_in' } } };
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (r.ok) return res.status(200).json({ ok: true, status: 'subscribed' });
    const txt = await r.text();
    if (r.status === 422 && /already been taken|has already|déjà/i.test(txt)) return res.status(200).json({ ok: true, status: 'already' });
    return res.status(502).json({ ok: false, error: 'Shopify: ' + txt.slice(0, 160) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ════════ Métriques Meta Ads (fusionné ici pour rester sous la limite de 12 fonctions Vercel) ════════
const GRAPH = 'https://graph.facebook.com/v21.0';
const PUR = ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'];
function sumActions(arr, types) {
  if (!Array.isArray(arr)) return 0;
  for (const a of arr) if (types.includes(a.action_type)) return parseFloat(a.value || 0);
  return 0;
}
async function gget(token, path, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: token }).toString();
  let last = '';
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${GRAPH}/${path}?${qs}`);
    if (r.ok) return r.json();
    last = await r.text();
    const transient = [500, 502, 503].includes(r.status)
      || /"code":\s*2[,}]/.test(last) || /is_transient":\s*true/.test(last) || /temporarily unavailable/i.test(last);
    if (transient) { await new Promise(s => setTimeout(s, 800 + i * 700)); continue; }
    throw new Error(`Graph ${r.status}: ${last.slice(0, 160)}`);
  }
  throw new Error(`Graph: retries exhausted — ${last.slice(0, 120)}`);
}
async function metaMetrics(req, res) {
  const token = process.env.META_ADS_TOKEN;
  if (!token) return res.status(500).json({ error: 'META_ADS_TOKEN non configuré dans Vercel' });
  const ACT = process.env.META_AD_ACCOUNT || 'act_178386983599000';
  const rate = parseFloat(req.query?.rate || '10');
  // Période : défaut 7 jours glissants ; personnalisable via preset (last_7d/last_14d/last_30d/today) ou since+until
  const since = req.query?.since, until = req.query?.until;
  const preset = req.query?.preset || 'last_7d';
  const dateParams = (since && until) ? { time_range: JSON.stringify({ since, until }) } : { date_preset: preset };
  const periodLabel = (since && until) ? `${since} → ${until}` : preset;
  try {
    const camps = (await gget(token, `${ACT}/campaigns`, { fields: 'id,name,daily_budget,effective_status', limit: '300' })).data || [];
    const active = camps.filter(c => c.effective_status === 'ACTIVE');
    const activeIds = new Set(active.map(c => c.id));
    const ins7 = (await gget(token, `${ACT}/insights`, {
      level: 'campaign', ...dateParams,
      fields: 'campaign_id,campaign_name,spend,actions,action_values,ctr,frequency', limit: '500',
    })).data || [];
    const today = (await gget(token, `${ACT}/insights`, { date_preset: 'today', fields: 'spend,actions,action_values' })).data?.[0] || {};
    const spendToday = parseFloat(today.spend || 0);
    const insAd = (await gget(token, `${ACT}/insights`, {
      level: 'ad', ...dateParams,
      fields: 'ad_id,ad_name,campaign_name,spend,actions,action_values,ctr', limit: '600',
    })).data || [];
    // Statuts des pubs → n'alerter QUE sur les créas ACTIVES (pas celles déjà coupées)
    const adStatus = {};
    ((await gget(token, `${ACT}/ads`, { fields: 'id,effective_status', limit: '600' })).data || []).forEach(a => { adStatus[a.id] = a.effective_status; });

    let tSpend = 0, tPur = 0, tVal = 0;
    const campaigns = [];
    for (const r of ins7) {
      if (!activeIds.has(r.campaign_id)) continue;
      const sp = parseFloat(r.spend || 0), pur = sumActions(r.actions, PUR), val = sumActions(r.action_values, PUR);
      tSpend += sp; tPur += pur; tVal += val;
      campaigns.push({
        name: r.campaign_name, spend_usd: +sp.toFixed(2),
        roas: sp ? +(val / sp).toFixed(1) : 0, cpa_usd: pur ? +(sp / pur).toFixed(2) : 0,
        ctr: +parseFloat(r.ctr || 0).toFixed(2), purchases: pur,
        is_test: (r.campaign_name || '').startsWith('[TEST]'),
      });
    }
    campaigns.sort((a, b) => b.spend_usd - a.spend_usd);

    // Budget/jour : 1 SEUL appel ad sets (au lieu d'un par campagne) pour rester sous le timeout
    const allAdsets = (await gget(token, `${ACT}/adsets`, { fields: 'daily_budget,effective_status,campaign_id', limit: '500' })).data || [];
    let dailyBudget = 0;
    for (const c of active) {
      if (c.daily_budget) { dailyBudget += parseInt(c.daily_budget) / 100; continue; }
      for (const a of allAdsets) if (a.campaign_id === c.id && ['ACTIVE', 'IN_PROCESS'].includes(a.effective_status) && a.daily_budget) dailyBudget += parseInt(a.daily_budget) / 100;
    }

    const ads = insAd.map(r => {
      const sp = parseFloat(r.spend || 0), pur = sumActions(r.actions, PUR), val = sumActions(r.action_values, PUR);
      return { name: r.ad_name, ad_id: r.ad_id, campaign: r.campaign_name, spend_usd: +sp.toFixed(2),
        roas: sp ? +(val / sp).toFixed(1) : 0, purchases: pur, ctr: +parseFloat(r.ctr || 0).toFixed(2),
        is_test: (r.campaign_name || '').startsWith('[TEST]'),
        active: adStatus[r.ad_id] === 'ACTIVE' };
    });
    const top_creatives = ads.filter(a => a.purchases > 0 && a.spend_usd >= 5).sort((a, b) => b.roas - a.roas).slice(0, 8);
    // Alertes "à couper" : SEULEMENT les créas ACTIVES (pas celles déjà coupées) au-dessus du seuil sans vente
    const alerts = ads.filter(a => a.active && a.purchases === 0 && a.spend_usd >= (a.is_test ? 6 : 8))
      .sort((a, b) => b.spend_usd - a.spend_usd)
      .map(a => ({ name: a.name, ad_id: a.ad_id, campaign: a.campaign, spend_usd: a.spend_usd, seuil: a.is_test ? 6 : 8 }));
    const test_abo = ads.filter(a => a.is_test && a.spend_usd > 0).sort((a, b) => b.spend_usd - a.spend_usd);

    return res.status(200).json({
      updated_at: new Date().toISOString(), rate, period: periodLabel,
      account: {
        spend_today_usd: +spendToday.toFixed(2), spend_today_mad: +(spendToday * rate).toFixed(0),
        spend_7d_usd: +tSpend.toFixed(0), spend_7d_avg_day_usd: +(tSpend / 7).toFixed(1),
        roas_7d: tSpend ? +(tVal / tSpend).toFixed(1) : 0, cpa_usd: tPur ? +(tSpend / tPur).toFixed(2) : 0,
        purchases_7d: tPur, revenue_7d_usd: +tVal.toFixed(0), revenue_7d_mad: +(tVal * rate).toFixed(0),
        daily_budget_usd: +dailyBudget.toFixed(0), daily_budget_mad: +(dailyBudget * rate).toFixed(0),
        campaigns_active: active.length,
      },
      campaigns, top_creatives, test_abo, alerts,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ════════ Action « Expédier depuis le stock interne » (POST ?action=ship&id=...) ════════
// Décrémente la quantité du stock interne de la quantité commandée, puis archive la notif.
// Ex : dispo 2, commande 1 → reste 1. Si ça tombe à 0 → rupture (qty 0).
async function shipFromStock(req, res) {
  const notifId = req.query?.id || (req.body && req.body.id);
  if (!notifId) return res.status(400).json({ error: 'id (notification) requis' });
  const sb = (path, opts = {}) => fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...supabaseHeaders(true), ...(opts.headers || {}) } });
  try {
    const nRes = await sb(`shopify_notifications?id=eq.${encodeURIComponent(notifId)}&select=*`);
    if (!nRes.ok) return res.status(500).json({ error: 'lecture notif échouée', detail: await nRes.text() });
    const notif = (await nRes.json())[0];
    if (!notif) return res.status(404).json({ error: 'notification introuvable' });

    const stockIds = Array.isArray(notif.matched_stock_ids) ? notif.matched_stock_ids : [];
    // Décrémenter par la quantité COMMANDÉE (pas le stock dispo). Ex : stock 2, commande 1 → reste 1.
    let toShip = Number(notif.ordered_qty) || 1;
    if (!stockIds.length) {
      await sb(`shopify_notifications?id=eq.${encodeURIComponent(notifId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'archived' }) });
      return res.status(200).json({ ok: true, warning: 'aucun stock lié', shipped: 0 });
    }

    const updates = [];
    for (const sid of stockIds) {
      if (toShip <= 0) break;
      const sRes = await sb(`stock?id=eq.${encodeURIComponent(sid)}&select=id,product,size,qty,status`);
      if (!sRes.ok) continue;
      const sItem = (await sRes.json())[0];
      if (!sItem) continue;
      const have = Number(sItem.qty) || 0;
      if (have <= 0) continue;
      const take = Math.min(have, toShip);
      const newQty = have - take;
      await sb(`stock?id=eq.${encodeURIComponent(sid)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ qty: newQty }) });
      updates.push({ id: sid, product: sItem.product, size: sItem.size, before: have, shipped: take, after: newQty, rupture: newQty === 0 });
      toShip -= take;
    }

    await sb(`shopify_notifications?id=eq.${encodeURIComponent(notifId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'archived' }) });
    const totalShipped = updates.reduce((s, u) => s + u.shipped, 0);
    return res.status(200).json({ ok: true, notif_id: notifId, product: notif.product_title, customer: notif.customer_name, shipped: totalShipped, remaining_unfulfilled: Math.max(0, toShip), updates });
  } catch (e) {
    console.error('[ship-from-stock] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ════════ Action « Synchroniser » — re-scan commandes ↔ stock interne (POST ?action=scan&days=7) ════════
// Rattrape les commandes dont un produit est dispo au stock (retour OU acheté) au cas où le webhook aurait raté.
async function scanOrdersStock(req, res) {
  try {
    const days = Math.min(30, Math.max(1, Number(req.query?.days) || 7));
    // Date de départ sans Date.now() interdit ? non — ceci tourne en runtime Vercel, Date est OK côté serveur
    const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

    const orders = [];
    let url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&created_at_min=${encodeURIComponent(sinceIso)}&limit=250&fields=id,name,order_number,customer,shipping_address,line_items,total_price,created_at,cancelled_at,fulfillment_status`;
    const hdrs = await shopifyAdminHeaders();
    let pages = 0;
    while (url && pages < 6) {
      const r = await fetch(url, { headers: hdrs });
      if (!r.ok) break;
      const d = await r.json();
      orders.push(...(d.orders || []));
      const link = r.headers.get('link') || '';
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
      pages++;
    }

    // Charger TOUT le stock interne dispo UNE fois (retour + acheté, qty>0) → matching en mémoire (pas de fetch par ligne)
    const stockRows = [];
    for (let off = 0; ; off += 1000) {
      const r = await fetch(`${SB_URL}/rest/v1/stock?select=id,product,size,qty,status&qty=gt.0&status=in.(retour,stock)&limit=1000&offset=${off}`, { headers: supabaseHeaders(true) });
      if (!r.ok) break;
      const rows = await r.json();
      stockRows.push(...rows);
      if (rows.length < 1000) break;
    }
    const stockByTitle = new Map();
    for (const s of stockRows) { if (!s.product) continue; if (!stockByTitle.has(s.product)) stockByTitle.set(s.product, []); stockByTitle.get(s.product).push(s); }
    const stockTitles = [...stockByTitle.keys()];

    const matchStock = (productTitle, size, color) => {
      const normSize = normalizeSize(size), normColor = normalizeColor(color);
      const bySizeColor = rows => rows.filter(c => {
        const parts = String(c.size || '').split('|');
        const cSize = (parts[0] || '').trim(), cColor = (parts[1] || '').trim();
        if (normalizeSize(cSize) !== normSize) return false;
        if (normColor && normalizeColor(cColor) !== normColor) return false;
        return true;
      });
      // 1) titre exact
      let cand = stockByTitle.get(productTitle) || [];
      let m = bySizeColor(cand);
      if (m.length) return m;
      // 2) flou (jaccard) sur les titres chargés
      let best = null, bestScore = 0;
      for (const t of stockTitles) { const sc = jaccardSim(productTitle, t); if (sc > bestScore) { bestScore = sc; best = t; } }
      if (best && bestScore >= SCAN_FUZZY_THRESHOLD) return bySizeColor(stockByTitle.get(best) || []);
      return [];
    };

    const notifications = [];
    let scannedItems = 0;
    for (const order of orders) {
      if (order.cancelled_at) continue;
      if (order.fulfillment_status === 'fulfilled') continue;
      const orderName = order.name || `#${order.id}`;
      const cust = order.customer || order.shipping_address || {};
      const customerName = [cust.first_name, cust.last_name].filter(Boolean).join(' ') || order.shipping_address?.name || 'Client';
      const customerCity = order.shipping_address?.city || cust.city || '';
      const totalAmount = parseFloat(order.total_price || 0);
      for (const item of (order.line_items || [])) {
        const productTitle = item.title || (item.name || '').split(' - ')[0] || '';
        if (!productTitle) continue;
        scannedItems++;
        const { size, color } = parseVariantTitle(item.variant_title || '');
        const matches = matchStock(productTitle, size, color);
        if (!matches.length) continue;
        notifications.push({
          shopify_order_id: order.id,
          shopify_order_number: orderName,
          customer_name: customerName,
          customer_city: customerCity,
          product_title: productTitle,
          variant_size: size,
          variant_color: color,
          shopify_variant_id: item.variant_id ? String(item.variant_id) : null,
          matched_stock_ids: matches.map(m => m.id),
          matched_qty: matches.reduce((s, m) => s + (m.qty || 0), 0),
          ordered_qty: Number(item.quantity) || 1,
          total_amount_mad: totalAmount,
        });
      }
    }

    let created = 0;
    if (notifications.length) {
      const insRes = await fetch(`${SB_URL}/rest/v1/shopify_notifications?on_conflict=shopify_order_id,shopify_variant_id`, {
        method: 'POST',
        headers: { ...supabaseHeaders(true), Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify(notifications),
      });
      if (insRes.ok) { const ins = await insRes.json(); created = Array.isArray(ins) ? ins.length : 0; }
    }

    return res.status(200).json({ ok: true, orders_scanned: orders.length, items_scanned: scannedItems, matches: notifications.length, new_notifications: created });
  } catch (e) {
    console.error('[scan-orders-stock] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ════════ Découverte des pipelines eGrow (GET ?egrow_stages=1) — tourne en prod où le token existe ════════
async function egrowStages(req, res) {
  const ME = process.env.EGROW_ME || '', AK = process.env.EGROW_AK || '';
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  if (!ME || !AK) return res.status(500).json({ error: 'EGROW_ME/EGROW_AK absents en env' });
  const post = async (path, params) => {
    const p = Object.assign({}, params, { me: ME, dev: 0 });
    const b = '----TouniAgent' + Math.random().toString(36).slice(2);
    const raw = `--${b}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${JSON.stringify(p)}\r\n--${b}--\r\n`;
    const r = await fetch('https://api.egrow.com' + path, { method: 'POST', headers: { 'account-key': AK, 'User-Agent': UA, 'content-type': `multipart/form-data; boundary=${b}` }, body: raw });
    const t = await r.text(); try { return JSON.parse(t); } catch (e) { return { __raw: t.slice(0, 200) }; }
  };
  try {
    // 1) essai endpoint dédié (liste stages + counts)
    let pls = await post('/deal/getuserPipeLineStages.php', {});
    // 2) sinon, agréger depuis un lot de deals
    let stages = [];
    const norm = (arr) => arr.map(x => ({ id: x.id, name: String(x.name || x.stage_name || x.title || '').trim(), count: x.count ?? x.deals_count })).filter(s => s.id);
    if (Array.isArray(pls) || (pls && Array.isArray(pls.data))) {
      stages = norm(Array.isArray(pls) ? pls : pls.data);
    } else {
      const r = await post('/deal/getStageDeals.php', { page: 1, limit: 1500 });
      const a = Array.isArray(r) ? r : (r && r.data) || [];
      const m = new Map();
      a.forEach(d => { const s = d.stage || {}; if (s.id) { const e = m.get(s.id) || { id: s.id, name: String(s.name || '').trim(), count: 0 }; e.count++; m.set(s.id, e); } });
      stages = [...m.values()];
      if (!a.length) return res.status(200).json({ source: 'deals', note: 'aucun deal / accès', raw: r });
    }
    stages.sort((x, y) => (y.count || 0) - (x.count || 0));
    return res.status(200).json({ source: Array.isArray(pls) || pls?.data ? 'pipeline_endpoint' : 'deals_aggregate', count: stages.length, stages });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Inscription newsletter (PUBLIC — appelé par le footer du site, avant le guard secret)
  if (req.query?.newsletter) return newsletterSignup(req, res);

  // FIX: Auth guard — protect all methods (not just mutation) to avoid exposing order data
  const expectedSecret = process.env.SYNC_SECRET || 'touni-sync-2026';
  const providedSecret = req.query?.secret || req.headers['x-sync-secret'];
  if (providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Vue Directeur Meta Ads (live)
  if (req.method === 'GET' && req.query?.meta) return metaMetrics(req, res);

  // Découverte pipelines eGrow (temporaire, pour récupérer les IDs de stages)
  if (req.query?.egrow_stages) return egrowStages(req, res);

  // Actions « Commandes en stock » (page dédiée)
  if (req.method === 'POST' && req.query?.action === 'ship') return shipFromStock(req, res);
  if (req.method === 'POST' && req.query?.action === 'scan') return scanOrdersStock(req, res);

  try {
    if (req.method === 'GET') {
      const status = req.query?.status || 'unread';
      const limit = parseInt(req.query?.limit || '50');
      const url = `${SB_URL}/rest/v1/shopify_notifications?select=*&status=eq.${status}&order=created_at.desc&limit=${limit}`;
      const r = await fetch(url, { headers: supabaseHeaders(true) });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      return res.status(200).json({ notifications: data, count: data.length });
    }

    if (req.method === 'PATCH') {
      const id = req.query?.id;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const newStatus = req.query?.status || 'read';
      if (!['unread', 'read', 'archived'].includes(newStatus)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      const updateBody = { status: newStatus };
      if (newStatus === 'read') updateBody.read_at = new Date().toISOString();
      const r = await fetch(`${SB_URL}/rest/v1/shopify_notifications?id=eq.${id}`, {
        method: 'PATCH',
        headers: supabaseHeaders(true),
        body: JSON.stringify(updateBody),
      });
      if (!r.ok) throw new Error(await r.text());
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const r = await fetch(`${SB_URL}/rest/v1/shopify_notifications?id=eq.${id}`, {
        method: 'DELETE',
        headers: supabaseHeaders(true),
      });
      if (!r.ok) throw new Error(await r.text());
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
