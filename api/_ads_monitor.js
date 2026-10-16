// _ads_monitor.js — Moniteur de facturation du compte pub Meta (Touni). Préfixe "_" : ne compte pas dans la limite de 12 fonctions Vercel.
// LECTURE SEULE sur l'API Graph. Aucun secret en dur : jeton = process.env.META_ADS_TOKEN (passé par l'appelant).
//
// API :
//   checkAdsAccount({ token, accountId }) -> { status, status_label, level: 'ok'|'warning'|'critical', reasons[], metrics }
//   buildAlertMessage(result)             -> string FR (ou '' si level ok)
//   runAdsMonitor({ token, accountId, dry, force, send, store }) -> { ran, level, sent, skipped, message, result }
//   evaluate(data, opts)                  -> logique pure (testable sans réseau)
//
// Ce que l'API ne donne PAS : le solde réel de la carte/banque, la date du prochain prélèvement, adspaymentcycle (champ inexistant sur ce compte).
// Ce qu'on utilise : account_status (1/2/3/7/8/9/100/101/201/202), disable_reason, balance (= dépense non encore prélevée, en centimes),
// funding_source_details (carte), spend_cap, journal /activities (ad_account_billing_charge, ad_account_update_status), insights du jour.
// Seuil de facturation estimé = plus gros prélèvement observé dans le journal (ici 225 $), car Meta prélève dès que balance >= seuil.

const ACCOUNT_ID_DEFAULT = 'act_1404371898503365';
const GRAPH = 'https://graph.facebook.com/v21.0';
const BILLING_URL = (id) => `https://business.facebook.com/billing_hub/payment_activity?asset_id=${String(id).replace(/^act_/, '')}`;

// ───────── Seuils retenus ─────────
const T = {
  PRECHARGE_RATIO: 0.85,        // balance >= 85 % du seuil de facturation -> prélèvement imminent (warning, 1 fois par cycle)
  OVERDUE_RATIO: 1.15,          // balance >= 115 % du seuil ET dernier prélèvement réussi > OVERDUE_HOURS -> prélèvement probablement refusé (critical)
  OVERDUE_HOURS: 6,
  DEFAULT_THRESHOLD_USD: 225,   // repli si le journal n'a aucun prélèvement ; surchargeable : ADS_BILLING_THRESHOLD_USD
  SPEND_CAP_WARN: 0.10,         // spend cap : < 10 % restant ou < 1 jour de dépense -> warning
  SPEND_CAP_CRIT_DAYS: 0.5,     // < 0,5 jour de dépense restant -> critical
  ZERO_SPEND_AFTER_HOUR: 12,    // Maroc : 0 $ dépensé aujourd'hui passé midi alors que des pubs tournent -> warning
  ZERO_SPEND_MIN_YESTERDAY: 20, // ... seulement si hier > 20 $
  DEDUPE_HOURS: 12,             // même alerte au plus 1 fois / 12 h
  RUN_EVERY_MIN: 60,            // au plus 1 vérification / heure
};

const STATUS_LABELS = {
  1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED (règlement non réglé)', 7: 'PENDING_RISK_REVIEW', 8: 'PENDING_SETTLEMENT (règlement en attente)',
  9: 'IN_GRACE_PERIOD (période de grâce)', 100: 'PENDING_CLOSURE', 101: 'CLOSED', 201: 'ANY_ACTIVE', 202: 'ANY_CLOSED',
};
const DISABLE_REASONS = { 0: 'aucune', 1: 'ADS_INTEGRITY_POLICY', 2: 'ADS_IP_REVIEW', 3: 'RISK_PAYMENT (paiement à risque)', 4: 'GRAY_ACCOUNT_SHUT_DOWN', 5: 'ADS_AFC_REVIEW', 6: 'BUSINESS_INTEGRITY_RAR', 7: 'PERMANENT_CLOSE', 8: 'UNUSED_RESELLER_ACCOUNT', 9: 'UNUSED_ACCOUNT', 10: 'UMBRELLA_AD_ACCOUNT', 11: 'BUSINESS_MANAGER_INTEGRITY_POLICY', 12: 'MISREPRESENTED_AD_ACCOUNT', 13: 'AOAB_DESHARE_LEGAL_ENTITY', 14: 'CTX_THREAD_REVIEW', 15: 'COMPROMISED_AD_ACCOUNT' };

// ───────── Graph (lecture seule, peu d'appels : 3 par vérification, car l'API limite ~ appels/compte) ─────────
async function gget(token, path, params) {
  const qs = new URLSearchParams(Object.assign({}, params, { access_token: token })).toString();
  const r = await fetch(`${GRAPH}/${path}?${qs}`);
  const j = await r.json().catch(() => ({}));
  if (j && j.error) { const e = new Error(`Graph ${j.error.code || r.status}: ${String(j.error.message || '').slice(0, 140)}`); e.code = j.error.code; throw e; }
  return j;
}

async function fetchAccountData({ token, accountId }) {
  const id = accountId || ACCOUNT_ID_DEFAULT;
  const acc = await gget(token, id, { fields: 'name,account_status,disable_reason,balance,amount_spent,spend_cap,currency,timezone_name,funding_source,funding_source_details,is_prepay_account' });
  let activities = [], insights = [];
  try {
    const since = Math.floor(Date.now() / 1000) - 6 * 86400;
    const a = await gget(token, `${id}/activities`, { fields: 'event_type,event_time,extra_data', since: String(since), limit: '500' });
    activities = (a.data || []).filter((x) => /ad_account_billing_charge|ad_account_update_status|billing|payment|spend_cap|funding/i.test(x.event_type));
  } catch (e) { activities = null; }   // non bloquant (rate limit) : on décide sur account_status/balance seuls
  try {
    const i = await gget(token, `${id}/insights`, { fields: 'spend', time_increment: '1', time_range: JSON.stringify({ since: casaDay(new Date(), -2), until: casaDay(new Date(), 0) }) });
    insights = i.data || [];
  } catch (e) { insights = null; }
  return { acc, activities, insights };
}

// ───────── Logique pure ─────────
function casaHour(now) { try { return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Casablanca', hour: '2-digit', hour12: false }).format(now), 10); } catch (e) { return 12; } }
function casaDay(now, offset) { const d = new Date(now.getTime() + (offset || 0) * 86400000); return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(d); }
const usd = (cents) => Math.round(Number(cents) || 0) / 100;

function evaluate(data, opts) {
  const o = opts || {}; const now = o.now || new Date();
  const acc = data.acc || {}; const reasons = []; let level = 'ok';
  const bump = (l, msg) => { reasons.push(msg); if (l === 'critical' || (l === 'warning' && level === 'ok')) level = l; };
  const status = Number(acc.account_status);
  const m = { account: acc.name, status_label: STATUS_LABELS[status] || String(status), card: acc.funding_source_details && acc.funding_source_details.display_string, signature: 'ok' };

  // 1) Statut du compte (le signal le plus fiable)
  if (status === 9) { bump('critical', 'Le compte est en PÉRIODE DE GRÂCE : le dernier prélèvement a échoué. Les pubs vont être coupées si tu ne règles pas.'); m.signature = 'status9'; }
  else if (status === 8) { bump('critical', 'Règlement EN ATTENTE : un paiement est en cours de traitement ou refusé.'); m.signature = 'status8'; }
  else if (status === 3) { bump('critical', 'Règlement NON RÉGLÉ (UNSETTLED) : un paiement est refusé, les pubs sont coupées ou vont l\'être.'); m.signature = 'status3'; }
  else if (status === 2) { bump('critical', `Compte pub DÉSACTIVÉ (${DISABLE_REASONS[acc.disable_reason] || 'raison ' + acc.disable_reason}).`); m.signature = 'status2:' + acc.disable_reason; }
  else if (status === 7) { bump('critical', 'Compte en REVUE DE RISQUE par Meta (souvent lié à un paiement) : les pubs peuvent être suspendues.'); m.signature = 'status7'; }
  else if (status === 100 || status === 101 || status === 201 || status === 202) { bump('critical', `Compte pub fermé / en fermeture (statut ${status}).`); m.signature = 'status' + status; }
  else if (status !== 1) { bump('warning', `Statut de compte inattendu : ${status}.`); m.signature = 'statusX' + status; }

  // 2) Moyen de paiement
  if (!acc.funding_source || !acc.funding_source_details) { bump('critical', 'Aucun moyen de paiement actif sur le compte pub.'); m.signature += '|nofunding'; }

  // 3) Estimation « on approche de la limite » : balance vs seuil de facturation estimé
  const balance = usd(acc.balance); m.balance_usd = balance;
  const charges = (data.activities || []).filter((x) => x.event_type === 'ad_account_billing_charge')
    .map((x) => { let e = x.extra_data; if (typeof e === 'string') { try { e = JSON.parse(e); } catch (er) { e = {}; } } return { t: Date.parse(x.event_time), usd: usd(e && e.new_value) }; })
    .filter((c) => c.usd > 0).sort((a, b) => b.t - a.t);
  const envThr = parseFloat(process.env.ADS_BILLING_THRESHOLD_USD || '');
  const baseThr = envThr || T.DEFAULT_THRESHOLD_USD;   // /activities est tronqué (beaucoup d'événements de pubs) : on prend le plus haut entre le seuil par défaut et les prélèvements vus
  const threshold = charges.length ? Math.max(baseThr, ...charges.map((c) => c.usd)) : baseThr;
  m.threshold_usd = threshold; m.last_charge_at = charges[0] ? new Date(charges[0].t).toISOString() : null; m.last_charge_usd = charges[0] ? charges[0].usd : null;
  m.ratio = threshold ? Math.round((balance / threshold) * 100) / 100 : null;
  const hoursSinceCharge = charges[0] ? (now.getTime() - charges[0].t) / 3600000 : null;
  m.hours_since_last_charge = hoursSinceCharge == null ? null : Math.round(hoursSinceCharge * 10) / 10;
  // dépense/jour (insights) pour estimer l'heure du prochain prélèvement
  const ins = (data.insights || []).map((x) => ({ d: x.date_start, s: parseFloat(x.spend) || 0 }));
  const today = ins.find((x) => x.d === casaDay(now, 0)); const yest = ins.find((x) => x.d === casaDay(now, -1));
  m.spend_today_usd = today ? today.s : (data.insights ? 0 : null); m.spend_yesterday_usd = yest ? yest.s : null;
  const dailyRate = (yest && yest.s) || (today && today.s) || 0;
  if (dailyRate > 0 && threshold > balance) m.next_charge_in_hours = Math.round(((threshold - balance) / dailyRate) * 24 * 10) / 10;

  if (status === 1 && threshold) {
    const cycle = m.last_charge_at || 'nocharge';
    if (m.ratio >= T.OVERDUE_RATIO && (hoursSinceCharge == null || hoursSinceCharge > T.OVERDUE_HOURS)) {
      bump('critical', `Le solde à prélever (${balance.toFixed(0)} $) dépasse le seuil de facturation estimé (~${threshold.toFixed(0)} $) sans prélèvement récent : le prélèvement est probablement refusé (carte vide / plafond).`); m.signature = 'overdue:' + cycle;
    } else if (m.ratio >= T.PRECHARGE_RATIO) {
      bump('warning', `Prélèvement imminent : ${balance.toFixed(0)} $ à régler sur un seuil estimé de ~${threshold.toFixed(0)} $${m.next_charge_in_hours != null ? ` (dans ~${Math.max(1, Math.round(m.next_charge_in_hours))} h)` : ''}. La carte doit avoir au moins ${threshold.toFixed(0)} $ disponibles.`); m.signature = 'precharge:' + cycle;
    }
  }

  // 4) Spend cap du compte (0 = pas de plafond)
  const cap = usd(acc.spend_cap), spent = usd(acc.amount_spent); m.spend_cap_usd = cap;
  if (cap > 0) {
    const left = cap - spent; m.spend_cap_left_usd = Math.round(left * 100) / 100;
    if (left <= 0 || (dailyRate && left / dailyRate < T.SPEND_CAP_CRIT_DAYS)) { bump('critical', `Plafond de dépense du compte presque atteint : il reste ${Math.max(0, left).toFixed(0)} $ sur ${cap.toFixed(0)} $. Les pubs s'arrêtent à la limite.`); m.signature += '|cap'; }
    else if (left / cap < T.SPEND_CAP_WARN || (dailyRate && left / dailyRate < 1)) { bump('warning', `Plafond de dépense du compte bientôt atteint : il reste ${left.toFixed(0)} $ sur ${cap.toFixed(0)} $.`); m.signature += '|cap'; }
  }

  // 5) Diffusion à l'arrêt (0 $ aujourd'hui passé midi alors qu'hier > 20 $) : signal indirect de coupure
  if (status === 1 && data.insights && casaHour(now) >= T.ZERO_SPEND_AFTER_HOUR && (m.spend_today_usd || 0) === 0 && (m.spend_yesterday_usd || 0) > T.ZERO_SPEND_MIN_YESTERDAY) {
    bump('warning', `Aucune dépense aujourd'hui alors que tu dépensais ${m.spend_yesterday_usd.toFixed(0)} $ hier : les pubs sont peut-être coupées.`); m.signature += '|zerospend';
  }

  // 6) Journal : passage récent en période de grâce / non-actif (utile si le statut est déjà revenu à ACTIF)
  const sts = (data.activities || []).filter((x) => x.event_type === 'ad_account_update_status').sort((a, b) => Date.parse(b.event_time) - Date.parse(a.event_time));
  if (sts[0]) { let e = sts[0].extra_data; if (typeof e === 'string') { try { e = JSON.parse(e); } catch (er) { e = {}; } } m.last_status_change = { at: sts[0].event_time, from: e && e.old_value, to: e && e.new_value }; }

  return { status, status_label: m.status_label, level, reasons, metrics: m, checked_at: now.toISOString() };
}

async function checkAdsAccount({ token, accountId } = {}) {
  const id = accountId || ACCOUNT_ID_DEFAULT;
  if (!token) return { status: null, status_label: 'NO_TOKEN', level: 'warning', reasons: ['META_ADS_TOKEN manquant : le moniteur de facturation est aveugle.'], metrics: { signature: 'notoken', account_id: id } };
  try {
    const data = await fetchAccountData({ token, accountId: id });
    const r = evaluate(data); r.metrics.account_id = id; r.metrics.activities_ok = data.activities !== null; return r;
  } catch (e) {
    if (e.code === 17 || e.code === 4 || e.code === 32) return { status: null, status_label: 'RATE_LIMIT', level: 'ok', reasons: [`API Meta saturée (${e.message}) : vérification reportée.`], metrics: { signature: 'ratelimit', account_id: id, transient: true } };
    const bad = e.code === 190;
    return { status: null, status_label: bad ? 'TOKEN_INVALID' : 'API_ERROR', level: 'warning', reasons: [bad ? 'Le jeton Meta Ads est expiré/invalide (META_ADS_TOKEN) : plus aucune surveillance de facturation.' : `Lecture du compte pub impossible : ${e.message}`], metrics: { signature: bad ? 'token190' : 'apierr', account_id: id } };
  }
}

function buildAlertMessage(result, label) {
  if (!result || result.level === 'ok') return '';
  const m = result.metrics || {}; const link = BILLING_URL(m.account_id || ACCOUNT_ID_DEFAULT);
  const lines = [];
  const L = label ? ` — ${label}` : '';
  if (result.level === 'critical') {
    lines.push(`🚨 *PUBS META${L} : RISQUE DE COUPURE*`);
    lines.push(...result.reasons.map((r) => `• ${r}`));
    lines.push('');
    lines.push('👉 Vérifie ton argent / ta carte bancaire (solde, plafond, 3D Secure), puis reviens payer dans Ads Manager > Facturation :');
  } else if (/imminent|dépasse/.test(result.reasons.join(' ')) || m.signature.startsWith('precharge')) {
    lines.push(`⚠️ *Les publicités${label ? ' ' + label : ''} sont presque arrivées à la limite.*`);
    lines.push('Vérifie si tu as de l\'argent au niveau de ta banque ou de ta carte bancaire.');
    lines.push(...result.reasons.map((r) => `• ${r}`));
    lines.push('');
    lines.push('Si besoin, règle à la main dans Ads Manager > Facturation :');
  } else {
    lines.push(`⚠️ *PUBS META${L} : à vérifier*`);
    lines.push(...result.reasons.map((r) => `• ${r}`));
    lines.push('');
    lines.push('Vérifie dans Ads Manager > Facturation :');
  }
  lines.push(link);
  if (m.card) lines.push(`Carte utilisée : ${m.card}`);
  return lines.join('\n');
}

// ───────── Stockage app_settings (key text, value text, updated_at) via Supabase REST ─────────
function defaultStore() {
  const { SB_URL, supabaseHeaders } = require('./_shopify-helpers.js');
  return {
    async get(key) { try { const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value`, { headers: supabaseHeaders(true) }); const j = await r.json(); return (Array.isArray(j) && j[0] && j[0].value) || ''; } catch (e) { return ''; } },
    async set(key, value) { try { await fetch(`${SB_URL}/rest/v1/app_settings`, { method: 'POST', headers: Object.assign({}, supabaseHeaders(true), { 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' }), body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }) }); } catch (e) {} },
  };
}

// Orchestration : cadence 1 h + déduplication + envoi. send(level, message) est fourni par ai-reply.js (WhatsApp). dry = rien envoyé, rien écrit.
async function runAdsMonitor({ token, accountId, dry, force, send, store, now, tag, label } = {}) {
  const ns = tag ? tag + ':' : '';   // espace de clés par compte pub (Touni = sans préfixe, clés historiques)
  const st = store || (dry ? { get: async () => '', set: async () => {} } : defaultStore());
  const t = (now || new Date()).getTime();
  const out = { ran: false, level: null, sent: false, skipped: null, message: '', result: null };
  if (!dry && !force) {
    const last = parseInt(await st.get('ads_monitor:' + ns + 'last_run'), 10) || 0;
    if (t - last < T.RUN_EVERY_MIN * 60000) { out.skipped = 'cadence'; return out; }
    await st.set('ads_monitor:' + ns + 'last_run', String(t));
  }
  const result = await checkAdsAccount({ token, accountId });
  out.ran = true; out.result = result; out.level = result.level;
  if (result.metrics && result.metrics.transient) return out;
  if (result.level === 'ok') {
    if (!dry) { for (const lv of ['warning', 'critical']) { if (await st.get('ads_alert:' + ns + lv)) await st.set('ads_alert:' + ns + lv, ''); } }   // incident terminé : prochain incident = alerte immédiate
    return out;
  }
  const sig = (result.metrics && result.metrics.signature) || result.level;
  const key = 'ads_alert:' + ns + result.level;
  let prev = null; try { prev = JSON.parse(await st.get(key) || 'null'); } catch (e) {}
  const ageH = prev && prev.t ? (t - prev.t) / 3600000 : Infinity;
  const sameSig = prev && prev.sig === sig;
  // critique : même signature -> max 1 fois / 12 h ; warning pré-prélèvement : 1 seule fois par cycle de facturation ; autre warning : 1 fois / 12 h
  const dedupe = sameSig && (sig.startsWith('precharge:') ? true : ageH < T.DEDUPE_HOURS);
  out.message = buildAlertMessage(result, label);
  if (dedupe) { out.skipped = 'dedupe'; return out; }
  if (dry) { out.skipped = 'dry'; return out; }
  if (typeof send === 'function') { try { await send(result.level, out.message); out.sent = true; } catch (e) { out.skipped = 'send_error'; return out; } }
  await st.set(key, JSON.stringify({ t, sig }));
  return out;
}

module.exports = { checkAdsAccount, buildAlertMessage, runAdsMonitor, evaluate, THRESHOLDS: T, BILLING_URL, ACCOUNT_ID_DEFAULT };
