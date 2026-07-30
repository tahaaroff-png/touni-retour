// API simple pour les notifications Shopify (consultées par le dashboard admin)
// GET /api/notifications?secret=...&status=unread → liste
// GET /api/notifications?secret=...&meta=1&rate=10 → métriques Meta Ads en direct (Vue Directeur)
// PATCH /api/notifications?secret=...&id=XXX → marquer comme lu/archivé
// DELETE /api/notifications?secret=...&id=XXX → supprimer

const { SB_URL, supabaseHeaders, shopifyAdminHeaders, SHOPIFY_DOMAIN, SHOPIFY_API_VERSION } = require('./_shopify-helpers.js');

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
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
