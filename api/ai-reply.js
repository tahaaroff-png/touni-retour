// Agent IA Touni (Claude). Deux modes sur le MÊME endpoint (plan Hobby = max 12 fonctions) :
//   - POST /api/ai-reply            → répond à UN message (test manuel / eGrow Api Request).
//   - GET  /api/ai-reply?poll=1     → POLLER : lit l'inbox eGrow, répond via Claude, envoie via l'API eGrow.
// Sécurisé par ?secret=. Clé Claude + tokens eGrow en env. Anti-doublon Supabase (table wa_agent_replied).
const { handleIncoming, isButton } = require('./_agent.js');
const { SB_URL, supabaseHeaders, shopifyAdminHeaders, SHOPIFY_DOMAIN, SHOPIFY_API_VERSION } = require('./_shopify-helpers.js');

const SECRET = 'touni-sync-2026';
const EGROW_ME = process.env.EGROW_ME || '';
const EGROW_AK = process.env.EGROW_AK || '';
const EGROW_BASE = 'https://api.egrow.com';
// ⚠️ User-Agent navigateur OBLIGATOIRE : sans lui, eGrow renvoie 403 (anti-bot Cloudflare, code 1010) sur certains envois.
const EGROW_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const INTEGRATIONS = (process.env.EGROW_INTEGRATIONS || '5425').split(',').map((s) => s.trim()).filter(Boolean);
const FRESH_WINDOW_SEC = parseInt(process.env.EGROW_FRESH_SEC || '600', 10); // ne répond qu'aux messages des 10 dernières min
const HUMAN_HANDOVER_SEC = parseInt(process.env.EGROW_HUMAN_HANDOVER_SEC || '5400', 10); // si un humain a répondu il y a < 1h30, le bot se tait
const HISTORY_LIMIT = parseInt(process.env.EGROW_HISTORY_LIMIT || '40', 10); // nb de messages d'historique lus (réponses multi-bulles → fenêtre large pour garder le contexte 1-2h)
const MAX_PER_RUN = parseInt(process.env.EGROW_MAX_PER_RUN || '8', 10);      // garde-fou anti-blast
// #4 — stages pipeline : commande en attente → Confirmer Wtsp (confirm) / Annuler Wtsp (cancel)
const STAGE_CONFIRM = parseInt(process.env.EGROW_STAGE_CONFIRM || '49148', 10);
const STAGE_CANCEL = parseInt(process.env.EGROW_STAGE_CANCEL || '49149', 10);
// On ne déplace QUE si la commande est encore dans une étape AVANT envoi (sinon expédiée → on ne touche pas).
const MOVABLE_STAGES = (process.env.EGROW_MOVABLE_STAGES || '62357,49148,49149').split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);
// Notifications : opératrice e-commerce (Soumaya) sur escalade ; marchand sur upsell/vente.
const OPERATOR_PHONE = (process.env.EGROW_OPERATOR_PHONE || '212672193297').replace(/\D/g, '');
const MERCHANT_PHONE = (process.env.EGROW_MERCHANT_PHONE || '212612717593').replace(/\D/g, '');

// ───────── Lecture robuste du body (mode POST : JSON, urlencoded, multipart eGrow) ─────────
function tryParse(raw, req) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) {}
  const ct = (req.headers && req.headers['content-type']) || '';
  if (ct.indexOf('multipart/form-data') !== -1) {
    const m = ct.match(/boundary=("?)([^";]+)\1/);
    if (m) {
      const out = {};
      raw.split('--' + m[2]).forEach(function (part) {
        const nm = part.match(/name="([^"]+)"/);
        if (!nm) return;
        const i = part.indexOf('\r\n\r\n');
        if (i === -1) return;
        out[nm[1]] = part.slice(i + 4).replace(/[\r\n]+--?$/, '').replace(/[\r\n]+$/, '');
      });
      if (Object.keys(out).length) return out;
    }
  }
  try { const o = {}; new URLSearchParams(raw).forEach(function (v, k) { o[k] = v; }); if (Object.keys(o).length) return o; } catch (e) {}
  return null;
}
async function getBody(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b) && Object.keys(b).length) return b;
  if (typeof b === 'string' && b.length) { const p = tryParse(b, req); if (p) return p; }
  if (Buffer.isBuffer(b) && b.length) { const p = tryParse(b.toString('utf8'), req); if (p) return p; }
  const raw = await new Promise(function (resolve) {
    let d = '';
    try { req.setEncoding('utf8'); } catch (e) {}
    req.on('data', function (c) { d += c; if (d.length > 2e6) { try { req.destroy(); } catch (e) {} } });
    req.on('end', function () { resolve(d); });
    req.on('error', function () { resolve(''); });
  });
  return tryParse(raw, req) || {};
}

// ───────── API eGrow + anti-doublon Supabase (mode POLLER) ─────────
async function egrowGetConversations(integrationId, page) {
  const url = `${EGROW_BASE}/inbox/get_conversations.php?me=${EGROW_ME}&dev=0&integrationId=${integrationId}&page=${page}&limit=20`;
  const r = await fetch(url, { headers: { 'account-key': EGROW_AK, 'User-Agent': EGROW_UA } });
  const j = await r.json();
  return (j && j.data) || [];
}
async function egrowGetMessages(convId, limit) {
  const url = `${EGROW_BASE}/inbox/get_conversation_messages.php?me=${EGROW_ME}&dev=0&conversationId=${convId}&page=1&limit=${limit || 14}`;
  const r = await fetch(url, { headers: { 'account-key': EGROW_AK, 'User-Agent': EGROW_UA } });
  const j = await r.json().catch(() => ({}));
  return (j && j.data) || [];
}
// Pour un clic de BOUTON : eGrow a-t-il DÉJÀ répondu (template) juste après le clic ? (dernier message = sortant/mine)
// → si oui, l'agent ne répond pas (évite la double-réponse en cas de course poll/template).
async function buttonAlreadyAnswered(convId) {
  try {
    const recent = await egrowGetMessages(convId, 1);
    const last = Array.isArray(recent) ? recent[0] : null;
    return !!(last && (last.mine === true || last.mine === 'true'));
  } catch (e) { return false; }
}
async function egrowSend(integrationId, toWaId, text) {
  const boundary = '----TouniAgent' + Math.random().toString(36).slice(2);
  const payload = JSON.stringify({ integrationId: Number(integrationId), to: String(toWaId), type: 'text', body: text, me: EGROW_ME, dev: 0 });
  const raw = `--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${payload}\r\n--${boundary}--\r\n`;
  const r = await fetch(`${EGROW_BASE}/inbox/send_conversation_message.php`, {
    method: 'POST',
    headers: { 'account-key': EGROW_AK, 'User-Agent': EGROW_UA, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: raw,
  });
  try { return await r.json(); } catch (e) { return { status: 'http_' + r.status }; }
}
// POST générique eGrow (multipart, champ "data" = JSON {params, me, dev}) — format universel de l'app.
async function egrowPost(path, params) {
  const p = Object.assign({}, params, { me: EGROW_ME, dev: 0 });
  const boundary = '----TouniAgent' + Math.random().toString(36).slice(2);
  const raw = `--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${JSON.stringify(p)}\r\n--${boundary}--\r\n`;
  const r = await fetch(`${EGROW_BASE}${path}`, { method: 'POST', headers: { 'account-key': EGROW_AK, 'User-Agent': EGROW_UA, 'content-type': `multipart/form-data; boundary=${boundary}` }, body: raw });
  try { return await r.json(); } catch (e) { return null; }
}
// Cherche la commande du client (par téléphone) DANS les étapes déplaçables (avant envoi). Retourne le deal ou null.
async function findMovableDeal(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  for (const sid of MOVABLE_STAGES) {
    const r = await egrowPost('/deal/getStageDeals.php', { stage: sid, search: digits, page: 1, limit: 5 });
    const arr = Array.isArray(r) ? r : (r && r.data) || [];
    for (const d of arr) {
      const dp = String((d.contact && d.contact.phone) || '').replace(/\D/g, '');
      if (dp && (dp === digits || dp.endsWith(digits) || digits.endsWith(dp))) return d;
    }
  }
  return null; // pas trouvé dans une étape avant-envoi → soit expédiée, soit pas de commande → on ne bouge pas
}
// Catégorie d'une étape de pipeline eGrow → pour le suivi de commande.
const STAGE_CAT = (() => {
  const m = {};
  [49152, 49214, 49209, 49210].forEach((id) => (m[id] = 'livree'));                                  // Livrée / Reçu / Payé / Facturé
  [49150, 49151, 49197, 49199, 49200, 49213, 49154, 49212, 49201, 49202].forEach((id) => (m[id] = 'en_route')); // Traiter→Expédié→Ramassé→distribution→en cours
  [49147, 62357, 49148, 49396, 53444, 51500, 55207, 49397, 49430, 49431].forEach((id) => (m[id] = 'avant_envoi')); // Pending/En attente/Confirmé/relances
  [49149, 49153, 49205, 49206, 49155, 49265, 60359, 59765, 49211].forEach((id) => (m[id] = 'annulee_retour'));     // Annulée / Retour
  return m;
})();
// État RÉEL des commandes du client (toutes étapes) → texte injecté à l'agent / renvoyé par l'outil statut_commande.
async function getOrderStatus(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return 'Aucun numéro disponible pour retrouver la commande.';
  let deals = [];
  try {
    const r = await egrowPost('/deal/getStageDeals.php', { search: digits, page: 1, limit: 10 });
    deals = Array.isArray(r) ? r : (r && r.data) || [];
  } catch (e) {}
  deals = deals.filter((d) => { const dp = String((d.contact && d.contact.phone) || '').replace(/\D/g, ''); return dp && (dp === digits || dp.endsWith(digits) || digits.endsWith(dp)); });
  if (!deals.length) return "Aucune commande trouvée pour ce client dans le système (peut-être pas encore commandé, ou via un autre numéro). Ne parle pas d'une commande existante ; aide-le à en passer une.";
  const lines = deals.slice(0, 4).map((d) => {
    const st = d.stage || {}; const cat = STAGE_CAT[st.id] || 'autre';
    const prods = (Array.isArray(d.products) ? d.products : []).map((p) => `${p.quantity || 1}x ${String(p.name || '').trim()}`).join(', ');
    return `• Commande ${d.deal_number || d.id} — étape « ${String(st.name || '?').trim()} » [${cat}]${prods ? ' — ' + prods : ''}${d.deal_city ? ' — ' + d.deal_city : ''}`;
  });
  return `ÉTAT RÉEL DES COMMANDES DU CLIENT (eGrow, en direct) :\n${lines.join('\n')}\n\nSignification des catégories → avant_envoi = pas encore expédiée : le client peut MODIFIER ou ANNULER SANS frais. en_route = déjà expédiée / en distribution : NE PAS modifier, dis-lui qu'elle arrive (24-72h). livree = déjà livrée : échange possible (48h après réception, ~45 dh, photo + étiquette). annulee_retour = annulée ou retournée.`;
}
// Outils (function calling) que l'agent Claude peut appeler lui-même pour aller chercher la donnée live.
const AGENT_TOOLS = [
  {
    name: 'chercher_catalogue',
    description: "Recherche EN DIRECT dans le catalogue Shopify le PRIX EXACT, les TAILLES en stock et la disponibilité d'un produit. À utiliser OBLIGATOIREMENT avant d'annoncer un prix ou une dispo que tu n'as pas déjà, noir sur blanc, dans le bloc CATALOGUE — par ex. un produit reconnu sur une PHOTO, un modèle précis, le prix d'une équipe/édition. Donne une recherche simple : nom d'équipe / type / année (ex: 'Maroc rétro 1998', 'ballon', 'casquette', 'kit Liverpool').",
    input_schema: { type: 'object', properties: { recherche: { type: 'string', description: "mots-clés du produit (équipe, type, année…)" } }, required: ['recherche'] },
  },
  {
    name: 'statut_commande',
    description: "Donne l'état RÉEL de la/les commande(s) du client (étape du pipeline : en attente, confirmée, expédiée, en distribution, LIVRÉE, annulée, retournée) avec les produits. À utiliser pour TOUTE question de suivi/livraison, et OBLIGATOIREMENT avant de parler d'échange/retour/annulation/modification (pour savoir si c'est déjà livré ou pas encore parti).",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];
async function runAgentTool(name, input, phone) {
  if (name === 'chercher_catalogue') {
    const res = await searchCatalog(String((input && input.recherche) || ''));
    return res || "Aucun produit ACTIF en stock ne correspond à cette recherche dans le catalogue live. Ne dis PAS qu'on ne le vend pas : propose la page équipe/catégorie (NOS PAGES) ou demande une précision.";
  }
  if (name === 'statut_commande') return await getOrderStatus(phone);
  return 'Outil inconnu.';
}

// ───────── MODE PATRON (assistant perso, EXCLUSIF au numéro du marchand) ─────────
// Stats de ventes Shopify (nb commandes + CA) pour une période. periode: today | yesterday | 7j | 30j.
async function getSalesStats(period) {
  const p = String(period || 'today').toLowerCase();
  const now = new Date(); const iso = (d) => d.toISOString();
  let min, max = null, label;
  if (/hier|yesterday/.test(p)) { const y = new Date(now); y.setDate(now.getDate() - 1); y.setHours(0, 0, 0, 0); const e = new Date(y); e.setHours(23, 59, 59, 999); min = iso(y); max = iso(e); label = 'hier'; }
  else if (/30|mois|month/.test(p)) { const s = new Date(now); s.setDate(now.getDate() - 30); min = iso(s); label = '30 derniers jours'; }
  else if (/7|semaine|week/.test(p)) { const s = new Date(now); s.setDate(now.getDate() - 7); min = iso(s); label = '7 derniers jours'; }
  else { const t = new Date(now); t.setHours(0, 0, 0, 0); min = iso(t); label = "aujourd'hui"; }
  const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
  const qs = `status=any&created_at_min=${encodeURIComponent(min)}` + (max ? `&created_at_max=${encodeURIComponent(max)}` : '');
  let count = 0, revenue = 0, sampled = 0;
  try { const cr = await fetch(`${base}/orders/count.json?${qs}`, { headers: await shopifyAdminHeaders() }); const cj = await cr.json().catch(() => ({})); count = cj.count || 0; } catch (e) {}
  try { const orr = await fetch(`${base}/orders.json?${qs}&fields=total_price&limit=250`, { headers: await shopifyAdminHeaders() }); const oj = await orr.json().catch(() => ({})); const os = oj.orders || []; sampled = os.length; revenue = os.reduce((s, o) => s + (parseFloat(o.total_price) || 0), 0); } catch (e) {}
  const exact = count <= sampled;
  const ca = (!exact && sampled > 0) ? Math.round((revenue / sampled) * count) : Math.round(revenue);
  return { label, count, ca, exact };
}
// Données PUB META (dépense, ROAS, achats, impressions). Nécessite META_ACCESS_TOKEN (env). Compte par défaut act_178386983599000.
async function getMetaInsights(period) {
  const token = process.env.META_ACCESS_TOKEN;
  const acct = process.env.META_AD_ACCOUNT || 'act_178386983599000';
  if (!token) return "Meta n'est pas encore connecté (il manque le token META_ACCESS_TOKEN dans Vercel). Dis au patron de l'ajouter pour activer les stats pub.";
  const p = String(period || 'today').toLowerCase();
  const dp = /30|mois/.test(p) ? 'last_30d' : /7|semaine/.test(p) ? 'last_7d' : /hier/.test(p) ? 'yesterday' : 'today';
  try {
    const url = `https://graph.facebook.com/v21.0/${acct}/insights?fields=spend,impressions,clicks,actions,purchase_roas&date_preset=${dp}&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url); const j = await r.json().catch(() => ({}));
    if (j.error) return `Erreur Meta : ${(j.error && j.error.message) || 'token invalide/expiré ?'}`;
    const d = (j.data && j.data[0]) || {};
    const roas = d.purchase_roas && d.purchase_roas[0] && d.purchase_roas[0].value;
    const purch = (d.actions || []).find((a) => /purchase/i.test(a.action_type || ''));
    return `Pub Meta (${dp}) : dépense ${d.spend || 0}, impressions ${d.impressions || 0}, clics ${d.clicks || 0}${purch ? `, achats ${purch.value}` : ''}${roas ? `, ROAS ${roas}` : ''}.`;
  } catch (e) { return 'Impossible de récupérer les données Meta pour le moment.'; }
}
const MERCHANT_TOOLS = [
  { name: 'stats_ventes', description: "NOMBRE de commandes et CHIFFRE D'AFFAIRES (Shopify) pour une période. periode = 'today' | 'yesterday' | '7j' | '30j'.", input_schema: { type: 'object', properties: { periode: { type: 'string' } }, required: ['periode'] } },
  { name: 'stats_pub_meta', description: "Données PUBLICITÉ Meta/Facebook (dépense, ROAS, achats, impressions, clics) pour une période. periode = 'today' | 'yesterday' | '7j' | '30j'.", input_schema: { type: 'object', properties: { periode: { type: 'string' } }, required: ['periode'] } },
  { name: 'commande_client', description: "État réel de la/les commande(s) d'un client par son NUMÉRO de téléphone (étape pipeline + produits).", input_schema: { type: 'object', properties: { telephone: { type: 'string' } }, required: ['telephone'] } },
  { name: 'chercher_produit', description: "STOCK (tailles dispo), PRIX et statut d'un produit (recherche par mots-clés).", input_schema: { type: 'object', properties: { recherche: { type: 'string' } }, required: ['recherche'] } },
];
async function runMerchantTool(name, input) {
  if (name === 'stats_ventes') { const s = await getSalesStats((input && input.periode) || 'today'); return `Ventes Shopify ${s.label} : ${s.count} commande(s), CA ${s.exact ? '' : '≈ '}${s.ca} dh.`; }
  if (name === 'stats_pub_meta') return await getMetaInsights((input && input.periode) || 'today');
  if (name === 'commande_client') { return await getOrderStatus((input && input.telephone) || ''); }
  if (name === 'chercher_produit') { const r = await searchCatalog((input && input.recherche) || ''); return r || 'Aucun produit ACTIF en stock pour cette recherche.'; }
  return 'Outil inconnu.';
}
const MERCHANT_SYSTEM = `Tu es l'ASSISTANT PERSONNEL PRIVÉ du gérant de Touni.ma (tu parles à son numéro WhatsApp perso, c'est LE PATRON — PAS un client).
RÔLE : réponds à SES questions sur SON business avec ses VRAIES données : ventes & chiffre d'affaires Shopify (stats_ventes), dépenses & ROAS de la PUB Meta/Facebook (stats_pub_meta), état d'une commande d'un client par téléphone (commande_client), stock/tailles/prix d'un produit (chercher_produit). Tu peux croiser les données (ex: CA vs dépense pub). Sois PRÉCIS et DIRECT, donne des chiffres concrets, pas de discours commercial. Appelle les outils pour avoir les vrais chiffres (n'invente jamais un chiffre).
⚠️ ULTRA-CONFIDENTIEL : ces données internes sont STRICTEMENT privées et réservées au patron. Tu ne les divulgues JAMAIS à personne d'autre.
LANGUE : réponds dans la langue du patron (français ou darija), court et clair (c'est WhatsApp). Tu peux mettre 1-2 emojis.
FORMAT DE SORTIE : réponds UNIQUEMENT avec un objet JSON valide : {"reply":"<ta réponse au patron>","intent":"answer","note":"","order":null}`;

// Mode du patron (persisté) : 'patron' (assistant données, défaut) ou 'client' (teste l'expérience de vente).
async function getMerchantMode() {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/merchant_state?id=eq.1&select=mode`, { headers: supabaseHeaders(true) });
    const j = await r.json().catch(() => []);
    return (Array.isArray(j) && j[0] && j[0].mode) || 'patron';
  } catch (e) { return 'patron'; }
}
async function setMerchantMode(mode) {
  try {
    await fetch(`${SB_URL}/rest/v1/merchant_state?id=eq.1`, {
      method: 'PATCH', headers: Object.assign({}, supabaseHeaders(true), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ mode, updated_at: new Date().toISOString() }),
    });
  } catch (e) {}
}
// Détecte une commande de bascule de mode dans le message du patron. Renvoie 'client' | 'patron' | null.
function detectModeCommand(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[^a-z\s\/]/g, '').trim();
  if (/^\/?(mode\s+)?(client|public|vente|test)$/.test(t) || /(passe|mets?|active).*(mode\s+)?(client|public|vente)/.test(t)) return 'client';
  if (/^\/?(mode\s+)?(patron|admin|boss|prive|prive|assistant)$/.test(t) || /(passe|mets?|active|reviens|retour).*(mode\s+)?(patron|admin|assistant)/.test(t)) return 'patron';
  return null;
}
// Déplace un deal vers un stage (confirm = 49148, cancel = 49149).
async function moveDeal(deal, targetStage) {
  return egrowPost('/deal/updateDealOrderinNewStage.php', {
    new_order: 1, old_order: deal.order || 1, stage_id: targetStage, deal_id: deal.id,
    old_stage: (deal.stage && deal.stage.id) || (MOVABLE_STAGES[0] || 62357), update_stage_source: 'update order stage',
  });
}

// ───────── #3 — création de commande ─────────
function normTxt(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
// Catégories produit (pour cibler la recherche eGrow et vérifier qu'on commande le bon TYPE).
const PROD_CATEGORY = new Set('maillot maillots kit kits ensemble ensembles survetement survetements casquette casquettes ballon ballons short shorts chaussette chaussettes polo polos tshirt sweat hoodie gourde pantalon pantalons'.split(' '));
// Mots NON distinctifs (catégorie + modificateurs + articles) : à ne PAS utiliser seuls (sinon « Maillot » matche tout).
const PROD_GENERIC = new Set([...PROD_CATEGORY, ...'accessoire accessoires pro version versions edition editions speciale special collector retro retros vintage classic classique authentique domicile exterieur exterieure third home away de du da la le les des un une et nom numero foot football club saison nouvelle nouveau'.split(' ')]);
async function egrowSearchProduct(name) {
  const tryOne = async (q) => { const r = await egrowPost('/product/getUserProduct.php', { search: String(q || '').slice(0, 80) }); return Array.isArray(r) ? r : (r && r.data) || []; };
  let arr = await tryOne(name);
  if (arr.length) return arr;
  const words = String(name || '').split(/\s+/).filter((w) => w.length > 1);
  const cat = words.find((w) => PROD_CATEGORY.has(normTxt(w)));             // ex: "Maillot"
  const distinct = words.filter((w) => !PROD_GENERIC.has(normTxt(w)));      // ex: ["Maroc","1998","Blanc"]
  if (cat && distinct.length) { arr = await tryOne(`${cat} ${distinct[0]}`); if (arr.length) return arr; } // "Maillot Maroc" → vrais maillots
  if (distinct.length) {
    arr = await tryOne(distinct.slice(0, 3).join(' ')); if (arr.length) return arr; // "Maroc 1998 Blanc"
    const longestD = distinct.slice().sort((a, b) => b.length - a.length)[0];
    if (longestD) { arr = await tryOne(longestD); if (arr.length) return arr; }      // "Maroc"
  }
  return arr; // peut être vide → createOrderDeal le gère (échec → marchand prévenu)
}
async function createOrderDeal(order, contactId) {
  const prods = await egrowSearchProduct(order.product);
  if (!prods.length) return { ok: false, reason: 'product_not_found' };
  const want = normTxt(order.product);
  // GARDE-FOU MATCH : le produit choisi doit (a) être de la même CATÉGORIE (un maillot ≠ un hoodie) et
  // (b) partager ≥1 mot DISTINCTIF (équipe/année/couleur). Sinon on n'invente pas un deal → échec → marchand prévenu.
  const wantDistinct = want.split(' ').filter((w) => w.length > 2 && !PROD_GENERIC.has(w));
  const wantCat = [...PROD_CATEGORY].find((ch) => want.split(' ').includes(ch));
  let p = prods.find((x) => normTxt(x.name) === want);
  if (!p) {
    const cand = prods
      .map((x) => { const nx = normTxt(x.name); return { x, dist: wantDistinct.filter((w) => nx.includes(w)).length, catOk: !wantCat || nx.split(' ').includes(wantCat) }; })
      .filter((c) => c.dist >= 1 && c.catOk)
      .sort((a, b) => b.dist - a.dist);
    if (!cand.length) return { ok: false, reason: 'no_product_match' }; // rien de fiable → ne crée pas un mauvais deal
    p = cand[0].x;
  }
  const qty = Math.max(1, parseInt(order.quantity || 1, 10) || 1);
  const price = parseFloat(p.price) || 0;
  const productList = [Object.assign({}, p, { quantity: qty })];
  let value = price * qty;
  // FLOCAGE : si le client veut un flocage (nom/numéro), on ajoute le produit eGrow "Flocage Personnalisé PRO" (99 dh) au deal.
  let flocageNote = '';
  const fl = order.flocage;
  if (fl && (fl.name || fl.number)) {
    try {
      const fres = await egrowSearchProduct('Flocage');
      const fp = (fres || []).find((x) => /flocage/i.test(x.name || ''));
      if (fp) { productList.push(Object.assign({}, fp, { quantity: qty })); value += (parseFloat(fp.price) || 99) * qty; }
    } catch (e) {}
    flocageNote = ` | FLOCAGE: ${[fl.name, fl.number].filter(Boolean).join(' ')}`;
  }
  const body = {
    id: 0, label: '', source: 'agent-ia-whatsapp',
    deal_city: order.city || '', country: 'MA', deal_address: order.address || '',
    deal_apartment: '', deal_province: '', deal_zip: '', deal_area: '', deal_street_name: '', deal_house_number: '', deal_nearest_place: '', deal_location: '', deal_district: '',
    deal_payment_method: 'Cash on Delivery (COD)', payment_status: 'pending',
    deal_shipping_price: 0, deal_shipping: null,
    contact_id: contactId, type: 'deal', title: `${order.customer_name || ''} - ${p.name}`.slice(0, 120),
    deal_value: value, deal_currency: { id: 153, name: 'Dirham', code: 'MAD', symbol: 'MAD' },
    deal_custom_fields: JSON.stringify({ note: '' }), products: JSON.stringify(productList),
    pipeline_stage: STAGE_CONFIRM, close_date: 0, deal_number: '', deal_tracking_number: '',
    users: '[]', do_not_update_assigned: false, shipping_user_connection: 0,
  };
  const res = await egrowPost('/deal/add_or_update_deal.php', body);
  const dealId = (res && res.deal && res.deal.id) || null;
  return { ok: !!(res && res.status === 'success'), dealId, product: p.name, price, qty, value, flocageNote, hasFlocage: !!flocageNote };
}
async function addDealNote(dealId, content) {
  try { return await egrowPost('/notes/add_or_update_note.php', { id: 0, content: String(content).slice(0, 500), type: 'deal', context: dealId, color: '' }); } catch (e) { return null; }
}
// Claim ATOMIQUE (anti-doublon) : insère msg_id et renvoie true UNIQUEMENT si c'est NOUS qui venons de l'insérer.
// Deux runs simultanés (2 crons, ou un run qui chevauche le suivant) → un seul gagne le claim, l'autre reçoit false et skip
// → JAMAIS de double réponse. (msg_id = clé primaire ; resolution=ignore-duplicates + return=representation → la ligne
// n'est renvoyée que si l'insertion a réellement eu lieu.)
async function claimMessage(msgId, convId, phone, preview) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/wa_agent_replied`, {
      method: 'POST',
      headers: Object.assign({}, supabaseHeaders(true), { 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates,return=representation' }),
      body: JSON.stringify({ msg_id: String(msgId), conv_id: String(convId), contact_phone: String(phone || ''), body_preview: String(preview || '').slice(0, 200) }),
    });
    const j = await r.json().catch(() => []);
    return Array.isArray(j) && j.length > 0; // ≥1 ligne renvoyée = insertion réussie = on détient le claim
  } catch (e) { return false; } // erreur DB → on s'abstient (mieux vaut rater que doubler ; le prochain run réessaiera)
}
// Libère le claim (si l'envoi échoue ou si finalement on ne répond pas) → le prochain run pourra reprendre ce message.
async function releaseClaim(msgId) {
  try { await fetch(`${SB_URL}/rest/v1/wa_agent_replied?msg_id=eq.${encodeURIComponent(msgId)}`, { method: 'DELETE', headers: supabaseHeaders(true) }); } catch (e) {}
}

// ── HANDOVER HUMAIN : ne pas marcher sur les pieds d'un opérateur humain ──
// Le bot ET l'humain envoient depuis le MÊME numéro business (eGrow marque les deux `mine:true`).
// Pour distinguer, on mémorise l'id de CHAQUE message envoyé par le bot (table agent_sent).
// Enregistre l'id d'un message que le bot vient d'envoyer (depuis la réponse d'envoi, sinon en relisant le dernier message).
async function markBotSent(convId, integrationId, sendRes) {
  try {
    let id = '';
    const cands = [sendRes && sendRes.id, sendRes && sendRes.messageId,
      sendRes && sendRes.data && (sendRes.data.id || sendRes.data.messageId || (sendRes.data.message && sendRes.data.message.id))];
    for (const c of cands) { if (c) { id = String(c); break; } }
    if (!id) { // fallback : relire le dernier message de la conv (= celui qu'on vient d'envoyer)
      const recent = await egrowGetMessages(convId, 1);
      const last = Array.isArray(recent) ? recent[0] : null;
      if (last && (last.mine === true || last.mine === 'true') && last.id) id = String(last.id);
    }
    if (!id) return;
    await fetch(`${SB_URL}/rest/v1/agent_sent`, {
      method: 'POST',
      headers: Object.assign({}, supabaseHeaders(true), { 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates' }),
      body: JSON.stringify({ msg_id: id, conv_id: String(convId) }),
    });
  } catch (e) {}
}
// Parmi une liste d'ids sortants, lesquels sont des envois DU BOT (présents dans agent_sent) → Set.
async function botSentIds(ids) {
  const out = new Set();
  if (!ids || !ids.length) return out;
  try {
    const inList = ids.map((i) => '"' + String(i).replace(/"/g, '') + '"').join(',');
    const r = await fetch(`${SB_URL}/rest/v1/agent_sent?select=msg_id&msg_id=in.(${encodeURIComponent(inList)})`, { headers: supabaseHeaders(true) });
    const j = await r.json().catch(() => []);
    if (Array.isArray(j)) j.forEach((row) => out.add(String(row.msg_id)));
  } catch (e) {}
  return out;
}
// Un HUMAIN gère-t-il la conversation en ce moment ? (= message sortant récent <1h30 qui n'est PAS du bot)
async function humanHandling(raw, nowSec) {
  const HUMAN_TYPES = ['text', 'image', 'audio', 'voice', 'ptt', 'video', 'document'];
  const outRecent = (raw || [])
    .filter((m) => m && (m.mine === true || m.mine === 'true') && HUMAN_TYPES.includes(String(m.type || '')))
    .map((m) => ({ id: String(m.id || ''), at: parseInt(m.sentAt || m.createdAt || m.timestamp || '0', 10) }))
    .filter((m) => m.id && m.at && (nowSec - m.at) <= HUMAN_HANDOVER_SEC);
  if (!outRecent.length) return false;
  const ours = await botSentIds(outRecent.map((m) => m.id));
  return outRecent.some((m) => !ours.has(m.id)); // au moins un sortant récent qui n'est pas du bot = humain actif
}

// Recherche catalogue Shopify (cache Supabase) selon la demande → bloc dispo en direct à injecter.
const CATALOG_STOPWORDS = new Set('taille tailles size prix combien chhal taman bghit bghi bghyt veux voudrais cherche dispo disponible disponibles bonjour salam salut svp stp merci pour avec est une des les dans vous tu je oui non ok cest quoi autre meme original foot football equipe club saison commande commander acheter chri photo photos couleur couleurs livraison aujourd hui parfait prends prend piece pieces standard mon complet nom adresse ville rue confirme maintenant article articles nombre quantite bien donc alors voila moi prendre prenez prendrai numero tel chi 3ndkom 3ndkoum dial wach ash kayn avez avoir avez-vous propose proposez proposes vend vends vendez vendre fait faites donne donnez montre montrez envoie envoyez trouve trouvez regarde vois voir sur ce cette ces ton tes mes son ses mais que qui comme plus tres beaucoup aussi encore deja juste vraiment chez peux peut pouvez avait gout touni tola wrini werri werrini wri chof chouf nchouf chno chnou chnu chenou achno ach kayna kaynin tswira tswera tsawer tsewira liya lia ndir nbghi kanbghi rani rani bghyti bghiti baghi smiti smiti 3afak afak 3afak khoya sahbi wakha wakhaa walakin walayni'.split(' '));
// Mots de CATÉGORIE : gardés (le client peut chercher une catégorie), mais on privilégie un mot spécifique (équipe) s'il y en a un.
const CATEGORY_WORDS = new Set('maillot maillots kit kits ensemble ensembles survetement survetements casquette casquettes ballon ballons short shorts chaussette chaussettes accessoire accessoires gourde'.split(' '));
// Modificateurs génériques : souvent PAS dans le titre exact du produit → on les retire de la REQUÊTE (sinon la recherche
// AND de Shopify renvoie 0), mais on les garde pour le SCORE (départager les modèles, ex: la version "blanc").
const GENERIC_MODIFIERS = new Set('retro retros vintage classic classique version versions edition editions speciale special collector authentique modele modeles tenue tenues saison nouvelle nouveau neuf neuve domicile exterieur exterieure third'.split(' '));
// Synonymes / surnoms → terme présent dans les titres Shopify
const CATALOG_SYNONYMS = { barca: 'barcelon', barsa: 'barcelon', barcaa: 'barcelon', psg: 'paris', real: 'madrid', juve: 'juventus', mancity: 'manchester', manu: 'manchester', citizens: 'manchester', bayern: 'bayern', intermilan: 'milan', wac: 'wydad', wydadi: 'wydad', rajaoui: 'raja', kora: 'ballon', koura: 'ballon', balon: 'ballon', kaskita: 'casquette', training: 'entrainement', survet: 'survetement', short: 'short', chaussette: 'chaussette',
  // pays / surnoms fréquents (darija incluse) → terme présent dans les titres Shopify
  brazil: 'bresil', brasil: 'bresil', lbrazil: 'bresil', lbresil: 'bresil', bresil: 'bresil', selecao: 'bresil', argentine: 'argentin', lmaghrib: 'maroc', maghrib: 'maroc', morocco: 'maroc', allemagne: 'allemagne', mancunian: 'manchester', reds: 'liverpool', citoyens: 'manchester' };

// Collections Shopify (page équipe/catégorie) — mises en cache mémoire (chaud) ~1h
let _cols = null, _colsAt = 0;
async function getCollections() {
  if (_cols && (Date.now() - _colsAt) < 3600000) return _cols;
  const out = [];
  try {
    for (const ep of ['custom_collections', 'smart_collections']) {
      const cr = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/${ep}.json?limit=250&fields=id,title,handle`, { headers: await shopifyAdminHeaders() });
      const cj = await cr.json().catch(() => ({}));
      (cj[ep] || []).forEach((c) => { if (c.handle) out.push({ title: c.title || '', handle: c.handle }); });
    }
  } catch (e) {}
  if (out.length) { _cols = out; _colsAt = Date.now(); }
  return _cols || [];
}
// Bloc « NOS PAGES » : liste COMPLÈTE et officielle de toutes les collections (équipes/ligues/catégories) + lien vérifié.
// Injecté dans CHAQUE prompt → c'est CLAUDE (pas une heuristique JS fragile) qui choisit la bonne page selon la demande,
// avec toute son intelligence (darija, abréviations, fautes, ambiguïté). Mis en cache ~1h.
let _colBlock = null, _colBlockAt = 0;
async function buildCollectionsBlock() {
  if (_colBlock && (Date.now() - _colBlockAt) < 3600000) return _colBlock;
  const cols = await getCollections();
  if (!cols.length) return _colBlock || '';
  // tri déterministe (par handle) → le bloc est byte-stable d'un appel à l'autre → il se met en CACHE (économie)
  const list = cols.slice().sort((a, b) => String(a.handle).localeCompare(String(b.handle))).map((c) => `- ${c.title} → https://touni.ma/collections/${c.handle}`).join('\n');
  _colBlock = `NOS PAGES (collections) — liste COMPLÈTE et OFFICIELLE, avec le lien EXACT et VÉRIFIÉ de chaque page. C'est ta SEULE source de liens de collection : copie le lien TEL QUEL, n'invente JAMAIS un lien ni un handle, ne devine pas.\n${list}\n→ Quand le client veut voir une équipe / une ligue / une catégorie (même écrit en darija, en abrégé, en surnom ou avec une faute — ex: "lbrazil"=Brésil, "barça"=FC Barcelone, "kaskita"=casquettes), trouve la BONNE page ci-dessus et partage SON lien (page = TOUS les modèles de l'équipe). ⚠️ Si PLUSIEURS pages peuvent correspondre (ex: "Inter" → Inter Miami ET Inter Milan ; "Maroc" → Classic / Rétro / Coupe du monde 2026), ne choisis PAS au hasard : DEMANDE d'abord au client de laquelle il parle, puis envoie le bon lien. Si AUCUNE page ne correspond vraiment, partage seulement https://touni.ma.`;
  _colBlockAt = Date.now();
  return _colBlock;
}
// GARDE-FOU déterministe : aucun lien /collections/ inexistant ne doit JAMAIS partir, peu importe ce que Claude écrit.
// On valide chaque lien collection contre la liste RÉELLE des handles publiés ; un handle inventé → remplacé par l'accueil.
async function sanitizeReplyLinks(reply) {
  if (!reply) return reply;
  let out = String(reply);
  // 1) Liens cliquables en ARABE (RTL) : retire les caractères de direction invisibles (bidi)
  //    qui se glissent autour des URL et cassent la zone cliquable sur WhatsApp.
  out = out.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C]/g, '');
  // 2) Isole chaque URL sur sa propre ligne (saut de ligne avant ET après) + retire la ponctuation
  //    collée à la fin (.,;:!؟،) → WhatsApp détecte l'URL proprement, même au milieu d'un texte RTL.
  out = out.replace(/[ \t]*(https?:\/\/[^\s]+)/g, (m, url) => {
    const cleaned = url.replace(/[).,;:!؟،»"']+$/u, '');
    return '\n' + cleaned + '\n';
  });
  out = out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
  // 3) Garde-fou : aucun lien /collections/ inexistant ne doit partir (sinon → page d'accueil).
  if (out.indexOf('/collections/') !== -1) {
    let handles = new Set();
    try { (await getCollections()).forEach((c) => handles.add(String(c.handle).toLowerCase())); } catch (e) {}
    if (handles.size) {
      out = out.replace(/https?:\/\/touni\.ma\/collections\/([a-z0-9\-]+)/gi, (m, h) =>
        handles.has(h.toLowerCase()) ? m : 'https://touni.ma');
    }
  }
  return out;
}
// Transcription d'un message VOCAL (Groq Whisper large-v3, OpenAI-compatible) → texte, pour que Claude réponde.
async function transcribeAudio(url) {
  const key = process.env.GROQ_API_KEY;
  if (!key || !url) return '';
  try {
    const ar = await fetch(url);
    const buf = Buffer.from(await ar.arrayBuffer());
    if (!buf.length || buf.length > 24000000) return ''; // limite Groq 25 Mo
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'audio.mp3');
    fd.append('model', 'whisper-large-v3');
    fd.append('response_format', 'json');
    const tr = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd,
    });
    const tj = await tr.json().catch(() => ({}));
    return tj && tj.text ? String(tj.text).trim() : '';
  } catch (e) { return ''; }
}
async function searchCatalog(text) {
  try {
    const norm = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const allToks = [...new Set(norm.split(/[^a-z0-9]+/).filter((w) => (w.length >= 3 || /^\d{2,}$/.test(w)) && !CATALOG_STOPWORDS.has(w)))].slice(0, 8);
    if (!allToks.length) return '';
    // privilégie un mot spécifique (équipe/modèle) ; n'utilise les mots de catégorie (maillot, casquette, ballon…) que s'il n'y a rien de plus précis
    const specific = allToks.filter((t) => !CATEGORY_WORDS.has(t));
    const toks = (specific.length ? specific : allToks).slice(0, 6);
    // Synonymes + RECHERCHE LIVE Shopify (GraphQL) → TOUJOURS à jour : prix, stock, statut, nouveaux produits
    const termSet = new Set();
    for (const t of toks) {
      termSet.add(t);
      if (t.length > 4 && /[sx]$/.test(t)) termSet.add(t.slice(0, -1)); // pluriel → singulier (ballons→ballon, casquettes→casquette)
      if (CATALOG_SYNONYMS[t]) termSet.add(CATALOG_SYNONYMS[t]);
    }
    const searchTerms = [...termSet];
    // Recherche FULL-TEXT Shopify, termes séparés par ESPACE (≈ AND, insensible aux accents : "bresil" trouve "Brésil").
    // On retire les modificateurs génériques (retro, version…) de la requête (sinon "maroc retro 98 blanc" = 0 résultat,
    // car aucun titre ne contient "retro"). On les garde dans searchTerms pour le SCORE (départager les modèles).
    const queryTerms = searchTerms.filter((t) => !GENERIC_MODIFIERS.has(t));
    const qstr = (queryTerms.length ? queryTerms : searchTerms).join(' ');
    const gql = 'query($q:String!){ products(first:40, query:$q){ edges{ node{ title handle status variants(first:25){ edges{ node{ title price inventoryQuantity } } } } } } }';
    let products = [];
    try {
      const gr = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: Object.assign({}, await shopifyAdminHeaders(), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ query: gql, variables: { q: qstr } }),
      });
      const gj = await gr.json().catch(() => ({}));
      products = ((gj.data && gj.data.products && gj.data.products.edges) || []).map((e) => e.node);
    } catch (e) {}
    // garder UNIQUEMENT les produits ACTIFS avec au moins une taille en stock (live), classés par pertinence
    const SIZE_RE = /\b(XS|S|M|L|XL|XXL|2XL|3XL|4XL)\b/i;
    const scored = products.map((p) => { const nt = normTxt(p.title); return { p, score: searchTerms.filter((w) => nt.indexOf(w) !== -1).length }; }).sort((a, b) => b.score - a.score);
    const lines = [];
    for (const { p, score } of scored) {
      if (lines.length >= 6) break;
      if (score < 1) continue;           // le terme doit être dans le TITRE (full-text peut ramener des produits où le mot n'est que dans la description)
      if (p.status !== 'ACTIVE') continue; // pas de brouillon/archivé
      const avail = ((p.variants && p.variants.edges) || []).map((e) => e.node).filter((v) => Number(v.inventoryQuantity) > 0);
      if (!avail.length) continue; // rien en stock
      const sizes = [...new Set(avail.map((v) => { const mm = String(v.title || '').match(SIZE_RE); return mm ? mm[1].toUpperCase() : ''; }).filter(Boolean))];
      const price = avail[0].price;
      // Lien DIRECT de la fiche produit (/products/<handle>) — vérifié 200. Fallback recherche si pas de handle.
      const link = p.handle ? `https://touni.ma/products/${p.handle}` : `https://touni.ma/search?q=${encodeURIComponent(String(p.title).replace(/[–—|]/g, ' ').replace(/\s+/g, ' ').trim())}`;
      lines.push(`- ${p.title} : ~${price} dh — EN STOCK${sizes.length ? ' [tailles ' + sizes.join(',') + ']' : ''} | lien: ${link}`);
    }
    // Le choix du LIEN de collection est délégué à Claude via le bloc « NOS PAGES » (injecté à part). Ici on ne renvoie
    // que la dispo produit EN DIRECT (stock/tailles/prix) pour les questions précises.
    if (!lines.length) return '';
    return 'CATALOGUE (stock, tailles & prix EN DIRECT Shopify — UNIQUEMENT produits ACTIFS et EN STOCK ; ne te sers QUE de ceux-ci pour confirmer une dispo / une taille / un prix précis) :\n' + lines.join('\n');
  } catch (e) { return ''; }
}

async function runPoll(q) {
  // Battement de cœur : à chaque passage du cron, on note l'heure → permet de vérifier que le cron tourne (PC éteint).
  try {
    await fetch(`${SB_URL}/rest/v1/agent_heartbeat?id=eq.1`, {
      method: 'PATCH',
      headers: Object.assign({}, supabaseHeaders(true), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ last_poll_at: new Date().toISOString(), source: q.src || 'cron' }),
    });
  } catch (e) {}
  // EGROW_ONLY (env) = mode TEST : l'agent ne répond QU'à ce numéro, et ignore la porte horaire.
  // (Vide en prod → tous les clients, porte horaire active.)
  const envOnly = (process.env.EGROW_ONLY || '').replace(/\D/g, '');
  const dry = q.dry === '1';                          // dry-run : ne pas envoyer, juste lister
  const alwaysOn = (process.env.EGROW_ALWAYS_ON || '') === '1'; // mode 24h/24 (phase de test) : répond à toute heure, tous les clients
  const bypassTime = q.test === '1' || !!envOnly || alwaysOn;     // scope env = test → ignore l'heure
  const onlyPhone = envOnly || (q.only || '').toString().replace(/\D/g, ''); // numéro ciblé
  const nowSec = Math.floor(Date.now() / 1000);
  const results = [];
  let processed = 0;

  for (const integrationId of INTEGRATIONS) {
    const convs = await egrowGetConversations(integrationId, 1);
    for (const c of convs) {
      if (processed >= MAX_PER_RUN) break;
      let claimedMsgId = null; // pour libérer le claim si une erreur survient APRÈS l'avoir pris (sinon le client ne serait jamais répondu)
      try {
        const lm = c.lastMessage || {};
        const contactWaId = String(c.contactWaId || '');
        const senderWaId = String(lm.senderWaId || '');
        const lastTime = parseInt(c.lastMessageTime || lm.sentAt || '0', 10);
        let body = (lm.body || (lm.content && lm.content.body) || '').toString();
        const type = (lm.type || '').toString();
        const msgId = String(lm.id || '');

        if (onlyPhone && contactWaId !== onlyPhone) continue;
        const incoming = senderWaId && contactWaId && senderWaId === contactWaId; // dernier msg = du client (sans réponse)
        if (!incoming) continue;
        if (!lastTime || (nowSec - lastTime) > FRESH_WINDOW_SEC) continue;        // frais uniquement (jamais le backlog)
        if (!msgId) continue;
        const isImage = type === 'image';
        const isAudio = type === 'audio' || type === 'voice' || type === 'ptt';     // message vocal
        const isCall = /call/i.test(type);                                          // appel (manqué) — détection best-effort
        // Clic sur un BOUTON de template : peut arriver en type 'button'/'interactive' ou en 'text' (le libellé). On le traite.
        const btnText = (lm.content && ((lm.content.button && lm.content.button.text) || lm.content.text || (lm.content.interactive && lm.content.interactive.button_reply && lm.content.interactive.button_reply.title))) || '';
        if (btnText && !body.trim()) body = btnText;                                 // récupère le libellé cliqué
        const isButtonMsg = type === 'button' || type === 'interactive' || type === 'button_reply' || isButton(body);
        if (!isImage && !isAudio && !isCall && !isButtonMsg && type && type !== 'text') continue; // template sortant/sticker/reaction → ignore
        if (!isImage && !isAudio && !isCall && !body.trim()) continue;
        if (!dry && !(await claimMessage(msgId, c.id, contactWaId, body || type))) continue; // anti-doublon ATOMIQUE
        if (!dry) claimedMsgId = msgId;
        // Photo entrante → télécharger + base64 pour Claude Vision
        let imageBase64 = null, imageMime = null;
        if (isImage) {
          const iurl = (lm.content && lm.content.url) || '';
          if (!iurl) { await releaseClaim(msgId); continue; }
          try {
            const ir = await fetch(iurl);
            const buf = Buffer.from(await ir.arrayBuffer());
            if (buf.length && buf.length < 4000000) { imageBase64 = buf.toString('base64'); imageMime = (lm.content && lm.content.mime_type) || 'image/jpeg'; }
          } catch (e) {}
          if (!imageBase64) { await releaseClaim(msgId); continue; }
        }
        // Message VOCAL → transcrire (Groq Whisper) puis traiter comme du texte normal
        if (isAudio) {
          const aurl = (lm.content && lm.content.url) || '';
          const txt = aurl ? await transcribeAudio(aurl) : '';
          if (!txt) {
            // Vocal illisible (transcription vide) → on RÉPOND quand même (on ne boucle pas en silence).
            // L'agent demande de reformuler ; s'il a DÉJÀ demandé une fois dans l'historique → il escalade vers l'opératrice.
            body = "🎤 [VOCAL ILLISIBLE : la transcription du message vocal du client a échoué (audio incompréhensible). Si tu as DÉJÀ demandé une fois de reformuler dans l'historique récent → NE redemande PAS, transfère directement à l'opératrice (escalate) avec une note « client envoie des vocaux illisibles, le rappeler ». Sinon : demande gentiment, en une phrase, de réécrire en texte ou de renvoyer un vocal plus court/plus clair.]";
          } else {
            body = '🎤 (message vocal du client, transcrit) ' + txt;
          }
        }
        // APPEL (manqué) → message d'aide automatique (la porte horaire s'applique : surtout hors 9h-18h)
        if (isCall) {
          body = "[Le client vient d'essayer de nous APPELER. Réponds par un message chaleureux : explique gentiment que la ligne téléphonique est ouverte de 9h à 17h, mais que tu es là tout de suite par message pour l'aider (commande, taille, produit, livraison, suivi…). Invite-le à écrire ce dont il a besoin. S'il veut absolument un appel, dis qu'un conseiller le rappellera demain dès 9h.]";
        }

        // Historique de la conversation → réponse en contexte (multi-tours)
        // NB: les réponses du bot font souvent plusieurs bulles (= plusieurs messages eGrow) → on prend une fenêtre plus large
        // pour garder le contexte d'il y a 1-2h (ex: maillot déjà évoqué). Les PHOTOS sont gardées comme marqueur (sinon le fil est perdu).
        let history = [];
        let raw = [];
        try {
          raw = await egrowGetMessages(c.id, HISTORY_LIMIT);
          history = raw
            .map((m) => {
              const mine = (m.mine === true || m.mine === 'true');
              const t = String(m.type || '');
              let content = (m.body || (m.content && m.content.body) || '').toString().trim();
              if (!content) {
                if (t === 'image') content = mine ? '[photo envoyée]' : '[le client a envoyé une PHOTO d\'un produit]';
                else if (t === 'audio' || t === 'voice' || t === 'ptt') content = mine ? '[vocal]' : '[le client a envoyé un message vocal]';
              }
              const keep = ['text', 'template', 'image', 'audio', 'voice', 'ptt'].includes(t) && content;
              return keep ? { role: mine ? 'assistant' : 'user', content } : null;
            })
            .filter(Boolean)
            .reverse(); // ancien -> récent
        } catch (e) {}

        // HANDOVER HUMAIN : si un humain (opératrice) gère déjà cette conv (a répondu < 1h30), le bot se TAIT et laisse l'humain.
        // (ne s'applique PAS au numéro du marchand = assistant patron, lui répond toujours).
        const _isMerchantHere = MERCHANT_PHONE && contactWaId.replace(/\D/g, '') === MERCHANT_PHONE;
        if (!_isMerchantHere) {
          let humanActive = false;
          try { humanActive = await humanHandling(raw, nowSec); } catch (e) {}
          if (humanActive) {
            if (!dry && claimedMsgId) { await releaseClaim(claimedMsgId); claimedMsgId = null; } // libère → on pourra répondre plus tard si l'humain reste inactif 1h30
            results.push({ conv: c.id, phone: contactWaId, msgId, body: body.slice(0, 60), decision: 'human_handover' });
            processed++; continue;
          }
        }

        // NOS PAGES (collections, STATIQUE → caché) à part ; dispo produit LIVE (dynamique) à part.
        // ⚠️ La recherche produit se base sur le MESSAGE ACTUEL uniquement (pas l'historique) : sinon les mots des
        // messages précédents (« maillot »…) noient la demande en cours (« kora » → on croyait ne pas avoir de ballons).
        let collectionsBlock = '', catalog = '';
        try {
          const [cb, prod] = await Promise.all([buildCollectionsBlock(), searchCatalog(body)]);
          collectionsBlock = cb; catalog = prod;
        } catch (e) {}
        // Message lié à un échange/retour → injecter l'état réel de la commande
        try {
          if (/(change|echange|échange|retour|retourn|changer|rembours)/i.test(body)) {
            const d = await findMovableDeal(contactWaId);
            const hint = d
              ? `ÉTAT COMMANDE CLIENT : commande PAS encore expédiée (étape "${(d.stage && d.stage.name) || 'pré-expédition'}"). Donc PAS d'échange — le client peut encore MODIFIER ou ANNULER directement, sans frais.`
              : `ÉTAT COMMANDE CLIENT : aucune commande en pré-expédition trouvée (peut-être déjà reçue/expédiée, ou pas de commande). DEMANDE au client s'il a DÉJÀ REÇU sa commande avant de donner la procédure d'échange.`;
            catalog = hint + (catalog ? '\n\n' + catalog : '');
          }
        } catch (e) {}

        // MODE PATRON (assistant perso, EXCLUSIF au numéro du marchand) vs MODE CLIENT (vente).
        const isMerchantPhone = MERCHANT_PHONE && contactWaId.replace(/\D/g, '') === MERCHANT_PHONE;
        let isMerchant = isMerchantPhone;
        if (isMerchantPhone) {
          // Commande de bascule de mode (« mode client » / « mode patron »)
          const cmd = detectModeCommand(body);
          if (cmd) {
            await setMerchantMode(cmd);
            const msg = cmd === 'client'
              ? "✅ Mode CLIENT activé — je te traite maintenant comme un client (tu peux tester l'expérience de vente). Envoie « mode patron » pour revenir à ton assistant."
              : "✅ Mode PATRON réactivé — je suis de nouveau ton assistant privé (ventes, pub Meta, commandes, stock).";
            if (!dry) { try { await egrowSend(integrationId, contactWaId, msg); } catch (e) {} claimedMsgId = null; }
            results.push({ conv: c.id, phone: contactWaId, decision: 'mode->' + cmd });
            processed++; continue;
          }
          // Sinon, applique le mode mémorisé (le patron peut être passé en mode client pour tester)
          if ((await getMerchantMode()) === 'client') isMerchant = false;
        }
        const decision = await handleIncoming(
          { text: body, name: c.title || (c.contact && c.contact.name) || '', city: (c.contact && c.contact.city) || '', history,
            catalog: isMerchant ? '' : catalog, collectionsBlock: isMerchant ? '' : collectionsBlock, imageBase64, imageMime,
            tools: isMerchant ? MERCHANT_TOOLS : AGENT_TOOLS,
            runTool: isMerchant ? ((n, i) => runMerchantTool(n, i)) : ((n, i) => runAgentTool(n, i, contactWaId)),
            systemOverride: isMerchant ? MERCHANT_SYSTEM : null },
          { bypassTime: bypassTime || isMerchant } // le patron est servi à toute heure
        );
        if (decision && decision.reply) decision.reply = await sanitizeReplyLinks(decision.reply); // anti-lien-cassé
        const entry = { conv: c.id, phone: contactWaId, name: c.title, msgId, body: body.slice(0, 60), decision: decision.skipped || (decision.send ? 'reply' : 'no_send') };
        if (!(decision.send && decision.reply) && !dry) await releaseClaim(msgId); // on ne répond pas (heures ouvrées/bouton) → libère le claim
        if (decision.send && decision.reply) {
          entry.intent = decision.intent;
          // #4 : confirmation/annulation d'une commande EN ATTENTE → déplacer le deal
          const isAction = decision.intent === 'confirm' || decision.intent === 'cancel';
          const target = decision.intent === 'confirm' ? STAGE_CONFIRM : STAGE_CANCEL;
          let deal = null;
          if (isAction) { try { deal = await findMovableDeal(contactWaId); } catch (e) {} }
          const curStage = deal && deal.stage && deal.stage.id;

          if (dry) {
            entry.reply_preview = decision.reply.slice(0, 140);
            if (isAction) entry.dealMove = !deal ? 'no_movable_deal' : (curStage === target ? 'already_there' : { wouldMove: deal.id, from: curStage, to: target });
            if (decision.order) entry.orderWould = decision.order;
          } else if (isButtonMsg && await buttonAlreadyAnswered(c.id)) {
            // BOUTON : eGrow a déjà répondu (un template) juste après le clic → on ne double PAS. L'agent se tait.
            await releaseClaim(msgId); entry.sent = 'skip:template_a_repondu'; entry.decision = 'bouton_gere_par_template';
          } else {
            const sendRes = await egrowSend(integrationId, contactWaId, decision.reply);
            entry.sent = sendRes && sendRes.status;
            if (sendRes && sendRes.status === 'success') { claimedMsgId = null; await markBotSent(c.id, integrationId, sendRes); } // envoi OK → ne PAS libérer + mémoriser l'id (handover humain)
            else await releaseClaim(msgId);                                       // envoi raté → libère pour réessayer au prochain run
            if (isAction && deal && curStage !== target) {
              try {
                const mv = await moveDeal(deal, target);
                entry.dealMove = { deal: deal.id, from: curStage, to: target, ok: mv && mv.status };
              } catch (e) { entry.dealMove = 'err'; }
            } else if (isAction) {
              entry.dealMove = deal ? 'already_there' : 'no_movable_deal';
            }
            // Escalade → prévenir l'opératrice avec un résumé
            if (decision.intent === 'escalate' && OPERATOR_PHONE) {
              try {
                const summary = `🔔 *Client à gérer (agent IA Touni)*\n👤 ${c.title || contactWaId}\n📱 ${contactWaId}\n📝 ${(decision.note || '').slice(0, 400) || 'voir la conversation'}\n💬 « ${body.slice(0, 220)} »`;
                await egrowSend(integrationId, OPERATOR_PHONE, summary);
                entry.operatorNotified = true;
              } catch (e) { entry.operatorNotified = 'err'; }
            }
            // #3 : prise de commande (nouveau client → crée le deal)
            if (decision.order && decision.order.product && decision.order.customer_name && decision.order.city) {
              try {
                const contactId = c.contactId || (c.contact && c.contact.id);
                const r = await createOrderDeal(decision.order, contactId);
                entry.orderCreated = r.ok ? { deal: r.dealId, product: r.product, value: r.value, flocage: r.hasFlocage } : ('fail:' + (r.reason || 'unknown'));
                const o = decision.order;
                if (r.ok) {
                  if (r.dealId) await addDealNote(r.dealId, `Commande prise par l'agent IA (WhatsApp). ${r.qty}x ${r.product}${o.size ? ' taille ' + o.size : ''}${o.color ? ' ' + o.color : ''}.${r.flocageNote || ''} Client: ${o.customer_name}. Adresse: ${o.address}, ${o.city}. Confirmer la taille par appel.`);
                  const saleMsg = `💰 *Nouvelle commande (agent IA)*\n👤 ${o.customer_name} (${contactWaId})\n📦 ${r.qty}x ${r.product}${o.size ? ' (' + o.size + ')' : ''}${r.flocageNote || ''}\n💵 ${r.value} dh · 📍 ${o.city}\n→ créée dans « Confirmer Wtsp »`;
                  try { if (MERCHANT_PHONE) await egrowSend(integrationId, MERCHANT_PHONE, saleMsg); } catch (e) {}
                } else {
                  // ÉCHEC de création → on prévient le marchand pour qu'il crée la commande à la main (jamais de commande perdue)
                  const fl = o.flocage && (o.flocage.name || o.flocage.number) ? `\n🖊️ Flocage: ${[o.flocage.name, o.flocage.number].filter(Boolean).join(' ')} (+99dh)` : '';
                  const failMsg = `⚠️ *Commande à CRÉER À LA MAIN (échec auto: ${r.reason || 'inconnu'})*\n👤 ${o.customer_name} (${contactWaId})\n📦 ${o.quantity || 1}x ${o.product}${o.size ? ' (' + o.size + ')' : ''}${o.color ? ' ' + o.color : ''}${fl}\n📍 ${o.address || ''}, ${o.city}\n→ Le client a confirmé, mais l'agent n'a pas pu créer le deal automatiquement.`;
                  try { if (MERCHANT_PHONE) await egrowSend(integrationId, MERCHANT_PHONE, failMsg); } catch (e) {}
                }
              } catch (e) {
                entry.orderCreated = 'err:' + String(e).slice(0, 80);
                // exception → on prévient quand même le marchand avec ce qu'on a
                try {
                  const o = decision.order; const fl = o.flocage && (o.flocage.name || o.flocage.number) ? `\n🖊️ Flocage: ${[o.flocage.name, o.flocage.number].filter(Boolean).join(' ')}` : '';
                  if (MERCHANT_PHONE) await egrowSend(integrationId, MERCHANT_PHONE, `⚠️ *Commande à créer à la main (erreur)*\n👤 ${o.customer_name} (${contactWaId})\n📦 ${o.quantity || 1}x ${o.product}${o.size ? ' (' + o.size + ')' : ''}${fl}\n📍 ${o.address || ''}, ${o.city}`);
                } catch (e2) {}
              }
            }
          }
          processed++;
        }
        results.push(entry);
      } catch (e) {
        if (claimedMsgId) await releaseClaim(claimedMsgId); // erreur (ex: Claude) après le claim → libère → le client sera répondu au prochain run
        results.push({ conv: c && c.id, error: String(e), detail: (e && e.detail) || null });
      }
    }
  }
  return { ok: true, dry, bypassTime, processed, count: results.length, results };
}

module.exports = async (req, res) => {
  const q = req.query || {};
  if (q.secret !== SECRET) return res.status(401).json({ error: 'unauthorized' });

  // ── Diagnostic notif opératrice (depuis Vercel, avec le vrai egrowSend) ──
  if (q.diagop === '1') {
    const sr = await egrowSend(INTEGRATIONS[0] || '5425', OPERATOR_PHONE, '🔔 Test notification opératrice (diagnostic système Touni).');
    return res.status(200).json({ operator_phone: OPERATOR_PHONE, send_result: sr });
  }

  // ── Mode POLLER ──
  if (q.poll === '1') {
    if (!EGROW_ME || !EGROW_AK) return res.status(503).json({ error: 'egrow_tokens_missing' });
    try { return res.status(200).json(await runPoll(q)); }
    catch (e) { return res.status(500).json({ error: String(e), stack: (e && e.stack || '').split('\n').slice(0, 3) }); }
  }

  // ── Mode REPLY (test manuel / eGrow Api Request) ──
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only (ou ?poll=1)' });
  try {
    let body = await getBody(req); body = body || {};
    // Test transcription : POST {audio_url:"..."} → transcrit (Groq) et traite comme un vocal réel.
    let text = body.message || body.text || body.body || body.content || body.last_message || '';
    if (body.audio_url) { const t = await transcribeAudio(body.audio_url); if (t) text = '🎤 (message vocal du client, transcrit) ' + t; else return res.status(200).json({ error: 'transcription_vide', hint: 'GROQ_API_KEY manquante ou audio illisible' }); }
    const name = body.customer_name || body.name || body.contact_name || body.first_name || '';
    const orderItems = body.order_items || body.products || body.items || '';
    const total = body.total || body.order_total || body.amount || '';
    const city = body.city || body.ville || '';
    console.log('[ai-reply] IN method=%s ct=%s keys=%j text=%j', req.method, (req.headers || {})['content-type'], Object.keys(body || {}), String(text).slice(0, 80));
    const opts = {
      bypassTime: q.test === '1' || q.force === '1' || body.test === true,
      unanswered: body.unanswered === true || body.unanswered === 'true' || q.unanswered === '1',
      isButtonFlag: body.is_button === true || body.is_button === 'true' || body.is_button === 1 || body.is_button === '1' || body.from_button === true || body.from_button === 'true',
    };
    let collectionsBlock = '', catalog = ''; try { const [cb, prod] = await Promise.all([buildCollectionsBlock(), searchCatalog(text)]); collectionsBlock = cb; catalog = prod; } catch (e) {}
    const imageBase64 = body.image_base64 || null;
    const imageMime = body.image_mime || 'image/jpeg';
    const testPhone = String(body.phone || body.contactWaId || q.only || '').replace(/\D/g, '');
    const isMerchantPhone = body.merchant === true || q.merchant === '1' || (MERCHANT_PHONE && testPhone === MERCHANT_PHONE);
    let isMerchant = isMerchantPhone;
    if (isMerchantPhone) {
      const cmd = detectModeCommand(text);
      if (cmd) { await setMerchantMode(cmd); return res.status(200).json({ reply: cmd === 'client' ? '✅ Mode CLIENT activé.' : '✅ Mode PATRON réactivé.', mode: cmd }); }
      if ((await getMerchantMode()) === 'client') isMerchant = false;
    }
    const d = await handleIncoming({ text, name, orderItems, total, city,
      catalog: isMerchant ? '' : catalog, collectionsBlock: isMerchant ? '' : collectionsBlock, imageBase64, imageMime,
      tools: isMerchant ? MERCHANT_TOOLS : AGENT_TOOLS,
      runTool: isMerchant ? ((n, i) => runMerchantTool(n, i)) : ((n, i) => runAgentTool(n, i, testPhone)),
      systemOverride: isMerchant ? MERCHANT_SYSTEM : null }, opts);
    if (d && d.reply) d.reply = await sanitizeReplyLinks(d.reply); // anti-lien-cassé
    return res.status(200).json({ reply: d.reply || '', intent: d.intent || 'answer', note: d.note || '', order: d.order || null, send: !!d.send, skipped: d.skipped, hour: d.hour, usage: d.usage, catalogText: catalog || '' });
  } catch (e) {
    return res.status(500).json({ error: String(e), detail: (e && e.detail) || null });
  }
};
