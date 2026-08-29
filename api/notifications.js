// API simple pour les notifications Shopify (consultées par le dashboard admin)
// GET /api/notifications?secret=...&status=unread → liste
// GET /api/notifications?secret=...&meta=1&rate=10 → métriques Meta Ads en direct (Vue Directeur)
// PATCH /api/notifications?secret=...&id=XXX → marquer comme lu/archivé
// DELETE /api/notifications?secret=...&id=XXX → supprimer

const { SB_URL, supabaseHeaders, shopifyAdminHeaders, SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, normalizeSize, normalizeColor, fetchShopifyProductsAdmin } = require('./_shopify-helpers.js');
// Réutilise le parsing du webhook (fonction exportée) — pour rester sous la limite de 12 fonctions Vercel
const { parseVariantTitle } = require('./shopify-order-webhook.js');

// ── eGrow (pipelines) ──
const EGROW_ME = process.env.EGROW_ME || '', EGROW_AK = process.env.EGROW_AK || '';
const EGROW_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
async function egrowPost(path, params) {
  const p = Object.assign({}, params, { me: EGROW_ME, dev: 0 });
  const b = '----TouniAgent' + Math.random().toString(36).slice(2);
  const raw = `--${b}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${JSON.stringify(p)}\r\n--${b}--\r\n`;
  const r = await fetch('https://api.egrow.com' + path, { method: 'POST', headers: { 'account-key': EGROW_AK, 'User-Agent': EGROW_UA, 'content-type': `multipart/form-data; boundary=${b}` }, body: raw });
  const t = await r.text(); try { return JSON.parse(t); } catch (e) { return { __raw: t.slice(0, 200) }; }
}
// Le deal est-il DANS ce stage ? (via getStageDeals qui fonctionne de façon fiable — getDealDetails renvoie null).
async function egrowDealInStage(dealId, stageId) {
  try {
    const r = await egrowPost('/deal/getStageDeals.php', { stage: stageId, page: 1, limit: 1500 });
    const a = Array.isArray(r) ? r : (r && r.data) || [];
    return a.some(d => String(d.id) === String(dealId));
  } catch (e) { return null; } // null = on n'a pas pu vérifier
}
// Déplace un deal vers targetStage de façon FIABLE : déplace, VÉRIFIE la présence dans le stage cible, réessaie 1×.
async function moveDealReliable(dealId, targetStage, oldStage, order) {
  if (!dealId || !EGROW_ME || !EGROW_AK) return { ok: false, reason: 'egrow_non_configure' };
  // Le deal a-t-il AVANCÉ ? = présent dans la cible (Traiter) OU parti de l'ancien stage.
  // ⚠️ L'automatisation eGrow → Ozone sort le deal de « Traiter » AUSSITÔT (vers Success/Failed
  // Ozone). Vérifier seulement « est-il encore dans Traiter ? » donnait un FAUX échec. On accepte
  // donc aussi « a quitté la source » comme preuve de déplacement réussi. Idempotent (retry safe).
  async function advanced() {
    if (await egrowDealInStage(dealId, targetStage) === true) return true;           // dans Traiter
    if (oldStage && await egrowDealInStage(dealId, oldStage) === false) return true;  // parti de la source → avancé (Ozone)
    return false;
  }
  if (await advanced()) return { ok: true, already: true, to: targetStage };
  for (let a = 0; a < 2; a++) {
    await egrowPost('/deal/updateDealOrderinNewStage.php', { new_order: 1, old_order: order || 1, stage_id: targetStage, deal_id: dealId, old_stage: oldStage, update_stage_source: 'touni-retour ship' });
    if (await advanced()) return { ok: true, to: targetStage, attempts: a + 1 };
  }
  return { ok: false, to: targetStage };
}
// Les 6 pipelines eGrow que Tahar veut filtrer (id → libellé). Ordre d'affichage = ordre des clés.
const PIPELINES = [
  { id: 49396, name: 'Confirmer Maillots', confirmed: true },
  { id: 63093, name: 'Confirmer Autre', confirmed: true },
  { id: 64833, name: 'Flocage PRO Confirmer', confirmed: true },
  { id: 64835, name: 'Commande Incomplète', confirmed: false },
  { id: 60669, name: 'rappeler le stock', confirmed: false },
  { id: 49430, name: 'Rupture', confirmed: false },
];
// Taille commandée d'un produit eGrow = la combinaison sélectionnée (`combination`) → son name.
function egrowSize(p) {
  const combos = Array.isArray(p.combinations) ? p.combinations : [];
  const sel = combos.find(c => String(c.id) === String(p.combination));
  if (sel && sel.name) return String(sel.name).trim();
  // repli : parser depuis le nom / short_name
  const { size } = parseVariantTitle(p.short_name || '');
  return size;
}

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
  const sb = (path, opts = {}) => fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...supabaseHeaders(true), ...(opts.headers || {}) } });

  // Mode PIPELINE (pas de notification) : décrémente directement des articles de stock donnés.
  const directIds = String(req.query?.stock_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!notifId && directIds.length) {
    let toShip = Math.max(1, parseInt(req.query?.qty || '1', 10));
    const updates = [];
    try {
      for (const sid of directIds) {
        if (toShip <= 0) break;
        const sRes = await sb(`stock?id=eq.${encodeURIComponent(sid)}&select=id,product,size,qty,status`);
        if (!sRes.ok) continue;
        const sItem = (await sRes.json())[0]; if (!sItem) continue;
        const have = Number(sItem.qty) || 0; if (have <= 0) continue;
        const take = Math.min(have, toShip); const newQty = have - take;
        await sb(`stock?id=eq.${encodeURIComponent(sid)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ qty: newQty }) });
        updates.push({ id: sid, product: sItem.product, size: sItem.size, before: have, shipped: take, after: newQty, rupture: newQty === 0 });
        toShip -= take;
      }
      return res.status(200).json({ ok: true, mode: 'pipeline', shipped: updates.reduce((s, u) => s + u.shipped, 0), remaining_unfulfilled: Math.max(0, toShip), updates });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (!notifId) return res.status(400).json({ error: 'id (notification) ou stock_ids requis' });
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
    try {
      await sb(`ship_history`, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{
        source: 'stock', deal_number: notif.shopify_order_number || null, client: notif.customer_name || null, city: notif.customer_city || null,
        products: [{ product: notif.product_title, size: [notif.variant_size, notif.variant_color].filter(Boolean).join(' / '), qty: notif.ordered_qty || 1, available: true }],
        shipped_qty: totalShipped, stock_decremented: totalShipped > 0, moved_to_traite: false,
      }]) });
    } catch (e) {}
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

// Charge tout le stock interne dispo (retour+acheté, qty>0) UNE fois → matcher en mémoire (titre+taille).
async function loadStockMatcher() {
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/stock?select=id,product,size,qty,status&qty=gt.0&status=in.(retour,stock)&limit=1000&offset=${off}`, { headers: supabaseHeaders(true) });
    if (!r.ok) break; const a = await r.json(); rows.push(...a); if (a.length < 1000) break;
  }
  const byTitle = new Map();
  for (const s of rows) { if (!s.product) continue; if (!byTitle.has(s.product)) byTitle.set(s.product, []); byTitle.get(s.product).push(s); }
  const titles = [...byTitle.keys()];
  const jac = (a, b) => { const tk = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean)); const sa = tk(a), sb = tk(b); if (!sa.size || !sb.size) return 0; let i = 0; for (const t of sa) if (sb.has(t)) i++; return i / (sa.size + sb.size - i); };
  const match = (title, size, color) => {
    const nS = normalizeSize(size), nC = normalizeColor(color);
    const bySC = arr => arr.filter(c => { const pr = String(c.size || '').split('|'); const cS = (pr[0] || '').trim(), cC = (pr[1] || '').trim(); if (normalizeSize(cS) !== nS) return false; if (nC && normalizeColor(cC) !== nC) return false; return true; });
    let m = bySC(byTitle.get(title) || []); if (m.length) return m;
    let best = null, bs = 0; for (const t of titles) { const sc = jac(title, t); if (sc > bs) { bs = sc; best = t; } }
    if (best && bs >= 0.55) return bySC(byTitle.get(best) || []);
    return [];
  };
  return { match };
}

// ════════ Filtre par PIPELINE eGrow (GET ?pipeline=<stageId>) → commandes du pipeline + dispo stock interne ════════
async function pipelineScan(req, res) {
  if (!EGROW_ME || !EGROW_AK) return res.status(500).json({ error: 'eGrow non configuré (EGROW_ME/AK)' });
  // Un OU plusieurs stages (séparés par virgule) pour les filtres groupés « Confirmer », « Rappel »…
  const ALLOWED_STAGES = new Set([49396, 63093, 64833, 64835, 60669, 49430, 51500, 60599, 55207, 49397, 65365]);
  const stages = String(req.query.pipeline || '').split(',').map(s => parseInt(s.trim(), 10)).filter(id => ALLOWED_STAGES.has(id));
  if (!stages.length) return res.status(400).json({ error: 'pipeline inconnu' });
  try {
    // Fusionne les deals de tous les stages du groupe (dédupliqués par id).
    let raw = [];
    for (const sid of stages) {
      const rr = await egrowPost('/deal/getStageDeals.php', { stage: sid, page: 1, limit: 1500 });
      const arr = Array.isArray(rr) ? rr : (rr && rr.data) || [];
      arr.forEach(d => { d._srcStage = sid; raw.push(d); });
    }
    const _seen = new Set();
    const deals = raw.filter(d => { const k = String(d.id); if (_seen.has(k)) return false; _seen.add(k); return true; });
    const { match } = await loadStockMatcher();
    // Une carte par COMMANDE (deal), avec TOUS ses produits (maillot seul / maillot + flocage / plusieurs maillots…)
    const out = deals.map(d => {
      const c = d.contact || {};
      const products = (d.products || []).map(p => {
        const title = String(p.name || '').trim();
        const size = egrowSize(p);
        const matches = title ? match(title, size, null) : [];
        const availQty = matches.reduce((s, m) => s + (m.qty || 0), 0);
        return { product: title || '—', size: size || '—', qty: p.quantity || 1, image: p.image || '', available: availQty > 0, avail_qty: availQty, matched_stock_ids: matches.map(m => m.id) };
      });
      const availN = products.filter(x => x.available).length;
      return {
        deal_id: d.id, order: d.order || 1, stage_id: (d.stage && d.stage.id) || d._srcStage,
        deal_number: d.deal_number || String(d.id), client: c.name || 'Client', city: d.deal_city || c.city || '', phone: String(c.phone || ''),
        date: d.time ? d.time * 1000 : null,                       // date de la commande (ms)
        note: (d.last_note && d.last_note.content) ? String(d.last_note.content) : '',  // note eGrow
        product_count: products.length, avail_count: availN,
        all_available: products.length > 0 && availN === products.length, any_available: availN > 0, products,
      };
    });
    // Complètes d'abord, puis partielles, puis rien
    out.sort((a, b) => (b.all_available - a.all_available) || (b.any_available - a.any_available));
    return res.status(200).json({ pipeline: req.query.pipeline, id: req.query.pipeline, deals_count: out.length, full_available: out.filter(d => d.all_available).length, deals: out });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ════════ Expédier une COMMANDE entière (POST ?action=ship_deal) : décrémente le stock des articles trouvés + passe le deal à « Traiter » (49150) ════════
async function shipDeal(req, res) {
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const dealId = body.deal_id || req.query?.deal_id;
  const items = Array.isArray(body.items) ? body.items : [];
  const moveStage = parseInt(body.move_stage || req.query?.move_stage || '49150', 10); // Traiter
  const oldStage = body.old_stage;
  const order = body.order || 1;
  const sb = (path, opts = {}) => fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...supabaseHeaders(true), ...(opts.headers || {}) } });
  const updates = [];
  try {
    // 1) DÉPLACER vers « Traiter » D'ABORD, de façon vérifiée (fiabilise : plus de passage manquant).
    const moved = await moveDealReliable(dealId, moveStage, oldStage, order);

    // 2) Décrémenter le stock UNIQUEMENT si le déplacement a réussi → un nouveau clic (retry) ne double-décompte pas.
    if (moved.ok) {
      for (const it of items) {
        let toShip = Math.max(0, parseInt(it.qty || 1, 10));
        for (const sid of (it.stock_ids || [])) {
          if (toShip <= 0) break;
          const sRes = await sb(`stock?id=eq.${encodeURIComponent(sid)}&select=id,product,size,qty`);
          if (!sRes.ok) continue; const sItem = (await sRes.json())[0]; if (!sItem) continue;
          const have = Number(sItem.qty) || 0; if (have <= 0) continue;
          const take = Math.min(have, toShip); const nq = have - take;
          await sb(`stock?id=eq.${encodeURIComponent(sid)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ qty: nq }) });
          updates.push({ id: sid, product: sItem.product, size: sItem.size, before: have, shipped: take, after: nq, rupture: nq === 0 });
          toShip -= take;
        }
      }
    }

    // 3) Historique : enregistré UNIQUEMENT quand le déplacement a réussi (sinon la commande n'est pas "sortie").
    const snap = body.snapshot || {};
    if (moved.ok) {
      try {
        await fetch(`${SB_URL}/rest/v1/ship_history`, { method: 'POST', headers: { ...supabaseHeaders(true), Prefer: 'return=minimal' }, body: JSON.stringify([{
          source: 'pipeline', pipeline: snap.pipeline || null, deal_id: dealId ? String(dealId) : null, deal_number: snap.deal_number || null,
          client: snap.client || null, city: snap.city || null, phone: snap.phone || null, products: snap.products || null,
          shipped_qty: updates.reduce((s, u) => s + u.shipped, 0), stock_decremented: updates.length > 0, moved_to_traite: true,
        }]) });
      } catch (e) {}
    }
    return res.status(200).json({ ok: true, moved, shipped: updates.reduce((s, u) => s + u.shipped, 0), updates });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

// ════════ Produits les plus vendus (GET ?bestsellers=1&from=&to=) — agrège les commandes Shopify de la période ════════
async function bestSellers(req, res) {
  try {
    const from = req.query?.from, to = req.query?.to;
    let url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&limit=250&fields=id,line_items,created_at,cancelled_at,financial_status`;
    if (from) url += `&created_at_min=${encodeURIComponent(from)}`;
    if (to) url += `&created_at_max=${encodeURIComponent(to)}`;
    const hdrs = await shopifyAdminHeaders();
    const agg = new Map();
    let pages = 0, ordersScanned = 0, truncated = false;
    while (url && pages < 14) {
      const r = await fetch(url, { headers: hdrs });
      if (!r.ok) break;
      const d = await r.json();
      for (const o of (d.orders || [])) {
        if (o.cancelled_at) continue;
        ordersScanned++;
        for (const li of (o.line_items || [])) {
          const title = li.title || '—';
          const key = li.product_id ? 'p' + li.product_id : 't' + title;
          const e = agg.get(key) || { product_id: li.product_id || null, title, units: 0, revenue: 0, orders: new Set() };
          e.units += (li.quantity || 0);
          e.revenue += (parseFloat(li.price || 0) * (li.quantity || 0));
          e.orders.add(o.id);
          agg.set(key, e);
        }
      }
      const link = r.headers.get('link') || '';
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
      pages++;
      if (pages >= 14 && url) truncated = true;
    }
    const products = [...agg.values()]
      .map(e => ({ product_id: e.product_id, title: e.title, units: e.units, revenue: Math.round(e.revenue), orders: e.orders.size }))
      .sort((a, b) => b.units - a.units);
    const totalUnits = products.reduce((s, p) => s + p.units, 0);
    const totalRevenue = products.reduce((s, p) => s + p.revenue, 0);
    return res.status(200).json({ orders_scanned: ordersScanned, total_units: totalUnits, total_revenue: totalRevenue, truncated, products: products.slice(0, 300) });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

// ════════ Produits les plus LIVRÉS (GET ?delivered=1&from=&to=) — agrège les deals eGrow des stages livrés ════════
const DELIVERED_STAGES = [49152, 49214, 49209, 49210]; // Livrer, Reçu, Payé, Facturé
async function deliveredSellers(req, res) {
  if (!EGROW_ME || !EGROW_AK) return res.status(500).json({ error: 'eGrow non configuré' });
  try {
    const fromSec = req.query?.from ? Math.floor(new Date(req.query.from).getTime() / 1000) : 0;
    const toSec = req.query?.to ? Math.floor(new Date(req.query.to).getTime() / 1000) : Math.floor(Date.now() / 1000) + 86400;
    const agg = new Map();
    let dealsInRange = 0, truncated = false;
    for (const stage of DELIVERED_STAGES) {
      const r = await egrowPost('/deal/getStageDeals.php', { stage, page: 1, limit: 1500 });
      const deals = Array.isArray(r) ? r : (r && r.data) || [];
      if (deals.length >= 1500) truncated = true;
      for (const d of deals) {
        const t = parseInt(d.time || 0, 10);
        if (t && (t < fromSec || t > toSec)) continue;
        dealsInRange++;
        for (const p of (d.products || [])) {
          const title = String(p.name || '').trim(); if (!title) continue;
          const key = 't' + title;
          const e = agg.get(key) || { title, units: 0, revenue: 0, orders: 0 };
          const q = Number(p.quantity) || 1;
          e.units += q;
          e.revenue += (parseFloat(p.price || 0) * q);
          e.orders += 1;
          agg.set(key, e);
        }
      }
    }
    const products = [...agg.values()].map(e => ({ title: e.title, units: e.units, revenue: Math.round(e.revenue), orders: e.orders })).sort((a, b) => b.units - a.units);
    return res.status(200).json({ mode: 'delivered', orders_scanned: dealsInRange, total_units: products.reduce((s, p) => s + p.units, 0), total_revenue: products.reduce((s, p) => s + p.revenue, 0), truncated, products: products.slice(0, 300) });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

// ════════ Historique des commandes expédiées (GET ?history=1&from=&to=&limit=) ════════
async function historyList(req, res) {
  try {
    const limit = Math.min(2000, parseInt(req.query?.limit || '500', 10));
    let url = `${SB_URL}/rest/v1/ship_history?select=*&order=shipped_at.desc&limit=${limit}`;
    if (req.query?.from) url += `&shipped_at=gte.${encodeURIComponent(req.query.from)}`;
    if (req.query?.to) url += `&shipped_at=lte.${encodeURIComponent(req.query.to)}`;
    const r = await fetch(url, { headers: supabaseHeaders(true) });
    const rows = r.ok ? await r.json() : [];
    return res.status(200).json({ history: rows, count: rows.length });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

// ════════ État « Préparé » PARTAGÉ (table stock_prepared) — synchronisé entre tous les PC ════════
async function preparedList(req, res) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/stock_prepared?select=pkey&limit=5000`, { headers: supabaseHeaders(true) });
    const rows = r.ok ? await r.json() : [];
    return res.status(200).json({ keys: rows.map(x => x.pkey) });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
async function prepToggle(req, res) {
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const key = (body && body.key) || req.query?.key;
  const on = String((body && body.on) ?? req.query?.on ?? '1') === '1' || (body && body.on) === true;
  if (!key) return res.status(400).json({ error: 'key requise' });
  try {
    if (on) {
      const r = await fetch(`${SB_URL}/rest/v1/stock_prepared?on_conflict=pkey`, { method: 'POST', headers: { ...supabaseHeaders(true), Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify([{ pkey: key }]) });
      if (!r.ok) throw new Error(await r.text());
    } else {
      const r = await fetch(`${SB_URL}/rest/v1/stock_prepared?pkey=eq.${encodeURIComponent(key)}`, { method: 'DELETE', headers: supabaseHeaders(true) });
      if (!r.ok) throw new Error(await r.text());
    }
    return res.status(200).json({ ok: true, key, on });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

// ════════ Découverte des pipelines eGrow (GET ?egrow_stages=1) — tourne en prod où le token existe ════════
async function egrowStages(req, res) {
  const ME = process.env.EGROW_ME || '', AK = process.env.EGROW_AK || '';
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  if (!ME || !AK) return res.status(500).json({ error: 'EGROW_ME/EGROW_AK absents en env' });
  // Sonde : vérifier que getDealDetails renvoie bien le stage (pour la fiabilité du déplacement)
  if (req.query?.probe_deal) {
    const src = parseInt(req.query.src_stage || '63093', 10);
    const inSrc = await egrowDealInStage(req.query.probe_deal, src);
    const inTraiter = await egrowDealInStage(req.query.probe_deal, 49150);
    return res.status(200).json({ probe_deal: req.query.probe_deal, in_source_stage: inSrc, in_traiter: inTraiter });
  }
  const post = async (path, params) => {
    const p = Object.assign({}, params, { me: ME, dev: 0 });
    const b = '----TouniAgent' + Math.random().toString(36).slice(2);
    const raw = `--${b}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${JSON.stringify(p)}\r\n--${b}--\r\n`;
    const r = await fetch('https://api.egrow.com' + path, { method: 'POST', headers: { 'account-key': AK, 'User-Agent': UA, 'content-type': `multipart/form-data; boundary=${b}` }, body: raw });
    const t = await r.text(); try { return JSON.parse(t); } catch (e) { return { __raw: t.slice(0, 200) }; }
  };
  try {
    // Mode échantillon : dump quelques deals d'un stage pour voir la structure produit (taille, etc.)
    if (req.query?.sample) {
      const sid = parseInt(req.query.sample, 10);
      const r = await post('/deal/getStageDeals.php', { stage: sid, page: 1, limit: 3 });
      const a = Array.isArray(r) ? r : (r && r.data) || [];
      const first = a[0] || {};
      return res.status(200).json({ stage: sid, n: a.length, deal_keys: Object.keys(first), raw_first: first });
    }
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

// ════════ Produits en RUPTURE de stock (GET ?rupture=1) — live Shopify ════════
// Renvoie 2 listes : produits totalement en rupture (toutes tailles suivies à 0)
// et produits partiellement en rupture (certaines tailles à 0). Données live à
// chaque appel → toujours synchronisé avec Shopify (ajout produit / stock à 0).
async function ruptureStock(req, res) {
  try {
    const products = await fetchShopifyProductsAdmin();
    const slug = String(SHOPIFY_DOMAIN || '').replace('.myshopify.com', '');
    const sizeOf = (v) => { const t = String(v.title || '').trim(); return (!t || t === 'Default Title') ? '—' : t; };
    const fully = [], partial = [];
    let scanned = 0, trackedProducts = 0;
    for (const p of products) {
      if (p.status !== 'active') continue;            // seulement les produits en ligne
      scanned++;
      const variants = p.variants || [];
      // On ne considère QUE les variantes dont le stock est suivi par Shopify.
      // (Mystère/Flocage/Packs = non suivis = toujours dispo → ignorés.)
      const tracked = variants.filter(v => v.inventory_management === 'shopify');
      if (!tracked.length) continue;
      trackedProducts++;
      const out = tracked.filter(v => Number(v.inventory_quantity || 0) <= 0);
      if (!out.length) continue;                      // tout en stock → rien à signaler
      const img = (p.images && p.images[0] && p.images[0].src) || '';
      const base = {
        id: p.id, title: p.title, image: img,
        admin_url: slug ? `https://admin.shopify.com/store/${slug}/products/${p.id}` : '',
        total: tracked.length, out: out.length,
      };
      if (out.length === tracked.length) {
        fully.push(base);                             // toutes les tailles à 0
      } else {
        base.out_sizes = out.map(sizeOf);
        base.in_sizes = tracked
          .filter(v => Number(v.inventory_quantity || 0) > 0)
          .map(v => ({ size: sizeOf(v), qty: Number(v.inventory_quantity || 0) }));
        partial.push(base);
      }
    }
    fully.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    partial.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    return res.status(200).json({
      generated_at: new Date().toISOString(),
      scanned, tracked_products: trackedProducts,
      fully_count: fully.length, partial_count: partial.length,
      fully, partial,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ════════ INVENTAIRE PHYSIQUE — réconciliation stock ↔ dépôt ════════
// Compteur par ligne (produit+taille) : counted_qty s'incrémente à chaque unité physique trouvée.
async function invList(req, res) {
  try {
    const all = [];
    for (let off = 0; ; off += 1000) {
      const r = await fetch(`${SB_URL}/rest/v1/stock?select=id,product,size,qty,counted_qty,counted_at,image,status&status=in.(retour,stock)&order=product.asc,size.asc&limit=1000&offset=${off}`, { headers: supabaseHeaders(true) });
      if (!r.ok) throw new Error(await r.text());
      const rows = await r.json();
      all.push(...rows);
      if (rows.length < 1000) break;
    }
    const counted = all.filter((s) => s.counted_at).length;
    const countedUnits = all.reduce((a, s) => a + (s.counted_qty || 0), 0);
    const recordedUnits = all.reduce((a, s) => a + (s.qty || 0), 0);
    const phantoms = all.filter((s) => (s.qty || 0) > 0 && !s.counted_at).length;
    const ecarts = all.filter((s) => s.counted_at && (s.counted_qty || 0) !== (s.qty || 0)).length;
    const products = [...new Set(all.map((s) => s.product).filter(Boolean))].sort();
    return res.status(200).json({ rows: all, products, summary: { lines: all.length, counted, countedUnits, recordedUnits, phantoms, ecarts } });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function invCount(req, res) {
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const id = (body && body.id) || req.query?.id;
  const delta = parseInt((body && body.delta) ?? req.query?.delta ?? '1', 10);
  if (!id) return res.status(400).json({ error: 'id requis' });
  try {
    const g = await fetch(`${SB_URL}/rest/v1/stock?id=eq.${encodeURIComponent(id)}&select=counted_qty`, { headers: supabaseHeaders(true) });
    const rows = await g.json();
    if (!rows.length) return res.status(404).json({ error: 'ligne introuvable' });
    const next = Math.max(0, (rows[0].counted_qty || 0) + delta);
    const r = await fetch(`${SB_URL}/rest/v1/stock?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { ...supabaseHeaders(true), Prefer: 'return=minimal' }, body: JSON.stringify({ counted_qty: next, counted_at: new Date().toISOString() }) });
    if (!r.ok) throw new Error(await r.text());
    return res.status(200).json({ ok: true, id, counted_qty: next });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function invAdd(req, res) {
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const product = String((body && body.product) || '').trim();
  const size = String((body && body.size) || '').trim();
  const qty = Math.max(1, parseInt((body && body.qty) ?? 1, 10));
  const image = (body && body.image) || null;
  if (!product) return res.status(400).json({ error: 'produit requis' });
  try {
    const row = { product, size: size || null, qty, counted_qty: qty, counted_at: new Date().toISOString(), status: 'stock', notes: 'ajout inventaire', image };
    const r = await fetch(`${SB_URL}/rest/v1/stock`, { method: 'POST', headers: { ...supabaseHeaders(true), Prefer: 'return=representation' }, body: JSON.stringify([row]) });
    if (!r.ok) throw new Error(await r.text());
    const created = await r.json();
    return res.status(200).json({ ok: true, row: created[0] });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function invAdjust(req, res) {
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const id = (body && body.id) || req.query?.id;
  const qty = parseInt((body && body.qty) ?? req.query?.qty, 10);
  if (!id || Number.isNaN(qty)) return res.status(400).json({ error: 'id et qty requis' });
  try {
    const r = await fetch(`${SB_URL}/rest/v1/stock?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { ...supabaseHeaders(true), Prefer: 'return=minimal' }, body: JSON.stringify({ qty: Math.max(0, qty) }) });
    if (!r.ok) throw new Error(await r.text());
    return res.status(200).json({ ok: true, id, qty: Math.max(0, qty) });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function invReset(req, res) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/stock?status=in.(retour,stock)`, { method: 'PATCH', headers: { ...supabaseHeaders(true), Prefer: 'return=minimal' }, body: JSON.stringify({ counted_qty: 0, counted_at: null }) });
    if (!r.ok) throw new Error(await r.text());
    return res.status(200).json({ ok: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
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

  // Produits en rupture de stock (live Shopify)
  if (req.method === 'GET' && req.query?.rupture) return ruptureStock(req, res);

  // Découverte pipelines eGrow (admin, secret-gated)
  if (req.query?.egrow_stages) return egrowStages(req, res);
  // Liste des 6 pipelines filtrables (pour construire les boutons côté page)
  if (req.query?.pipelines_list) return res.status(200).json({ pipelines: PIPELINES });
  // Commandes d'un pipeline eGrow + dispo stock interne
  if (req.method === 'GET' && req.query?.pipeline) return pipelineScan(req, res);

  // Actions « Commandes en stock » (page dédiée)
  if (req.method === 'POST' && req.query?.action === 'ship') return shipFromStock(req, res);
  if (req.method === 'POST' && req.query?.action === 'scan') return scanOrdersStock(req, res);
  if (req.method === 'POST' && req.query?.action === 'ship_deal') return shipDeal(req, res);
  if (req.method === 'POST' && req.query?.action === 'prep') return prepToggle(req, res);
  if (req.method === 'GET' && req.query?.prepared) return preparedList(req, res);
  if (req.method === 'GET' && req.query?.history) return historyList(req, res);
  if (req.method === 'GET' && req.query?.bestsellers) return bestSellers(req, res);
  if (req.method === 'GET' && req.query?.delivered) return deliveredSellers(req, res);

  // Inventaire physique (réconciliation stock ↔ dépôt)
  if (req.query?.inv === 'list') return invList(req, res);
  if (req.method === 'POST' && req.query?.action === 'inv_count') return invCount(req, res);
  if (req.method === 'POST' && req.query?.action === 'inv_add') return invAdd(req, res);
  if (req.method === 'POST' && req.query?.action === 'inv_adjust') return invAdjust(req, res);
  if (req.method === 'POST' && req.query?.action === 'inv_reset') return invReset(req, res);

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
