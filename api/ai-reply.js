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
const HUMAN_HANDOVER_SEC = parseInt(process.env.EGROW_HUMAN_HANDOVER_SEC || '3600', 10); // si un humain (équipe) a répondu il y a < 1h, le bot se tait ; il ne reprend qu'après 1h sans réponse humaine
const HISTORY_LIMIT = parseInt(process.env.EGROW_HISTORY_LIMIT || '8', 10);  // nb de messages d'historique lus (8 = suffisant, 20 = trop coûteux)
const MAX_PER_RUN = parseInt(process.env.EGROW_MAX_PER_RUN || '8', 10);      // garde-fou anti-blast
// #4 — stages pipeline : commande en attente → Confirmer Wtsp (confirm) / Annuler Wtsp (cancel)
const STAGE_CONFIRM = parseInt(process.env.EGROW_STAGE_CONFIRM || '49148', 10);
const STAGE_CANCEL = parseInt(process.env.EGROW_STAGE_CANCEL || '49149', 10);
const STAGE_STOCK_WAIT = parseInt(process.env.EGROW_STAGE_STOCK_WAIT || '60669', 10); // stage "rappeler le stock"
const STAGE_RUPTURE = parseInt(process.env.EGROW_STAGE_RUPTURE || '49430', 10);     // stage "Rupture"
// On ne déplace QUE si la commande est encore dans une étape AVANT envoi (sinon expédiée → on ne touche pas).
const MOVABLE_STAGES = (process.env.EGROW_MOVABLE_STAGES || '62357,49148,49149,60669,49430').split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);
// Notifications : opératrices e-commerce sur escalade ; marchand sur upsell/vente.
// EGROW_OPERATOR_PHONE accepte plusieurs numéros séparés par une virgule — chaque opératrice
// reçoit l'escalade, et chacune ouvre sa propre fenêtre de rattrapage en répondant.
const OPERATOR_PHONES = (process.env.EGROW_OPERATOR_PHONE || '212672193297')
  .split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
const OPERATOR_PHONE = OPERATOR_PHONES[0] || ''; // compat : 1re opératrice (endpoint de test)
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
// Envoi d'un template WhatsApp via Meta Cloud API (hors fenêtre 24h)
// eGrow /inbox/send_conversation_template_message.php requiert un cookie session navigateur → inaccessible côté serveur.
// On passe directement par Meta Graph API avec META_WA_TOKEN + META_WA_PHONE_ID.
const META_WA_TOKEN    = process.env.META_WA_TOKEN    || '';
const META_WA_PHONE_ID = process.env.META_WA_PHONE_ID || '784496338069572';
async function egrowSendTemplate(integrationId, toWaId, templateName, language, bodyParams) {
  if (!META_WA_TOKEN) return { status: 'error', message: 'META_WA_TOKEN manquant' };
  const to = String(toWaId).replace(/\D/g, '');
  const components = bodyParams && bodyParams.length ? [{
    type: 'body',
    parameters: bodyParams.map((v) => ({ type: 'text', text: String(v) })),
  }] : [];
  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: templateName, language: { code: language || 'fr' }, components },
  });
  const r = await fetch(`https://graph.facebook.com/v19.0/${META_WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${META_WA_TOKEN}`, 'Content-Type': 'application/json' },
    body,
  });
  const json = await r.json().catch(() => ({ status: 'http_' + r.status }));
  return { status: r.ok ? 'success' : 'error', ...json };
}
// ── FILE D'ATTENTE NOTIFICATIONS (rattrapage fenêtre 24h) ──────────────────────────────────────
// Chaque message envoyé à l'opératrice ou au patron est aussi enregistré en base.
// Quand ils répondent (fenêtre ouverte), on renvoie immédiatement tout ce qui n'est pas arrivé.
async function queueNotification(phone, message) {
  if (!SB_URL || !phone) return;
  try {
    await fetch(`${SB_URL}/rest/v1/pending_notifications`, {
      method: 'POST',
      headers: Object.assign({}, supabaseHeaders(true), { 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates' }),
      body: JSON.stringify({ recipient_phone: String(phone).replace(/\D/g, ''), message: String(message).slice(0, 2000) }),
    });
  } catch (e) {}
}
async function sendAndQueue(integrationId, phone, message) {
  try { await egrowSend(integrationId, phone, message); } catch (e) {}
  await queueNotification(phone, message);
}
async function resendPendingNotifications(integrationId, phone) {
  if (!SB_URL || !phone) return 0;
  const digits = String(phone).replace(/\D/g, '');
  const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/pending_notifications?recipient_phone=eq.${digits}&delivered=eq.false&created_at=gte.${encodeURIComponent(twoDaysAgo)}&order=created_at.asc&select=id,message`,
      { headers: supabaseHeaders() }
    );
    const items = await res.json();
    if (!Array.isArray(items) || !items.length) return 0;
    for (const item of items) {
      try { await egrowSend(integrationId, phone, item.message); } catch (e) {}
      try {
        await fetch(`${SB_URL}/rest/v1/pending_notifications?id=eq.${item.id}`, {
          method: 'PATCH',
          headers: Object.assign({}, supabaseHeaders(true), { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
          body: JSON.stringify({ delivered: true, delivered_at: new Date().toISOString() }),
        });
      } catch (e) {}
    }
    return items.length;
  } catch (e) { return 0; }
}
// ───────────────────────────────────────────────────────────────────────────────────────────────
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
  const phoneMatch = (d) => {
    const dp = String((d.contact && d.contact.phone) || '').replace(/\D/g, '');
    return dp && (dp === digits || dp.endsWith(digits) || digits.endsWith(dp));
  };
  for (const sid of MOVABLE_STAGES) {
    // Essai 1 : recherche par numéro (rapide)
    const r = await egrowPost('/deal/getStageDeals.php', { stage: sid, search: digits, page: 1, limit: 5 });
    const arr = Array.isArray(r) ? r : (r && r.data) || [];
    const hit = arr.find(phoneMatch);
    if (hit) return hit;
    // Essai 2 : fallback scan complet (nécessaire pour Rupture/rappeler le stock où la recherche par tél ne fonctionne pas)
    const maxPages = (sid === STAGE_RUPTURE || sid === STAGE_STOCK_WAIT) ? 7 : 1;
    for (let page = 1; page <= maxPages; page++) {
      const r2 = await egrowPost('/deal/getStageDeals.php', { stage: sid, search: '', page, limit: 20 });
      const arr2 = Array.isArray(r2) ? r2 : (r2 && r2.data) || [];
      if (!arr2.length) break;
      const hit2 = arr2.find(phoneMatch);
      if (hit2) return hit2;
      if (arr2.length < 20) break;
    }
  }
  return null;
}
// Cherche UNE commande récente non-expédiée pour ce numéro (toutes étapes avant envoi).
// Utilisée pour détecter si on doit ajouter à une commande existante plutôt que d'en créer une nouvelle.
async function findRecentUnshippedDeal(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  try {
    const r = await egrowPost('/deal/getStageDeals.php', { search: digits, page: 1, limit: 10 });
    const deals = Array.isArray(r) ? r : (r && r.data) || [];
    const phoneMatch = (d) => {
      const dp = String((d.contact && d.contact.phone) || (d.deal_phone) || '').replace(/\D/g, '');
      return dp && (dp === digits || dp.endsWith(digits) || digits.endsWith(dp));
    };
    const matched = deals.filter(phoneMatch);
    // Retourner le premier deal avant_envoi (pas encore expédié)
    return matched.find((d) => {
      const stageId = d.stage && d.stage.id;
      return STAGE_CAT[stageId] === 'avant_envoi';
    }) || null;
  } catch (e) { return null; }
}
// Ajoute des produits à un deal eGrow existant (avant envoi).
async function addProductsToExistingDeal(existingDeal, order) {
  const existingProducts = Array.isArray(existingDeal.products) ? existingDeal.products : [];
  const items = Array.isArray(order.products) && order.products.length > 0
    ? order.products
    : [{ product: order.product, size: order.size, color: order.color, quantity: order.quantity }];

  const newProductList = [];
  let addedValue = 0;
  const matchedNames = [];

  for (const item of items) {
    const prods = await egrowSearchProduct(item.product);
    const want = normTxt(item.product);
    const wantDistinct = want.split(' ').filter((w) => w.length > 2 && !PROD_GENERIC.has(w));
    const wantCat = [...PROD_CATEGORY].find((ch) => want.split(' ').includes(ch));
    let p = prods.find((x) => normTxt(x.name) === want);
    if (!p) {
      const cand = prods.map((x) => { const nx = normTxt(x.name); return { x, dist: wantDistinct.filter((w) => nx.includes(w)).length, catOk: !wantCat || nx.includes(wantCat) }; }).filter((c) => c.dist >= 1 && c.catOk).sort((a, b) => b.dist - a.dist);
      if (cand.length) p = cand[0].x;
    }
    if (!p) {
      const candR = prods.map((x) => { const nx = normTxt(x.name); return { x, dist: wantDistinct.filter((w) => nx.includes(w)).length }; }).filter((c) => c.dist >= 1).sort((a, b) => b.dist - a.dist);
      if (candR.length) p = candR[0].x;
    }
    if (!p) {
      p = prods[0] ? Object.assign({}, prods[0], { name: item.product }) : { id: 0, name: item.product, price: '329', sku: '' };
    }
    const qty = Math.max(1, parseInt(item.quantity || 1, 10) || 1);
    let combId2 = '', combPrice2 = parseFloat(p.price) || 0;
    if (item.size && Array.isArray(p.combinations) && p.combinations.length) {
      const su = String(item.size).toUpperCase().trim();
      const mc = p.combinations.find((c) => String(c.name || '').toUpperCase().trim() === su);
      if (mc) { combId2 = String(mc.id); if (mc.price) combPrice2 = parseFloat(mc.price) || combPrice2; }
    }
    addedValue += combPrice2 * qty;
    const pe = Object.assign({}, p, { quantity: qty, size: item.size || '', option: item.size || '' });
    if (combId2) pe.combination = combId2;
    newProductList.push(pe);
    matchedNames.push(`${qty}x ${p.name}${item.size ? ' taille ' + item.size : ''}`);
  }

  const mergedProducts = [...existingProducts, ...newProductList];
  const newTotal = (parseFloat(existingDeal.deal_value) || 0) + addedValue;
  const existingContactId = (existingDeal.contact && existingDeal.contact.id) || existingDeal.contact_id || null;

  const body = {
    id: existingDeal.id,
    deal_city: existingDeal.deal_city || '', country: 'MA',
    deal_address: existingDeal.deal_address || '',
    deal_apartment: '', deal_province: '', deal_zip: '', deal_area: '', deal_street_name: '', deal_house_number: '', deal_nearest_place: '', deal_location: '', deal_district: '',
    deal_customer_name: existingDeal.deal_customer_name || (existingDeal.contact && existingDeal.contact.name) || '',
    deal_phone: existingDeal.deal_phone || (existingDeal.contact && existingDeal.contact.phone) || '',
    deal_payment_method: 'Cash on Delivery (COD)', payment_status: 'pending',
    deal_shipping_price: 0, deal_shipping: null,
    contact_id: existingContactId,
    type: 'deal', title: existingDeal.title || '',
    deal_value: newTotal,
    deal_currency: { id: 153, name: 'Dirham', code: 'MAD', symbol: 'MAD' },
    deal_custom_fields: (() => {
      let cf = {};
      try { cf = JSON.parse(existingDeal.deal_custom_fields || '{}'); } catch (e) {}
      const existingCount = Object.keys(cf).filter(k => /^item_\d+_maillot$/.test(k)).length;
      newProductList.forEach((prod, idx) => {
        const i = existingCount + idx + 1;
        const item = items[idx];
        cf[`item_${i}_maillot`] = item.size ? `${prod.name} - ${item.size}` : prod.name;
        const fl = item.flocage;
        if (fl && fl.name) cf[`item_${i}_name`] = fl.name;
        if (fl && fl.number) cf[`item_${i}_numero`] = String(fl.number);
      });
      return JSON.stringify(cf);
    })(),
    products: JSON.stringify(mergedProducts),
    pipeline_stage: (existingDeal.stage && existingDeal.stage.id) || STAGE_CONFIRM,
    close_date: 0, deal_number: existingDeal.deal_number || '', deal_tracking_number: existingDeal.deal_tracking_number || '',
    users: '[]', do_not_update_assigned: false, shipping_user_connection: 0,
  };

  const res = await egrowPost('/deal/add_or_update_deal.php', body);
  return {
    ok: !!(res && res.status === 'success'),
    dealId: existingDeal.id,
    product: matchedNames.join(' + '),
    qty: newProductList.reduce((s, p) => s + (p.quantity || 1), 0),
    value: addedValue,
    existingDealNumber: existingDeal.deal_number || String(existingDeal.id),
  };
}
// Catégorie d'une étape de pipeline eGrow → pour le suivi de commande.
const STAGE_CAT = (() => {
  const m = {};
  // LIVRÉE (reçue par le client)
  [49152, 49214, 49209, 49210].forEach((id) => (m[id] = 'livree'));                                  // Livrer / Recu / Payé / Facturé
  // ⚠️ EXPÉDIÉE / EN ROUTE = UNIQUEMENT à partir du RAMASSAGE (le colis est physiquement parti chez le livreur).
  //    « Success Ozone » / « Failed Ozone » NE sont PAS « expédiée » (c'est juste la création du colis chez Ozone).
  [49213, 49151, 49199, 49200, 49201, 49202].forEach((id) => (m[id] = 'en_route'));                  // Ramassé / Expédier / Mise en distribution / En cours / Reporté / Pas de réponse
  // PAS ENCORE EXPÉDIÉE : confirmation, traitement, créé chez Ozone mais PAS encore ramassé.
  [49147, 62357, 49148, 49396, 63093, 53444, 51500, 60599, 55207, 49397, 63095, 60669, 49430, 49431,
    49150, 49197, 49154, 49155, 49212, 49211].forEach((id) => (m[id] = 'avant_envoi'));              // En attente/relances/Traiter/Attente ramassage/Success Ozone/Failed Ozone/Erreur Ozone/Nouveau Colis/Rupture
  // ANNULÉE / RETOUR
  [49149, 49153, 49205, 49206, 49265, 60359, 59765].forEach((id) => (m[id] = 'annulee_retour'));     // Annuler Wtsp / Retourner / Retour agence / Retour reçu / Annuler Ozone / Annuler autres / Annuler pas de réponse
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
    return res || "⚠️ CATALOGUE VIDE — 0 résultat Shopify pour cette recherche. INSTRUCTIONS OBLIGATOIRES : (1) NE DIS JAMAIS au client « pas disponible », « pas en stock », « on ne l'a pas » ou « ça ne ressort pas dans le catalogue » — ce produit peut exister dans notre dépôt sans être listé en ligne. (2) Si le client cherche un produit PRÉCIS (équipe + type identifiés, ex : maillot Raja, Maroc rétro 1990, kit Wydad) → marque OBLIGATOIREMENT intent='escalate' avec note : « Client cherche [décrire le produit exact] — vérifier dispo en dépôt ». Dis au client : « Je transmets à notre équipe pour vérifier ça directement avec toi 🙏 ». (3) Si la demande est vague (juste une équipe ou une catégorie) → partage la page collection correspondante depuis NOS PAGES. Ne dis JAMAIS au client que le résultat de ta recherche était vide.";
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
// ── STOCK WAITLIST — sauvegarde en Supabase ──
async function saveStockWaitlist(phone, order) {
  try {
    await fetch(`${SB_URL}/rest/v1/stock_waitlist`, {
      method: 'POST',
      headers: Object.assign({}, supabaseHeaders(true), { 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates' }),
      body: JSON.stringify({
        phone: String(phone || ''),
        name: String(order.customer_name || ''),
        product_name: String(order.product || ''),
        size: String(order.size || ''),
        city: String(order.city || ''),
      }),
    });
  } catch (e) { /* non bloquant */ }
}

async function createOrderDeal(order, contactId) {
  // Support multi-product orders via order.products array
  const items = Array.isArray(order.products) && order.products.length > 0
    ? order.products
    : [{ product: order.product, size: order.size, color: order.color, quantity: order.quantity }];

  const productList = [];
  let value = 0;
  const matchedNames = [];

  for (const item of items) {
    const prods = await egrowSearchProduct(item.product);
    // Si eGrow ne trouve rien, on continue : Niveau 3 crée le deal quand même avec le nom du produit dans les notes.
    // L'opératrice voit la commande et peut compléter manuellement. JAMAIS de commande perdue silencieusement.
    const want = normTxt(item.product);
    // GARDE-FOU MATCH : le produit choisi doit (a) être de la même CATÉGORIE et (b) partager ≥1 mot DISTINCTIF.
    const wantDistinct = want.split(' ').filter((w) => w.length > 2 && !PROD_GENERIC.has(w));
    const wantCat = [...PROD_CATEGORY].find((ch) => want.split(' ').includes(ch));
    let p = prods.find((x) => normTxt(x.name) === want);
    if (!p) {
      // Niveau 1 : catégorie présente dans le nom (includes, pas split) + ≥1 mot distinctif
      const cand = prods
        .map((x) => { const nx = normTxt(x.name); return { x, dist: wantDistinct.filter((w) => nx.includes(w)).length, catOk: !wantCat || nx.includes(wantCat) }; })
        .filter((c) => c.dist >= 1 && c.catOk)
        .sort((a, b) => b.dist - a.dist);
      if (cand.length) { p = cand[0].x; }
    }
    if (!p) {
      // Niveau 2 : juste ≥1 mot distinctif (sans exiger la catégorie dans le nom eGrow)
      const candR = prods
        .map((x) => { const nx = normTxt(x.name); return { x, dist: wantDistinct.filter((w) => nx.includes(w)).length }; })
        .filter((c) => c.dist >= 1)
        .sort((a, b) => b.dist - a.dist);
      if (candR.length) { p = candR[0].x; }
    }
    if (!p) {
      // Niveau 3 : aucun produit eGrow trouvé → commande créée quand même avec le nom dans les notes
      // On utilise le premier résultat de la recherche comme support de prix (ou prix par défaut 329)
      p = prods[0] ? Object.assign({}, prods[0], { name: item.product }) : { id: 0, name: item.product, price: '329', sku: '' };
    }
    const qty = Math.max(1, parseInt(item.quantity || 1, 10) || 1);
    // Trouver la bonne combinaison (variante taille) pour que eGrow affiche la taille correctement
    // eGrow attend `combination: id_variante` pour afficher la taille dans la commande
    let combinationId = '';
    let priceFromComb = parseFloat(p.price) || 0;
    if (item.size && Array.isArray(p.combinations) && p.combinations.length) {
      const sizeUpper = String(item.size).toUpperCase().trim();
      const match = p.combinations.find((c) => String(c.name || '').toUpperCase().trim() === sizeUpper);
      if (match) {
        combinationId = String(match.id);
        if (match.price) priceFromComb = parseFloat(match.price) || priceFromComb;
      }
    }
    const price = priceFromComb;
    value += price * qty;
    const prodEntry = Object.assign({}, p, { quantity: qty, size: item.size || '', option: item.size || '' });
    if (combinationId) prodEntry.combination = combinationId;
    productList.push(prodEntry);
    matchedNames.push(`${qty}x ${p.name}${item.size ? ' taille ' + item.size : ''}`);
  }

  // FLOCAGE : par article (multi-produit) ou global (produit unique)
  let flocageNote = '';
  const perItemFlocages = items.map((item, idx) => (item.flocage && (item.flocage.name || item.flocage.number)) ? { label: matchedNames[idx], flocage: item.flocage } : null).filter(Boolean);
  const globalFl = order.flocage;
  const hasGlobalFl = perItemFlocages.length === 0 && globalFl && (globalFl.name || globalFl.number);
  const totalFlocageQty = perItemFlocages.length > 0 ? perItemFlocages.length : (hasGlobalFl ? items.reduce((s, i) => s + Math.max(1, parseInt(i.quantity || 1, 10) || 1), 0) : 0);
  if (totalFlocageQty > 0) {
    try {
      const fres = await egrowSearchProduct('Flocage');
      const fp = (fres || []).find((x) => /flocage/i.test(x.name || ''));
      if (fp) {
        productList.push(Object.assign({}, fp, { quantity: totalFlocageQty }));
        value += (parseFloat(fp.price) || 99) * totalFlocageQty;
      }
    } catch (e) {}
    if (perItemFlocages.length > 0) {
      // Flocages distincts par maillot
      flocageNote = ` | FLOCAGES (${totalFlocageQty}x) : ` + perItemFlocages.map((f) => `${f.label} → ${[f.flocage.name, f.flocage.number].filter(Boolean).join(' ')}`).join(' / ');
    } else {
      flocageNote = ` | FLOCAGE (${totalFlocageQty}x): ${[globalFl.name, globalFl.number].filter(Boolean).join(' ')}`;
    }
  }

  const isMulti = items.length > 1;
  const totalQty = items.reduce((s, i) => s + Math.max(1, parseInt(i.quantity || 1, 10) || 1), 0);
  const productSummary = matchedNames.join(' + ');
  const dealTitle = isMulti
    ? `${order.customer_name || ''} - ${items.length} maillots`.slice(0, 120)
    : `${order.customer_name || ''} - ${productList[0].name}`.slice(0, 120);

  // Custom fields structurés — format natif eGrow : item_N_maillot / item_N_name / item_N_numero
  const customFieldsObj = {};
  items.forEach((item, idx) => {
    const i = idx + 1;
    const egrowName = (productList[idx] && productList[idx].name) || item.product;
    customFieldsObj[`item_${i}_maillot`] = item.size ? `${egrowName} - ${item.size}` : egrowName;
    const fl = item.flocage || (hasGlobalFl && idx === 0 ? globalFl : null);
    if (fl && fl.name) customFieldsObj[`item_${i}_name`] = fl.name;
    if (fl && fl.number) customFieldsObj[`item_${i}_numero`] = String(fl.number);
  });
  // Note additionnelle : info supplémentaire seulement (couleur, remarque client)
  const additionalNote = [
    order.color ? `Couleur: ${order.color}` : null,
    order.notes ? order.notes : null,
  ].filter(Boolean).join(' | ');
  if (additionalNote) customFieldsObj.note = additionalNote;

  const body = {
    id: 0, label: '', source: 'agent-ia-whatsapp',
    deal_city: order.city || '', country: 'MA', deal_address: order.address || '',
    deal_apartment: '', deal_province: '', deal_zip: '', deal_area: '', deal_street_name: '', deal_house_number: '', deal_nearest_place: '', deal_location: '', deal_district: '',
    deal_customer_name: order.customer_name || '',
    deal_phone: String(order.phone || '').replace(/\D/g, ''),
    deal_payment_method: 'Cash on Delivery (COD)', payment_status: 'pending',
    deal_shipping_price: 0, deal_shipping: null,
    contact_id: contactId, type: 'deal', title: dealTitle,
    deal_value: value, deal_currency: { id: 153, name: 'Dirham', code: 'MAD', symbol: 'MAD' },
    deal_custom_fields: JSON.stringify(customFieldsObj),
    products: JSON.stringify(productList),
    pipeline_stage: order.waiting_stock && STAGE_STOCK_WAIT ? STAGE_STOCK_WAIT : STAGE_CONFIRM, close_date: 0, deal_number: '', deal_tracking_number: '',
    users: '[]', do_not_update_assigned: false, shipping_user_connection: 0,
  };
  const res = await egrowPost('/deal/add_or_update_deal.php', body);
  const dealId = (res && res.deal && res.deal.id) || null;
  const price = isMulti ? 0 : (parseFloat(productList[0].price) || 0);
  return { ok: !!(res && res.status === 'success'), dealId, product: productSummary, price, qty: totalQty, value, flocageNote, hasFlocage: !!flocageNote };
}
async function addDealNote(dealId, content) {
  try { return await egrowPost('/notes/add_or_update_note.php', { id: 0, content: String(content).slice(0, 1200), type: 'deal', context: dealId, color: '' }); } catch (e) { return null; }
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
// On distingue par le TEXTE (fiable) : on mémorise le contenu de chaque message envoyé par le bot (table agent_sent).
// Un message sortant dont le texte NE correspond À AUCUN envoi récent du bot = écrit par un humain.
function normBody(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160); }
// Enregistre un message que le bot vient d'envoyer (texte normalisé + id si dispo, sinon id synthétique unique).
async function markBotSent(convId, integrationId, sendRes, bodyText) {
  try {
    let id = '';
    const cands = [sendRes && sendRes.id, sendRes && sendRes.messageId,
      sendRes && sendRes.data && (sendRes.data.id || sendRes.data.messageId || (sendRes.data.message && sendRes.data.message.id))];
    for (const c of cands) { if (c) { id = String(c); break; } }
    if (!id) id = String(convId) + '#' + Date.now(); // id synthétique : on s'appuie de toute façon sur le TEXTE
    await fetch(`${SB_URL}/rest/v1/agent_sent`, {
      method: 'POST',
      headers: Object.assign({}, supabaseHeaders(true), { 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates' }),
      body: JSON.stringify({ msg_id: id, conv_id: String(convId), body: normBody(bodyText) }),
    });
  } catch (e) {}
}
// Récupère les envois récents DU BOT pour une conversation (≤ ~2h) → { ids:Set, bodies:Set }.
async function recentBotSent(convId) {
  const res = { ids: new Set(), bodies: new Set() };
  try {
    const sinceIso = new Date(Date.now() - 7200000).toISOString(); // 2h
    const r = await fetch(`${SB_URL}/rest/v1/agent_sent?select=msg_id,body,sent_at&conv_id=eq.${encodeURIComponent(String(convId))}&sent_at=gte.${encodeURIComponent(sinceIso)}`, { headers: supabaseHeaders(true) });
    const j = await r.json().catch(() => []);
    if (Array.isArray(j)) j.forEach((row) => { if (row.msg_id) res.ids.add(String(row.msg_id)); if (row.body) res.bodies.add(String(row.body)); });
  } catch (e) {}
  return res;
}
// Un HUMAIN gère-t-il la conversation ? (= message sortant récent <1h30 dont le texte n'est PAS un envoi du bot).
function humanHandling(raw, nowSec, botSent, contactWaId) {
  const HUMAN_TYPES = ['text', 'image', 'audio', 'voice', 'ptt', 'video', 'document'];
  const contact = String(contactWaId || '').replace(/\D/g, '');
  const outRecent = (raw || [])
    // SORTANT (côté business) = mine=true OU expéditeur ≠ client (senderWaId).
    // Le senderWaId couvre les réponses envoyées depuis l'APP WhatsApp du téléphone de l'équipe
    // (pas seulement depuis l'interface eGrow) — sans lui, ces messages humains passaient inaperçus et le bot répondait par-dessus.
    .filter((m) => {
      if (!m || !HUMAN_TYPES.includes(String(m.type || ''))) return false;
      const sw = String(m.senderWaId || '').replace(/\D/g, '');
      return (m.mine === true || m.mine === 'true') || (sw && contact && sw !== contact);
    })
    .map((m) => ({ id: String(m.id || ''), body: normBody(m.body || (m.content && m.content.body) || ''), at: parseInt(m.sentAt || m.createdAt || m.timestamp || m.time || '0', 10) }))
    .filter((m) => m.at && (nowSec - m.at) <= HUMAN_HANDOVER_SEC);
  if (!outRecent.length) return false;
  // "humain" = un sortant récent qui n'est NI un id connu du bot NI un texte connu du bot.
  // (un message sortant SANS texte — média envoyé par l'humain — compte aussi comme humain s'il n'est pas un id du bot)
  return outRecent.some((m) => !botSent.ids.has(m.id) && !(m.body && botSent.bodies.has(m.body)));
}

// Recherche catalogue Shopify (cache Supabase) selon la demande → bloc dispo en direct à injecter.
const CATALOG_STOPWORDS = new Set('taille tailles size prix combien chhal taman bghit bghi bghyt veux voudrais cherche dispo disponible disponibles bonjour salam salut svp stp merci pour avec est une des les dans vous tu je oui non ok cest quoi autre meme original foot football equipe club saison commande commander acheter chri photo photos couleur couleurs livraison aujourd hui parfait prends prend piece pieces standard mon complet nom adresse ville rue confirme maintenant article articles nombre quantite bien donc alors voila moi prendre prenez prendrai numero tel chi 3ndkom 3ndkoum dial wach ash kayn avez avoir avez-vous propose proposez proposes vend vends vendez vendre fait faites donne donnez montre montrez envoie envoyez trouve trouvez regarde vois voir sur ce cette ces ton tes mes son ses mais que qui comme plus tres beaucoup aussi encore deja juste vraiment chez peux peut pouvez avait gout touni tola wrini werri werrini wri chof chouf nchouf chno chnou chnu chenou achno ach kayna kaynin tswira tswera tsawer tsewira liya lia ndir nbghi kanbghi rani rani bghyti bghiti baghi smiti smiti 3afak afak 3afak khoya sahbi wakha wakhaa walakin walayni'.split(' '));
// Mots de CATÉGORIE : gardés (le client peut chercher une catégorie), mais on privilégie un mot spécifique (équipe) s'il y en a un.
const CATEGORY_WORDS = new Set('maillot maillots kit kits ensemble ensembles survetement survetements casquette casquettes ballon ballons short shorts chaussette chaussettes accessoire accessoires gourde'.split(' '));
// Modificateurs génériques : souvent PAS dans le titre exact du produit → on les retire de la REQUÊTE (sinon la recherche
// AND de Shopify renvoie 0), mais on les garde pour le SCORE (départager les modèles, ex: la version "blanc").
// Les COULEURS sont incluses : "raja vert" → query "raja" (pas "raja vert" qui échouerait si "vert" absent du titre).
const GENERIC_MODIFIERS = new Set('retro retros vintage classic classique version versions edition editions speciale special collector authentique modele modeles tenue tenues saison nouvelle nouveau neuf neuve domicile exterieur exterieure third vert rouge blanc noir bleu jaune orange violet rose gris marron bordeaux kaki dore dore argent beige marine khdra lkhdra kahla lkahla byda lbyda hamra lhamra zrqa lzrqa'.split(' '));
// Synonymes / surnoms → terme présent dans les titres Shopify
const CATALOG_SYNONYMS = { barca: 'barcelon', barsa: 'barcelon', barcaa: 'barcelon', psg: 'paris', real: 'madrid', juve: 'juventus', mancity: 'manchester', manu: 'manchester', citizens: 'manchester', bayern: 'bayern', intermilan: 'milan', wac: 'wydad', wydadi: 'wydad', rajaoui: 'raja', kora: 'ballon', koura: 'ballon', balon: 'ballon', kaskita: 'casquette', training: 'entrainement', survet: 'survetement', short: 'short', chaussette: 'chaussette',
  // darija : kitma / jogging / survêt = survêtement (tracksuit), pas un kit maillot+short
  kitma: 'survetement', jogging: 'survetement', tracksuit: 'survetement', survetements: 'survetement',
  // pays / surnoms fréquents (darija incluse) → terme présent dans les titres Shopify
  brazil: 'bresil', brasil: 'bresil', lbrazil: 'bresil', lbresil: 'bresil', bresil: 'bresil', selecao: 'bresil', argentine: 'argentin', lmaghrib: 'maroc', maghrib: 'maroc', morocco: 'maroc', allemagne: 'allemagne', mancunian: 'manchester', reds: 'liverpool', citoyens: 'manchester' };

// Collections Shopify (page équipe/catégorie) — mises en cache mémoire (chaud) ~1h
let _cols = null, _colsAt = 0;
// Une collection montre-t-elle AU MOINS 1 produit au CLIENT (storefront) ? — évite d'envoyer un lien vide
// (ex: nike-t-shirt / flash : publiées en admin mais 0 produit visible côté client → page vide).
async function collectionHasStorefrontProducts(handle) {
  try {
    const r = await fetch(`https://touni.ma/collections/${encodeURIComponent(handle)}/products.json?limit=1`, { headers: { 'User-Agent': EGROW_UA }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return true; // fail-open : on ne perd pas une collection sur une erreur réseau
    const j = await r.json().catch(() => null);
    if (!j || !Array.isArray(j.products)) return true;
    return j.products.length > 0;
  } catch (e) { return true; }
}
async function getCollections() {
  if (_cols && (Date.now() - _colsAt) < 3600000) return _cols;
  let candidates = [];
  // 1) Collections PUBLIÉES + non vides (GraphQL) — exclut déjà les brouillons et les collections à 0 produit.
  try {
    const gql = 'query { collections(first: 250, query: "published_status:published") { edges { node { handle title productsCount { count } } } } }';
    const gr = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST', headers: Object.assign({}, await shopifyAdminHeaders(), { 'Content-Type': 'application/json' }), body: JSON.stringify({ query: gql }),
    });
    const gj = await gr.json().catch(() => ({}));
    const edges = (gj.data && gj.data.collections && gj.data.collections.edges) || [];
    candidates = edges.map((e) => e.node).filter((n) => n && n.handle && (!n.productsCount || n.productsCount.count > 0)).map((n) => ({ title: n.title || '', handle: n.handle }));
  } catch (e) {}
  // Fallback REST si GraphQL échoue
  if (!candidates.length) {
    try {
      for (const ep of ['custom_collections', 'smart_collections']) {
        const cr = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/${ep}.json?limit=250&fields=id,title,handle`, { headers: await shopifyAdminHeaders() });
        const cj = await cr.json().catch(() => ({}));
        (cj[ep] || []).forEach((c) => { if (c.handle) candidates.push({ title: c.title || '', handle: c.handle }); });
      }
    } catch (e) {}
  }
  // 2) VÉRITÉ STOREFRONT : ne garder que les collections qui montrent ≥1 produit AU CLIENT (sinon lien vide).
  let out = candidates;
  try {
    const checks = await Promise.all(candidates.map((c) => collectionHasStorefrontProducts(c.handle).then((ok) => (ok ? c : null))));
    const filtered = checks.filter(Boolean);
    if (filtered.length) out = filtered;
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
// Télécharge une image WhatsApp de façon ROBUSTE. eGrow ré-héberge normalement le
// média sur son CDN public (cdn5.egrow.com). Si l'URL directe échoue (média pas
// encore ré-hébergé au moment du poll, URL Meta expirée, page d'erreur renvoyée à
// la place des octets…), on retombe sur l'API officielle Meta Graph via l'ID du
// média (URL fraîche signée + token). Valide que ce sont bien des octets d'image
// (magic bytes) pour ne jamais envoyer une page d'erreur à la vision. Retourne
// {base64, mime} ou null, et journalise l'échec pour diagnostic.
function _detectImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
async function fetchWaImage(b) {
  const MAX = 4000000; // garde-fou coût/limite vision
  const tryUrl = async (url, withToken) => {
    try {
      const headers = { 'User-Agent': EGROW_UA };
      if (withToken && META_WA_TOKEN) headers.Authorization = 'Bearer ' + META_WA_TOKEN;
      const r = await fetch(url, { headers });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length >= MAX) return null;
      const mime = _detectImageMime(buf); // magic bytes → mime FIABLE pour l'API vision
      if (!mime) return null;              // pas une image (page HTML/JSON d'erreur, octet-stream vide…)
      return { base64: buf.toString('base64'), mime };
    } catch (e) { return null; }
  };
  const isMetaHost = /lookaside\.fbsbx|whatsapp\.net|graph\.facebook/i.test(b.url || '');
  // 1) URL directe (CDN eGrow = public ; host Meta = nécessite le token)
  let out = b.url ? await tryUrl(b.url, isMetaHost) : null;
  // 2) Fallback officiel Meta : media-id → URL fraîche → fetch avec token
  if (!out && b.id && META_WA_TOKEN) {
    try {
      const mr = await fetch('https://graph.facebook.com/v21.0/' + encodeURIComponent(b.id), { headers: { Authorization: 'Bearer ' + META_WA_TOKEN } });
      const mj = await mr.json().catch(() => ({}));
      if (mj && mj.url) out = await tryUrl(mj.url, true);
    } catch (e) {}
  }
  if (!out) console.warn('[vision] image non téléchargée', JSON.stringify({ url: String(b.url || '').slice(0, 90), id: b.id || '', hasMetaToken: !!META_WA_TOKEN }));
  return out;
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
    // RÈGLE CLEF : dans la requête Shopify on n'injecte QUE le terme RÉSOLU (jamais l'alias brut du client).
    // Ex : "lmaghrib" → queryTermSet = {"maroc"} (pas {"lmaghrib","maroc"} qui ferait échouer le AND Shopify).
    const queryTermSet = new Set();
    const scoreTermSet = new Set();
    for (const t of toks) {
      scoreTermSet.add(t);
      const resolved = CATALOG_SYNONYMS[t];
      if (resolved) {
        queryTermSet.add(resolved);
        scoreTermSet.add(resolved);
      } else {
        queryTermSet.add(t);
      }
      if (t.length > 4 && /[sx]$/.test(t)) {
        const sing = t.slice(0, -1);
        const singRes = CATALOG_SYNONYMS[sing];
        if (singRes) { queryTermSet.add(singRes); scoreTermSet.add(singRes); }
        else { queryTermSet.add(sing); scoreTermSet.add(sing); }
      }
    }
    const searchTerms = [...scoreTermSet];
    // Recherche FULL-TEXT Shopify, termes séparés par ESPACE (≈ AND, insensible aux accents : "bresil" trouve "Brésil").
    // On retire les modificateurs génériques (retro, version, couleurs…) de la requête pour éviter les AND qui échouent.
    // Ex : "raja vert" → queryTerms = ["raja"] ; "lmaghrib 1990" → queryTerms = ["maroc","1990"]
    const queryTerms = [...queryTermSet].filter((t) => !GENERIC_MODIFIERS.has(t));
    const qstr = (queryTerms.length ? queryTerms : [...queryTermSet]).join(' ');
    // inventoryManagement: SHOPIFY = suivi (quantité réelle) ; NOT_MANAGED = non-suivi = TOUJOURS disponible même à 0.
    const gql = 'query($q:String!){ products(first:40, query:$q){ edges{ node{ title handle status variants(first:25){ edges{ node{ title price inventoryQuantity inventoryManagement } } } } } } }';
    const doShopifySearch = async (q) => {
      try {
        const gr = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: Object.assign({}, await shopifyAdminHeaders(), { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ query: gql, variables: { q } }),
        });
        const gj = await gr.json().catch(() => ({}));
        return ((gj.data && gj.data.products && gj.data.products.edges) || []).map((e) => e.node);
      } catch (e) { return []; }
    };
    let products = await doShopifySearch(qstr);
    // Fallback : 0 résultat + query multi-termes → réessayer avec le terme le plus long (souvent l'équipe/club)
    if (!products.length && queryTerms.length > 1) {
      const fallback = queryTerms.reduce((a, b) => b.length > a.length ? b : a, queryTerms[0]);
      products = await doShopifySearch(fallback);
    }
    // garder UNIQUEMENT les produits ACTIFS avec au moins une taille en stock (live), classés par pertinence
    const SIZE_RE = /\b(XS|S|M|L|XL|XXL|2XL|3XL|4XL)\b/i;
    const scored = products.map((p) => { const nt = normTxt(p.title); return { p, score: searchTerms.filter((w) => nt.indexOf(w) !== -1).length }; }).sort((a, b) => b.score - a.score);
    const lines = [];
    for (const { p, score } of scored) {
      if (lines.length >= 6) break;
      if (score < 1) continue;           // le terme doit être dans le TITRE (full-text peut ramener des produits où le mot n'est que dans la description)
      if (p.status !== 'ACTIVE') continue; // pas de brouillon/archivé
      // FIX CRITIQUE : un produit non-suivi (NOT_MANAGED) a inventoryQuantity=0 dans l'API
      // mais est TOUJOURS disponible à la vente. Ne filtrer comme "épuisé" que les produits
      // SUIVIS (SHOPIFY) avec stock réel = 0. Les non-suivis passent toujours.
      const avail = ((p.variants && p.variants.edges) || []).map((e) => e.node).filter((v) =>
        v.inventoryManagement !== 'SHOPIFY' || Number(v.inventoryQuantity) > 0
      );
      if (!avail.length) continue; // rien en stock (seulement les produits suivis à 0)
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

        // ── RATTRAPAGE NOTIFICATIONS : l'opératrice ou le patron viennent de répondre → fenêtre ouverte ──
        const _digits = contactWaId.replace(/\D/g, '');
        if (OPERATOR_PHONES.includes(_digits)) {
          // Opératrice : resend ses notifs en attente, puis skip (pas de réponse client)
          const _count = !dry ? await resendPendingNotifications(integrationId, _digits) : 0;
          if (!dry && _count > 0) {
            try { await egrowSend(integrationId, _digits, `✅ ${_count} notification${_count > 1 ? 's rattrapées' : ' rattrapée'} — fenêtre ouverte.`); } catch (e) {}
          }
          if (claimedMsgId) { await releaseClaim(claimedMsgId); claimedMsgId = null; }
          results.push({ conv: c.id, phone: contactWaId, decision: 'operator_catchup', caught_up: _count });
          processed++; continue;
        }
        if (_digits === MERCHANT_PHONE) {
          // Patron : rattrapage silencieux avant de continuer en mode patron normal
          if (!dry) await resendPendingNotifications(integrationId, MERCHANT_PHONE);
          // Clic bouton template (ex: "OK" sur morning ping) → fenêtre ouverte, mais pas de réponse bot
          if (isButtonMsg) {
            if (claimedMsgId) { await releaseClaim(claimedMsgId); claimedMsgId = null; }
            results.push({ conv: c.id, phone: contactWaId, decision: 'merchant_button_ack' });
            processed++; continue;
          }
        }
        // ────────────────────────────────────────────────────────────────────────────────────────────────

        // Messages récents de la conv (sert aux PHOTOS multiples, à l'historique, au handover) — un seul appel.
        let raw = [];
        try { raw = await egrowGetMessages(c.id, HISTORY_LIMIT); } catch (e) {}

        // Photo(s) entrante(s) → base64 pour Claude Vision. Le client peut envoyer PLUSIEURS produits d'un coup → on prend la RAFALE.
        let images = [];
        if (isImage) {
          const burst = []; // rafale de photos du client en tête (messages les plus récents, mine=false, type image)
          for (const m of raw) {
            const mine = (m.mine === true || m.mine === 'true');
            if (mine) break;                                   // un message du bot coupe la rafale
            if (String(m.type || '') !== 'image') { if (burst.length) break; else continue; }
            const u = (m.content && m.content.url) || '';
            if (u) burst.push({ url: u, mime: (m.content && m.content.mime_type) || 'image/jpeg', id: (m.content && m.content.id) || '' });
            if (burst.length >= 4) break;                      // garde-fou coût (max 4 photos)
          }
          if (!burst.length) { const u = (lm.content && lm.content.url) || ''; if (u) burst.push({ url: u, mime: (lm.content && lm.content.mime_type) || 'image/jpeg', id: (lm.content && lm.content.id) || '' }); }
          for (const b of burst.reverse()) {                   // ordre chronologique (ancienne → récente)
            const img = await fetchWaImage(b);                 // download robuste (CDN eGrow + fallback Meta media-id + validation)
            if (img) images.push(img);
          }
          if (!images.length) { await releaseClaim(msgId); continue; }
        }
        const imageBase64 = images[0] ? images[0].base64 : null; // rétro-compat (1ʳᵉ image)
        const imageMime = images[0] ? images[0].mime : null;
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
        try {
          history = (raw || [])
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

        // Envois récents DU BOT pour cette conv (sert au handover ET à l'anti-doublon avant envoi).
        const botSent = await recentBotSent(c.id);

        // HANDOVER HUMAIN : si un humain (opératrice) gère déjà cette conv (a répondu < 1h30), le bot se TAIT et laisse l'humain.
        // (ne s'applique PAS au numéro du marchand = assistant patron, lui répond toujours).
        const _isMerchantHere = MERCHANT_PHONE && contactWaId.replace(/\D/g, '') === MERCHANT_PHONE;
        if (!_isMerchantHere) {
          let humanActive = false;
          try { humanActive = humanHandling(raw, nowSec, botSent, contactWaId); } catch (e) {}
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
            catalog: isMerchant ? '' : catalog, collectionsBlock: isMerchant ? '' : collectionsBlock, imageBase64, imageMime, images,
            tools: isMerchant ? MERCHANT_TOOLS : AGENT_TOOLS,
            runTool: isMerchant ? ((n, i) => runMerchantTool(n, i)) : ((n, i) => runAgentTool(n, i, contactWaId)),
            systemOverride: isMerchant ? MERCHANT_SYSTEM : null },
          { bypassTime: bypassTime || isMerchant } // le patron est servi à toute heure
        );
        if (decision && decision.reply) decision.reply = await sanitizeReplyLinks(decision.reply); // anti-lien-cassé
        const entry = { conv: c.id, phone: contactWaId, name: c.title, msgId, body: body.slice(0, 60), decision: decision.skipped || (decision.send ? 'reply' : 'no_send') };
        if (!(decision.send && decision.reply) && !dry) await releaseClaim(msgId); // on ne répond pas (heures ouvrées/bouton) → libère le claim
        // ANTI-DOUBLON : si le bot a DÉJÀ envoyé ce même texte récemment dans cette conv → ne le renvoie pas (évite le message en double).
        if (decision.send && decision.reply && botSent.bodies.has(normBody(decision.reply))) {
          if (!dry && claimedMsgId) { await releaseClaim(claimedMsgId); claimedMsgId = null; }
          entry.decision = 'skip:doublon_meme_texte'; entry.sent = 'skip_duplicate';
          results.push(entry); processed++; continue;
        }
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
            if (sendRes && sendRes.status === 'success') { claimedMsgId = null; await markBotSent(c.id, integrationId, sendRes, decision.reply); } // envoi OK → ne PAS libérer + mémoriser le texte (handover + anti-doublon)
            else await releaseClaim(msgId);                                       // envoi raté → libère pour réessayer au prochain run
            if (isAction && deal && curStage !== target) {
              try {
                const mv = await moveDeal(deal, target);
                entry.dealMove = { deal: deal.id, from: curStage, to: target, ok: mv && mv.status };
              } catch (e) { entry.dealMove = 'err'; }
            } else if (isAction) {
              entry.dealMove = deal ? 'already_there' : 'no_movable_deal';
            }
            // Escalade → prévenir l'opératrice + le patron
            if (decision.intent === 'escalate') {
              const summary = `🔔 *Client à gérer (agent IA Touni)*\n👤 ${c.title || contactWaId}\n📱 ${contactWaId}\n📝 ${(decision.note || '').slice(0, 400) || 'voir la conversation'}\n💬 « ${body.slice(0, 220)} »`;
              for (const _op of OPERATOR_PHONES) {
                try { await sendAndQueue(integrationId, _op, summary); entry.operatorNotified = true; } catch (e) { entry.operatorNotified = 'err'; }
              }
              if (MERCHANT_PHONE && !OPERATOR_PHONES.includes(MERCHANT_PHONE)) {
                try { await sendAndQueue(integrationId, MERCHANT_PHONE, summary); entry.merchantNotified = true; } catch (e) { entry.merchantNotified = 'err'; }
              }
            }
            // Avis positif → patron (comme toujours) ET opératrices e-commerce (collecte / screenshot Insta)
            if (decision.intent === 'review_positive') {
              try {
                const clientName = c.title || contactWaId;
                const isVocalReview = isAudio || type === 'ptt' || type === 'voice';
                const msgType = isVocalReview ? '🎙️ *VOCAL*' : '💬 *Message*';
                const preview = isVocalReview ? '[message vocal]' : (body.slice(0, 200) || '[avis]');
                const notif = `📸 *Avis client positif (à récolter) !*\n👤 ${clientName} (${contactWaId})\n${msgType} : « ${preview} »\n→ Ouvre la conv et fais un screen (ou screen recording si vocal) pour l'Insta 🎬`;
                const reviewTargets = [...OPERATOR_PHONES];
                if (MERCHANT_PHONE && !reviewTargets.includes(MERCHANT_PHONE)) reviewTargets.push(MERCHANT_PHONE);
                for (const _t of reviewTargets) {
                  try { await sendAndQueue(integrationId, _t, notif); } catch (e) {}
                }
                entry.reviewNotified = true;
              } catch (e) { entry.reviewNotified = 'err'; }
            }
            // #3 : prise de commande (nouveau client → crée le deal)
            if (decision.order && (decision.order.product || (Array.isArray(decision.order.products) && decision.order.products.length > 0)) && decision.order.customer_name && decision.order.city) {
              try {
                // Injecter le téléphone WA dans l'order (utile pour le champ note du deal et l'identification)
                if (!decision.order.phone) decision.order.phone = contactWaId;
                // Résoudre le contact eGrow — fallback searchContact, puis création si absent
                let contactId = c.contactId || (c.contact && c.contact.id);
                if (!contactId && contactWaId) {
                  try {
                    const digits = contactWaId.replace(/\D/g, '');
                    const cSearch = await egrowPost('/contact/searchContact.php', { search: digits });
                    // FIX: gérer tous les formats de réponse eGrow (tableau direct, data[], contacts[])
                    const contacts = Array.isArray(cSearch) ? cSearch
                      : (cSearch && Array.isArray(cSearch.data) ? cSearch.data
                      : (cSearch && Array.isArray(cSearch.contacts) ? cSearch.contacts
                      : []));
                    const found = contacts.find((ct) => String(ct.phone || '').replace(/\D/g, '').endsWith(digits.slice(-9)));
                    if (found && found.id) contactId = found.id;
                  } catch (e) { /* search failed, will try create */ }
                }
                // Si toujours pas de contact → créer un nouveau contact eGrow pour que le deal soit bien lié
                if (!contactId && decision.order.customer_name && contactWaId) {
                  try {
                    const nameParts = String(decision.order.customer_name || '').trim().split(/\s+/);
                    const firstName = nameParts[0] || '';
                    const lastName = nameParts.slice(1).join(' ') || '';
                    const cCreate = await egrowPost('/contact/add_or_update_contact.php', {
                      id: 0, type: 'contact', source: 'agent-ia-whatsapp',
                      name: `${firstName} ${lastName}`.trim(),
                      first_name: firstName, last_name: lastName,
                      phone: contactWaId.replace(/\D/g, ''),
                      city: decision.order.city || '', country: 'MA',
                    });
                    // FIX: gérer tous les formats de réponse possibles de eGrow
                    const newId = cCreate && (
                      (typeof cCreate.id === 'number' && cCreate.id > 0 ? cCreate.id : null) ||
                      (cCreate.contact && cCreate.contact.id) ||
                      (cCreate.data && typeof cCreate.data === 'object' && (cCreate.data.id || (cCreate.data.contact && cCreate.data.contact.id)))
                    );
                    if (newId) contactId = newId;
                  } catch (e) { /* non bloquant : deal créé sans contact */ }
                }
                // Vérifier si une commande non-expédiée existe déjà pour ce client → ajouter dessus plutôt que créer un doublon
                const isStockWaitOrder = !!(decision.order && decision.order.waiting_stock);
                let existingDealForAdd = null;
                if (!isStockWaitOrder) {
                  try { existingDealForAdd = await findRecentUnshippedDeal(contactWaId); } catch (e) {}
                }
                let r;
                if (existingDealForAdd) {
                  r = await addProductsToExistingDeal(existingDealForAdd, decision.order);
                  r.isAddition = true;
                } else {
                  r = await createOrderDeal(decision.order, contactId);
                }
                entry.orderCreated = r.ok ? { deal: r.dealId, product: r.product, value: r.value, flocage: r.hasFlocage, addition: !!r.isAddition } : ('fail:' + (r.reason || 'unknown'));
                const o = decision.order;
                if (r.ok) {
                  const isStockWait = isStockWaitOrder;
                  const isMultiProd = Array.isArray(o.products) && o.products.length > 1;
                  const prodDesc = isMultiProd ? r.product : `${r.qty}x ${r.product}${o.size ? ' taille ' + o.size : ''}${o.color ? ' ' + o.color : ''}`;
                  if (r.isAddition) {
                    // Ajout sur commande existante
                    const noteText = `Ajout produit par l'agent IA (WhatsApp). ${prodDesc} ajouté à la commande #${r.existingDealNumber}.`;
                    if (r.dealId) await addDealNote(r.dealId, noteText);
                    const addMsg = `➕ *Ajout sur commande existante (agent IA)*\n👤 ${o.customer_name || c.title || contactWaId} (${contactWaId})\n📦 ${prodDesc} ajouté à commande #${r.existingDealNumber}\n💵 +${r.value} dh`;
                    try { if (MERCHANT_PHONE) await sendAndQueue(integrationId, MERCHANT_PHONE, addMsg); } catch (e) {}
                  } else {
                  const telNote = o.phone || contactWaId;
                  const noteText = isStockWait
                    ? `⏳ EN ATTENTE DE STOCK — prise par l'agent IA. Produit : ${r.product}${o.size ? ' taille ' + o.size : ' (taille non précisée)'}. Client : ${o.customer_name} | Tél WA : ${telNote}${o.city ? ' | Ville : ' + o.city : ''}${o.notes ? ' | Remarque : ' + o.notes : ''}. Notifier dès que le stock revient.`
                    : `Commande prise par l'agent IA (WhatsApp). ${prodDesc}.${r.flocageNote || ''} | Client: ${o.customer_name} | Tél WA : ${telNote} | Adresse: ${o.address || ''}, ${o.city}${o.notes ? ' | Remarque : ' + o.notes : ''} | Confirmer la taille par appel.`;
                  if (r.dealId) await addDealNote(r.dealId, noteText);
                  if (isStockWait) {
                    // Sauvegarder dans la waitlist Supabase pour surveillance automatique du stock
                    await saveStockWaitlist(contactWaId, o);
                    const waitMsg = `📋 *Attente stock (agent IA)*\n👤 ${o.customer_name} (${o.phone || contactWaId})\n📦 ${o.product}${o.size ? ' taille ' + o.size : ' ⚠️ taille non précisée'}${o.notes ? '\n📝 ' + o.notes : ''}\n📍 ${o.city}\n→ créé dans « Rappeler le stock » — notif auto quand dispo`;
                    try { if (MERCHANT_PHONE) await sendAndQueue(integrationId, MERCHANT_PHONE, waitMsg); } catch (e) {}
                  } else {
                  const saleMsg = `💰 *Nouvelle commande (agent IA)*\n👤 ${o.customer_name} (${contactWaId})\n📦 ${prodDesc}${r.flocageNote || ''}\n💵 ${r.value} dh · 📍 ${o.city}\n→ créée dans « Confirmer Wtsp »`;
                  try { if (MERCHANT_PHONE) await sendAndQueue(integrationId, MERCHANT_PHONE, saleMsg); } catch (e) {}
                  }
                  }
                } else {
                  // ÉCHEC de création → on prévient le marchand pour qu'il crée la commande à la main (jamais de commande perdue)
                  const fl = o.flocage && (o.flocage.name || o.flocage.number) ? `\n🖊️ Flocage: ${[o.flocage.name, o.flocage.number].filter(Boolean).join(' ')} (+99dh)` : '';
                  const failProdDesc = Array.isArray(o.products) && o.products.length > 1
                    ? o.products.map((p) => `${p.quantity || 1}x ${p.product}${p.size ? ' (' + p.size + ')' : ''}`).join(' + ')
                    : `${o.quantity || 1}x ${o.product}${o.size ? ' (' + o.size + ')' : ''}${o.color ? ' ' + o.color : ''}`;
                  const failMsg = `⚠️ *Commande à créer manuellement dans eGrow*\n❌ Raison : ${r.reason || 'produit introuvable dans le catalogue'}\n\n👤 *Client :* ${o.customer_name} (${contactWaId})\n📦 *Produit :* ${failProdDesc}${fl}\n📍 *Adresse :* ${o.address || ''}, ${o.city}\n\n👉 *À faire :* Aller dans eGrow → Nouveau deal → saisir ces infos manuellement. Le client a déjà confirmé.`;
                  try { if (MERCHANT_PHONE) await sendAndQueue(integrationId, MERCHANT_PHONE, failMsg); } catch (e) {}
                }
              } catch (e) {
                entry.orderCreated = 'err:' + String(e).slice(0, 80);
                // exception → on prévient quand même le marchand avec ce qu'on a
                try {
                  const o = decision.order; const fl = o.flocage && (o.flocage.name || o.flocage.number) ? `\n🖊️ Flocage: ${[o.flocage.name, o.flocage.number].filter(Boolean).join(' ')}` : '';
                  if (MERCHANT_PHONE) await sendAndQueue(integrationId, MERCHANT_PHONE, `⚠️ *Commande à créer à la main (erreur)*\n👤 ${o.customer_name} (${contactWaId})\n📦 ${o.quantity || 1}x ${o.product}${o.size ? ' (' + o.size + ')' : ''}${fl}\n📍 ${o.address || ''}, ${o.city}`);
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
  // Interrupteur global — BOT_ENABLED=0 dans Vercel pour couper le bot sans toucher au code
  if (process.env.BOT_ENABLED === '0') return res.status(200).json({ ok: true, status: 'bot_disabled' });

  // ── Diagnostic notif opératrice (depuis Vercel, avec le vrai egrowSend) ──
  if (q.diagop === '1') {
    // Teste CHAQUE opératrice : c'est ce qui permet de vérifier qu'une nouvelle recrue
    // reçoit bien les escalades avant de compter dessus.
    const out = [];
    for (const _op of OPERATOR_PHONES) {
      try { out.push({ phone: _op, send_result: await egrowSend(INTEGRATIONS[0] || '5425', _op, '🔔 Test notification opératrice (diagnostic système Touni).') }); }
      catch (e) { out.push({ phone: _op, error: String(e) }); }
    }
    return res.status(200).json({ operator_phones: OPERATOR_PHONES, results: out });
  }

  // ── GET PIPELINE STAGES (endpoint direct) ──
  if (q.get_pipeline_stages === '1') {
    try {
      const r = await egrowPost('/deal/getuserPipeLineStages.php', {});
      return res.status(200).json({ raw: r });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  }

  // ── DEBUG DEAL STRUCTURE ──
  if (q.debug_deal === '1') {
    try {
      const sid = parseInt(q.stage || '49430', 10);
      const limit = parseInt(q.limit || '1', 10);
      const search = q.search || '';
      const r = await egrowPost('/deal/getStageDeals.php', { stage: sid, search, page: 1, limit });
      return res.status(200).json({ sample: r });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  }

  // ── DEBUG CATALOGUE ──
  if (q.catalog_search) {
    try {
      const result = await searchCatalog(String(q.catalog_search));
      return res.status(200).json({ query: q.catalog_search, result });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  }

  // ── CONFIRMER MANUELLEMENT UNE COMMANDE STOCK (confirm_deal) ──
  // ?confirm_deal=1&phone=212724909794&msg=<texte optionnel>
  if (q.confirm_deal === '1') {
    const integrationId = INTEGRATIONS[0] || '5425';
    const phone = String(q.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ error: 'phone requis' });
    try {
      const deal = await findMovableDeal(phone);
      if (!deal) return res.status(200).json({ ok: false, reason: 'deal_not_found', phone });
      const curStage = deal.stage && deal.stage.id;
      let moveResult = null;
      if (curStage !== STAGE_CONFIRM) {
        moveResult = await moveDeal(deal, STAGE_CONFIRM);
      }
      const prodName = (Array.isArray(deal.products) && deal.products[0] && deal.products[0].name) || (deal.title || '');
      const firstName = (deal.contact && deal.contact.name) ? deal.contact.name.split(' ')[0] : '';
      const customMsg = q.msg ? decodeURIComponent(String(q.msg)) : null;
      const msg = customMsg || `🎉 Parfait${firstName ? ' ' + firstName : ''} ! Voici le récap de ta commande :\n\n📦 *${prodName}*\n💵 Livraison gratuite\n\n✅ C'est confirmé ! Notre équipe va t'appeler très bientôt pour finaliser les détails et envoyer ton colis. À tout de suite ! 😊`;
      const sendRes = await egrowSend(integrationId, phone, msg);
      // Notifier patron uniquement
      const notifMsg = `✅ *Commande confirmée (stock)*\n👤 ${(deal.contact && deal.contact.name) || phone}\n📦 ${prodName}\n→ déplacée en Confirmer Wtsp`;
      try { if (MERCHANT_PHONE) await sendAndQueue(integrationId, MERCHANT_PHONE, notifMsg); } catch (e) {}
      return res.status(200).json({ ok: true, deal: deal.id, from: curStage, to: STAGE_CONFIRM, moved: moveResult && moveResult.status, msgSent: sendRes && sendRes.status });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  }

  // ── CRÉER UN DEAL RUPTURE STOCK MANUELLEMENT (create_stock_deal) ──
  // ?create_stock_deal=1&phone=32477914959&name=Rian+Leila&product=Maillot+Pre-Match+Zelige&size=S&city=Rabat
  if (q.create_stock_deal === '1') {
    const integrationId = INTEGRATIONS[0] || '5425';
    const phone = String(q.phone || '').replace(/\D/g, '');
    const name = decodeURIComponent(String(q.name || ''));
    const product = decodeURIComponent(String(q.product || ''));
    const size = String(q.size || '').toUpperCase();
    const city = decodeURIComponent(String(q.city || ''));
    if (!phone || !product) return res.status(400).json({ error: 'phone et product requis' });
    try {
      // Rechercher le contact eGrow par téléphone
      const contactSearch = await egrowPost('/contact/searchContact.php', { search: phone });
      const contacts = Array.isArray(contactSearch) ? contactSearch : (contactSearch && contactSearch.data) || [];
      const contact = contacts.find((c) => String(c.phone || '').replace(/\D/g, '').endsWith(phone.slice(-9))) || contacts[0] || null;
      const contactId = contact ? contact.id : null;
      const order = { product, size, city, customer_name: name, address: '', quantity: 1, waiting_stock: true };
      const r = await createOrderDeal(order, contactId);
      if (r.ok) {
        const noteText = `⏳ EN ATTENTE DE STOCK — créé manuellement. Produit : ${r.product}${size ? ' taille ' + size : ''}. Client : ${name}${city ? ' (' + city + ')' : ''}. Notifier dès que le stock revient.`;
        if (r.dealId) await addDealNote(r.dealId, noteText);
        // Enregistrer dans stock_notifications pour ne pas re-notifier trop tôt
        try {
          await fetch(`${SB_URL}/rest/v1/stock_notifications`, {
            method: 'POST',
            headers: Object.assign({}, supabaseHeaders(true), { 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates' }),
            body: JSON.stringify({ deal_id: String(r.dealId), phone, product_name: r.product }),
          });
        } catch (e) {}
        // Notifier patron uniquement
        const notifMsg = `📋 *Attente stock (manuel)*\n👤 ${name} (${phone})\n📦 ${r.product}${size ? ' taille ' + size : ''}\n📍 ${city}\n→ créé dans « Rappeler le stock »`;
        try { if (MERCHANT_PHONE) await sendAndQueue(integrationId, MERCHANT_PHONE, notifMsg); } catch (e) {}
      }
      return res.status(200).json({ ok: r.ok, dealId: r.dealId, product: r.product, reason: r.reason, contact: contactId });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  }

  // ── Resend notifications manquées (fenêtre 24h fermée) ──
  // ── LIST STAGES (diagnostic) — scan + pipeline endpoints ──
  if (q.list_stages === '1') {
    const results = {};
    // 1) Essai d'endpoints directs
    const pipelineEndpoints = [
      '/deal/getPipeline.php', '/deal/getUserPipelines.php', '/pipeline/getStages.php',
      '/deal/getStages.php', '/crm/getPipelines.php', '/deal/getAllStages.php',
    ];
    for (const ep of pipelineEndpoints) {
      try {
        const r = await egrowPost(ep, {});
        if (r && typeof r === 'object') results[ep] = JSON.stringify(r).slice(0, 300);
      } catch (e) { results[ep] = 'err:' + String(e).slice(0, 80); }
    }
    // 2) Scan IDs autour des stages connus (49140-49180 + 62340-62370)
    const found = {};
    const scanRanges = [];
    for (let i = 49140; i <= 49180; i++) scanRanges.push(i);
    for (let i = 62340; i <= 62380; i++) scanRanges.push(i);
    for (const sid of scanRanges) {
      try {
        const r = await egrowPost('/deal/getStageDeals.php', { stage: sid, search: '', page: 1, limit: 1 });
        // Si on obtient un array (même vide) ou un objet structuré → le stage existe
        if (Array.isArray(r)) {
          found[sid] = `array(${r.length})${r[0] && r[0].stage ? ' name=' + (r[0].stage.name || '?') : ''}`;
        } else if (r && typeof r === 'object' && !r.error && !r.message) {
          found[sid] = 'obj:' + JSON.stringify(r).slice(0, 100);
        }
      } catch (e) { /* stage n'existe pas → on ignore */ }
    }
    return res.status(200).json({ pipelineEndpoints: results, stagesScan: found });
  }

  // ── DEBUG : récupère une conversation pour trouver phone_number_id WhatsApp ──
  if (q.debug_integrations === '1') {
    const integrationId = INTEGRATIONS[0] || '5425';
    // Fetch first conversation to see its integration/meta structure
    const convR = await fetch(`${EGROW_BASE}/inbox/get_conversations.php?me=${EGROW_ME}&dev=0&integrationId=${integrationId}&page=1&limit=1`, { headers: { 'account-key': EGROW_AK, 'User-Agent': EGROW_UA } });
    const convData = await convR.json().catch(() => ({}));
    // Also try to get integration details from eGrow
    const META_TOKEN = process.env.META_ACCESS_TOKEN || '';
    let wabaData = {};
    if (META_TOKEN) {
      // Discover WABA via /me?fields=
      const meR = await fetch(`https://graph.facebook.com/v20.0/me?fields=id,name&access_token=${META_TOKEN}`);
      const meData = await meR.json().catch(() => ({}));
      wabaData.me = meData;
      // Try to list WABAs from the business
      const wabaListR = await fetch(`https://graph.facebook.com/v20.0/me/businesses?access_token=${META_TOKEN}`);
      wabaData.businesses = await wabaListR.json().catch(() => ({}));
      // Try direct WABA phone numbers endpoint
      const pnDirectR = await fetch(`https://graph.facebook.com/v20.0/${meData.id}/phone_numbers?access_token=${META_TOKEN}`);
      wabaData.phone_numbers_direct = await pnDirectR.json().catch(() => ({}));
    }
    return res.status(200).json({ ok: true, conv_sample: convData, waba: wabaData, meta_token_set: !!META_TOKEN });
  }

  // ── STOCK CHECK : vérifie l'inventaire Shopify pour les clients en attente de stock ──
  // ── MORNING PING : ouvre la fenêtre 24h de l'opératrice et du patron via template Utility ──
  if (q.morning_ping === '1') {
    const integrationId = INTEGRATIONS[0] || '5425';
    const SESSION_TEMPLATE = process.env.EGROW_SESSION_TEMPLATE || 'touni_session_bot';
    // Un prénom par opératrice, dans le même ordre que EGROW_OPERATOR_PHONE.
    const OPERATOR_NAMES  = (process.env.EGROW_OPERATOR_NAME || 'Soumaya').split(',').map((s) => s.trim());
    const MERCHANT_NAME   = process.env.EGROW_MERCHANT_NAME   || 'Patron';
    // Date du jour en français (ex: "Samedi 21 juin")
    const dateLabel = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Casablanca', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
    const dateStr = dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1);
    const results = {};
    // Chaque opératrice reçoit le template : c'est lui qui ouvre sa fenêtre WhatsApp 24h.
    // Sans ça, ses notifications d'escalade seraient bloquées par Meta toute la journée.
    results.operators = [];
    for (let i = 0; i < OPERATOR_PHONES.length; i++) {
      const phone = OPERATOR_PHONES[i];
      const name  = OPERATOR_NAMES[i] || OPERATOR_NAMES[0] || 'Opératrice';
      try {
        results.operators.push({ phone, name, res: await egrowSendTemplate(integrationId, phone, SESSION_TEMPLATE, 'en_US', [dateStr, name]) });
      } catch (e) { results.operators.push({ phone, name, error: String(e) }); }
    }
    try {
      results.merchant = await egrowSendTemplate(integrationId, MERCHANT_PHONE, SESSION_TEMPLATE, 'en_US', [dateStr, MERCHANT_NAME]);
    } catch (e) { results.merchant = { error: String(e) }; }
    return res.status(200).json({ ok: true, template: SESSION_TEMPLATE, date: dateStr, results });
  }

  if (q.stock_check === '1') {
    const integrationId = INTEGRATIONS[0] || '5425';
    try {
      // Charger les deal_ids déjà notifiés dans les 7 derniers jours (anti-spam)
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const snRes = await fetch(`${SB_URL}/rest/v1/stock_notifications?notified_at=gte.${encodeURIComponent(sevenDaysAgo)}&select=deal_id,phone,product_name`, { headers: supabaseHeaders() });
      const recentNotifs = await snRes.json().catch(() => []);
      const notifiedDealIds = new Set((Array.isArray(recentNotifs) ? recentNotifs : []).map((n) => String(n.deal_id)));
      const notifiedPhoneProds = new Set((Array.isArray(recentNotifs) ? recentNotifs : []).map((n) => `${n.phone}|${n.product_name}`));

      // Source 1 : Supabase stock_waitlist
      const wlRes = await fetch(`${SB_URL}/rest/v1/stock_waitlist?notified=eq.false&select=*`, { headers: supabaseHeaders() });
      const supabaseList = await wlRes.json().catch(() => []);

      // Source 2 : eGrow deals dans STAGE_STOCK_WAIT (rappeler le stock) et STAGE_RUPTURE
      const eGrowEntries = [];
      const stagesToScan = [...new Set([STAGE_STOCK_WAIT, STAGE_RUPTURE].filter(Boolean))];
      for (const sid of stagesToScan) {
        try {
          for (let page = 1; page <= 5; page++) {
            const deals = await egrowPost('/deal/getStageDeals.php', { stage: sid, search: '', page, limit: 20 });
            if (!Array.isArray(deals) || !deals.length) break;
            deals.forEach((d) => {
              const phone = String((d.contact && d.contact.phone) || '').replace(/\D/g, '');
              if (!phone) return;
              // Ignorer les deals déjà notifiés récemment
              if (notifiedDealIds.has(String(d.id))) return;
              const prods = (Array.isArray(d.products) ? d.products : []).filter((p) => !p.deleted && p.name && !p.name.toLowerCase().includes('flocage'));
              if (!prods.length) return;
              const productName = prods[0].name;
              const sizeOpt = (prods[0].options || []).find((o) => /taille|size/i.test(o.name));
              const size = (sizeOpt && sizeOpt.selected) ? String(sizeOpt.selected).toUpperCase() : '';
              eGrowEntries.push({ source: 'egrow', dealId: String(d.id), phone, name: (d.contact && d.contact.name) || '', product_name: productName, size, city: d.deal_city || '' });
            });
            if (deals.length < 20) break;
          }
        } catch (e) { /* non bloquant */ }
      }

      // Fusionner : éviter les doublons par téléphone+produit, ignorer déjà notifiés
      const seen = new Set();
      const waitlist = [];
      (Array.isArray(supabaseList) ? supabaseList : []).forEach((e) => {
        const k = `${e.phone}|${e.product_name}`;
        if (!seen.has(k) && !notifiedPhoneProds.has(k)) { seen.add(k); waitlist.push(e); }
      });
      eGrowEntries.forEach((e) => {
        const k = `${e.phone}|${e.product_name}`;
        if (!seen.has(k)) { seen.add(k); waitlist.push(e); }
      });

      if (!waitlist.length) return res.status(200).json({ checked: 0, skipped_recent: notifiedDealIds.size, results: [] });

      const results = [];
      for (const entry of waitlist) {
        try {
          const catalog = await searchCatalog(`${entry.product_name} ${entry.size || ''}`);
          const inStock = catalog && catalog.includes('EN STOCK');
          const sizeOk = !entry.size || (new RegExp(`\\b${entry.size.toUpperCase()}\\b`)).test(catalog || '');
          if (inStock && sizeOk) {
            const firstName = (entry.name ? entry.name.split(' ')[0] : '') || 'cher client';
            const productLabel = `${entry.product_name}${entry.size ? ' (taille ' + entry.size + ')' : ''}`;
            // Template touni_dispo_stock_v2 : {{1}} = prénom, {{2}} = produit — fonctionne hors fenêtre 24h
            const sendRes = await egrowSendTemplate(integrationId, entry.phone, 'touni_dispo_stock_v2', 'en_US', [firstName, productLabel]);
            const sendOk = sendRes && sendRes.status === 'success';
            // Enregistrer la tentative dans stock_notifications (anti-spam 7j), que ça marche ou pas
            if (entry.dealId) {
              try {
                await fetch(`${SB_URL}/rest/v1/stock_notifications`, {
                  method: 'POST',
                  headers: Object.assign({}, supabaseHeaders(true), { 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates' }),
                  body: JSON.stringify({ deal_id: String(entry.dealId), phone: entry.phone, product_name: entry.product_name }),
                });
              } catch (e) { /* non bloquant */ }
            }
            if (sendOk) {
              if (entry.id && entry.source !== 'egrow') {
                await fetch(`${SB_URL}/rest/v1/stock_waitlist?id=eq.${entry.id}`, {
                  method: 'PATCH',
                  headers: Object.assign({}, supabaseHeaders(true), { 'Content-Type': 'application/json' }),
                  body: JSON.stringify({ notified: true, notified_at: new Date().toISOString() }),
                });
              }
              results.push({ phone: entry.phone, name: entry.name, product: entry.product_name, source: entry.source || 'supabase', status: 'notified' });
            } else {
              results.push({ phone: entry.phone, name: entry.name, product: entry.product_name, source: entry.source || 'supabase', status: 'send_failed', sendRes });
            }
          } else {
            results.push({ phone: entry.phone, product: entry.product_name, source: entry.source || 'supabase', status: 'still_out_of_stock' });
          }
        } catch (e) { results.push({ phone: entry.phone, status: 'err', err: String(e) }); }
      }

      // Résumé patron — envoi vers MERCHANT_PHONE ET OPERATOR_PHONE en fallback
      const notified = results.filter((r) => r.status === 'notified');
      const failed = results.filter((r) => r.status === 'send_failed');
      const oos = results.filter((r) => r.status === 'still_out_of_stock').length;
      const date = new Date().toISOString().slice(0, 10);
      const lines = notified.map((r) => `✅ ${r.name || r.phone} — ${String(r.product || '').slice(0, 35)}`);
      const failLines = failed.map((r) => `⏳ ${r.name || r.phone} — fenêtre WhatsApp fermée`);
      const summary = `📦 *Stock Check Touni* (${date})\n${notified.length} notifié(s)${failed.length ? ', ' + failed.length + ' fenêtre fermée' : ''} :\n${[...lines, ...failLines].join('\n')}\n\n${oos} encore en rupture. ${notifiedDealIds.size} skippés (déjà notifiés).`;
      // Résumé stock → patron uniquement (l'opératrice voit le pipeline)
      if ((notified.length || failed.length) && MERCHANT_PHONE) {
        try { await sendAndQueue(integrationId, MERCHANT_PHONE, summary); } catch (e) { /* non bloquant */ }
      }

      return res.status(200).json({ checked: waitlist.length, skipped_recent: notifiedDealIds.size, supabase: (Array.isArray(supabaseList) ? supabaseList : []).length, egrow: eGrowEntries.length, notified: notified.length, failed: failed.length, results });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  }

  if (q.resend_missed === '1') {
    const integrationId = INTEGRATIONS[0] || '5425';
    const convIds = (q.conv_ids ? String(q.conv_ids).split(',') : ['2579903','2407725','1374109','2398791','2587955','2575495','2461723','2562857','1041549','2561335','2598547']).map((s) => s.trim()).filter(Boolean);
    const getMsgBody = (m) => String((m && (m.body || (m.content && m.content.body))) || '');
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

    async function genSummary(msgs) {
      if (!ANTHROPIC_KEY) return null;
      const lines = (msgs || []).slice(0, 10).reverse().map((m) => {
        const who = (m.mine === true || m.mine === 'true') ? 'Bot' : 'Client';
        return `${who}: ${getMsgBody(m).slice(0, 200)}`;
      }).join('\n');
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 120,
            messages: [{ role: 'user', content: `Tu es l'assistant de l'opératrice d'une boutique de maillots. En lisant cet échange WhatsApp, résume EN 1-2 PHRASES MAXIMUM ce que le client demande ou quel est son problème — pour que l'opératrice sache immédiatement quoi faire. Sois direct, factuel, pas de formule de politesse.\n\n${lines}\n\nRésumé (1-2 phrases max) :` }],
          }),
        });
        const j = await r.json().catch(() => ({}));
        return (j.content && j.content[0] && j.content[0].text || '').trim().slice(0, 350) || null;
      } catch (e) { return null; }
    }

    const results = [];
    for (const convId of convIds) {
      try {
        const msgs = await egrowGetMessages(convId, 12);
        const incoming = (msgs || []).filter((m) => m && !(m.mine === true || m.mine === 'true'));
        const lastIn  = incoming[0];
        const lastMsg = getMsgBody(lastIn).slice(0, 220);
        const phone = (lastIn && (lastIn.senderPhone || lastIn.senderWaId)) || '?';
        const name  = (lastIn && lastIn.contact && lastIn.contact.name) || phone;
        // Générer un vrai résumé de situation via Claude (pas copier-coller le message du bot)
        const note = (await genSummary(msgs)) || 'voir la conversation';
        const summary = `🔔 *[RATTRAPÉ] Client à gérer (notif manquée — fenêtre 24h)*\n👤 ${name}\n📱 ${phone}\n📝 ${note}\n💬 « ${lastMsg} »`;
        let sr;
        for (const _op of OPERATOR_PHONES) { sr = await egrowSend(integrationId, _op, summary); }
        results.push({ convId, name, phone, note, status: sr && sr.status });
      } catch (e) { results.push({ convId, status: 'err', err: String(e) }); }
    }
    return res.status(200).json({ sent: results.length, results });
  }

  // ── STOCK CATCHUP — déplacer vers STAGE_CONFIRM les clients qui ont déjà confirmé après le template stock ──
  if (q.stock_catchup === '1') {
    const integrationId = INTEGRATIONS[0] || '5425';
    const CONFIRM_RE = /\b(oui|wah|n3am|ok|zid|confirme|confirm[eé]|r[eé]serve|yes)\b/i;
    const BTN_CONFIRM_RE = /confirmer.{0,25}exp[eé]dition/i;
    try {
      // Étape 1 : collecter tous les deals en STAGE_STOCK_WAIT + STAGE_RUPTURE
      const stockDeals = new Map(); // phone → deal object
      for (const sid of [STAGE_STOCK_WAIT, STAGE_RUPTURE].filter(Boolean)) {
        for (let page = 1; page <= 7; page++) {
          const deals = await egrowPost('/deal/getStageDeals.php', { stage: sid, search: '', page, limit: 20 });
          if (!Array.isArray(deals) || !deals.length) break;
          deals.forEach((d) => {
            const ph = String((d.contact && d.contact.phone) || '').replace(/\D/g, '');
            if (ph && !stockDeals.has(ph)) stockDeals.set(ph, d);
          });
          if (deals.length < 20) break;
        }
      }
      if (!stockDeals.size) return res.status(200).json({ stockDeals: 0, moved: 0, results: [] });
      // Mode debug : affiche les numéros pour diagnostiquer le mismatch
      if (q.debug === '1') {
        const sampleDeals = [...stockDeals.entries()].slice(0, 5).map(([ph, d]) => ({ phone: ph, dealId: d.id }));
        const pg1 = await egrowGetConversations(integrationId, 1).catch(() => []);
        const sampleConvs = (pg1 || []).slice(0, 10).map((c) => ({ contactWaId: c.contactWaId, contactPhone: c.contact && c.contact.phone, convId: c.id }));
        return res.status(200).json({ stockDeals: stockDeals.size, sampleDeals, sampleConvs });
      }

      // Normalise un numéro en suffixe 9 chiffres (Maroc : 212XXXXXXXXX → XXXXXXXXX)
      const suffix9 = (ph) => String(ph).replace(/\D/g, '').slice(-9);
      // Index suffix → phone exact du deal
      const suffixToPhone = new Map([...stockDeals.keys()].map((ph) => [suffix9(ph), ph]));

      // Étape 2 : scanner l'inbox pour retrouver les conversations de ces phones (5 pages = ~100 convs récentes)
      const convByPhone = new Map(); // phone (deal) → convId
      const inboxPages = await Promise.all([1,2,3,4,5,6,7,8,9,10].map((p) => egrowGetConversations(integrationId, p).catch(() => [])));
      for (const convs of inboxPages) {
        if (!Array.isArray(convs)) continue;
        for (const conv of convs) {
          const rawPh = String(conv.contactWaId || (conv.contact && (conv.contact.phone || conv.contact.wa_id)) || '').replace(/\D/g, '');
          const suf = suffix9(rawPh);
          const dealPhone = suffixToPhone.get(suf);
          if (dealPhone && !convByPhone.has(dealPhone)) convByPhone.set(dealPhone, conv.id);
        }
      }

      // Étape 3 : vérifier le dernier message client de chaque conversation trouvée (parallèle)
      const results = [];
      const msgsList = await Promise.all([...convByPhone.entries()].map(([ph, cid]) => egrowGetMessages(cid, 8).then((msgs) => ({ ph, cid, msgs })).catch(() => ({ ph, cid, msgs: [] }))));
      for (const { ph: phone, msgs } of msgsList) {
        const convId = convByPhone.get(phone);
        if (!Array.isArray(msgs) || !msgs.length) continue;
        // msgs[0] = plus récent. Cherche le dernier message du CLIENT (mine=false)
        const lastClient = msgs.find((m) => !(m.mine === true || m.mine === 'true'));
        if (!lastClient) continue;
        const body = String(lastClient.body || (lastClient.content && ((lastClient.content.button && lastClient.content.button.text) || lastClient.content.text || (lastClient.content.interactive && lastClient.content.interactive.button_reply && lastClient.content.interactive.button_reply.title))) || '');
        const type = String(lastClient.type || '');
        // Détection confirmation : bouton "Confirmer l'expédition" OU mot-clé texte
        const isBtn = type === 'button' || type === 'button_reply' || type === 'interactive';
        const isConfirm = BTN_CONFIRM_RE.test(body) || (isBtn && !/annul/i.test(body) && /confirm/i.test(body)) || CONFIRM_RE.test(body);
        if (!isConfirm || /annul/i.test(body)) {
          results.push({ phone, convId, lastMsg: body.slice(0, 60), status: 'not_confirmed' }); continue;
        }
        // Déplace le deal vers STAGE_CONFIRM
        const deal = stockDeals.get(phone);
        const curStage = deal && deal.stage && deal.stage.id;
        if (curStage === STAGE_CONFIRM) { results.push({ phone, deal: deal.id, status: 'already_confirmed' }); continue; }
        try {
          const mv = await moveDeal(deal, STAGE_CONFIRM);
          results.push({ phone, deal: deal.id, from: curStage, to: STAGE_CONFIRM, lastMsg: body.slice(0, 60), status: 'moved', mvOk: mv && mv.status });
        } catch (e) { results.push({ phone, deal: deal && deal.id, status: 'move_err', err: String(e) }); }
      }

      const moved = results.filter((r) => r.status === 'moved');
      if (moved.length && MERCHANT_PHONE) {
        const lines = moved.map((r) => `✅ ${r.phone} → Confirmer Wtsp (deal ${r.deal})`).join('\n');
        try { await egrowSend(integrationId, MERCHANT_PHONE, `📦 *Stock Catchup Touni*\n${moved.length} commande(s) confirmée(s) :\n${lines}`); } catch (e) {}
      }
      return res.status(200).json({ stockDeals: stockDeals.size, found_in_inbox: convByPhone.size, moved: moved.length, results });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
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
