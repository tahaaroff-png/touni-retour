// Agent IA Touni (Claude). Deux modes sur le MÊME endpoint (plan Hobby = max 12 fonctions) :
//   - POST /api/ai-reply            → répond à UN message (test manuel / eGrow Api Request).
//   - GET  /api/ai-reply?poll=1     → POLLER : lit l'inbox eGrow, répond via Claude, envoie via l'API eGrow.
// Sécurisé par ?secret=. Clé Claude + tokens eGrow en env. Anti-doublon Supabase (table wa_agent_replied).
const { handleIncoming } = require('./_agent.js');
const { SB_URL, supabaseHeaders, shopifyAdminHeaders, SHOPIFY_DOMAIN, SHOPIFY_API_VERSION } = require('./_shopify-helpers.js');

const SECRET = 'touni-sync-2026';
const EGROW_ME = process.env.EGROW_ME || '';
const EGROW_AK = process.env.EGROW_AK || '';
const EGROW_BASE = 'https://api.egrow.com';
const INTEGRATIONS = (process.env.EGROW_INTEGRATIONS || '5425').split(',').map((s) => s.trim()).filter(Boolean);
const FRESH_WINDOW_SEC = parseInt(process.env.EGROW_FRESH_SEC || '600', 10); // ne répond qu'aux messages des 10 dernières min
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
  const r = await fetch(url, { headers: { 'account-key': EGROW_AK } });
  const j = await r.json();
  return (j && j.data) || [];
}
async function egrowGetMessages(convId, limit) {
  const url = `${EGROW_BASE}/inbox/get_conversation_messages.php?me=${EGROW_ME}&dev=0&conversationId=${convId}&page=1&limit=${limit || 14}`;
  const r = await fetch(url, { headers: { 'account-key': EGROW_AK } });
  const j = await r.json().catch(() => ({}));
  return (j && j.data) || [];
}
async function egrowSend(integrationId, toWaId, text) {
  const boundary = '----TouniAgent' + Math.random().toString(36).slice(2);
  const payload = JSON.stringify({ integrationId: Number(integrationId), to: String(toWaId), type: 'text', body: text, me: EGROW_ME, dev: 0 });
  const raw = `--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${payload}\r\n--${boundary}--\r\n`;
  const r = await fetch(`${EGROW_BASE}/inbox/send_conversation_message.php`, {
    method: 'POST',
    headers: { 'account-key': EGROW_AK, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: raw,
  });
  try { return await r.json(); } catch (e) { return { status: 'http_' + r.status }; }
}
// POST générique eGrow (multipart, champ "data" = JSON {params, me, dev}) — format universel de l'app.
async function egrowPost(path, params) {
  const p = Object.assign({}, params, { me: EGROW_ME, dev: 0 });
  const boundary = '----TouniAgent' + Math.random().toString(36).slice(2);
  const raw = `--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${JSON.stringify(p)}\r\n--${boundary}--\r\n`;
  const r = await fetch(`${EGROW_BASE}${path}`, { method: 'POST', headers: { 'account-key': EGROW_AK, 'content-type': `multipart/form-data; boundary=${boundary}` }, body: raw });
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
// Déplace un deal vers un stage (confirm = 49148, cancel = 49149).
async function moveDeal(deal, targetStage) {
  return egrowPost('/deal/updateDealOrderinNewStage.php', {
    new_order: 1, old_order: deal.order || 1, stage_id: targetStage, deal_id: deal.id,
    old_stage: (deal.stage && deal.stage.id) || (MOVABLE_STAGES[0] || 62357), update_stage_source: 'update order stage',
  });
}

// ───────── #3 — création de commande ─────────
function normTxt(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
async function egrowSearchProduct(name) {
  const tryOne = async (q) => { const r = await egrowPost('/product/getUserProduct.php', { search: String(q || '').slice(0, 80) }); return Array.isArray(r) ? r : (r && r.data) || []; };
  let arr = await tryOne(name);
  if (arr.length) return arr;
  const words = String(name || '').split(/\s+/).filter((w) => w.length > 1);
  if (words.length > 3) { arr = await tryOne(words.slice(-3).join(' ')); if (arr.length) return arr; }
  const longest = words.slice().sort((a, b) => b.length - a.length)[0];
  if (longest) arr = await tryOne(longest);
  return arr;
}
async function createOrderDeal(order, contactId) {
  const prods = await egrowSearchProduct(order.product);
  if (!prods.length) return { ok: false, reason: 'product_not_found' };
  const want = normTxt(order.product);
  const p = prods.find((x) => normTxt(x.name) === want) || prods.find((x) => normTxt(x.name).includes(want) || want.includes(normTxt(x.name))) || prods[0];
  const qty = Math.max(1, parseInt(order.quantity || 1, 10) || 1);
  const price = parseFloat(p.price) || 0;
  const productObj = Object.assign({}, p, { quantity: qty });
  const body = {
    id: 0, label: '', source: 'agent-ia-whatsapp',
    deal_city: order.city || '', country: 'MA', deal_address: order.address || '',
    deal_apartment: '', deal_province: '', deal_zip: '', deal_area: '', deal_street_name: '', deal_house_number: '', deal_nearest_place: '', deal_location: '', deal_district: '',
    deal_payment_method: 'Cash on Delivery (COD)', payment_status: 'pending',
    deal_shipping_price: 0, deal_shipping: null,
    contact_id: contactId, type: 'deal', title: `${order.customer_name || ''} - ${p.name}`.slice(0, 120),
    deal_value: price * qty, deal_currency: { id: 153, name: 'Dirham', code: 'MAD', symbol: 'MAD' },
    deal_custom_fields: JSON.stringify({ note: '' }), products: JSON.stringify([productObj]),
    pipeline_stage: STAGE_CONFIRM, close_date: 0, deal_number: '', deal_tracking_number: '',
    users: '[]', do_not_update_assigned: false, shipping_user_connection: 0,
  };
  const res = await egrowPost('/deal/add_or_update_deal.php', body);
  const dealId = (res && res.deal && res.deal.id) || null;
  return { ok: !!(res && res.status === 'success'), dealId, product: p.name, price, qty, value: price * qty };
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

// Recherche catalogue Shopify (cache Supabase) selon la demande → bloc dispo en direct à injecter.
const CATALOG_STOPWORDS = new Set('taille tailles size prix combien chhal taman bghit bghi bghyt veux voudrais cherche dispo disponible disponibles bonjour salam salut svp stp merci pour avec est une des les dans vous tu je oui non ok cest quoi autre meme original foot football equipe club saison commande commander acheter chri photo photos couleur couleurs livraison aujourd hui parfait prends prend piece pieces standard mon complet nom adresse ville rue confirme maintenant article articles nombre quantite bien donc alors voila moi prendre prenez prendrai numero tel chi 3ndkom 3ndkoum dial wach ash kayn avez avoir avez-vous propose proposez proposes vend vends vendez vendre fait faites donne donnez montre montrez envoie envoyez trouve trouvez regarde vois voir sur ce cette ces ton tes mes son ses mais que qui comme plus tres beaucoup aussi encore deja juste vraiment chez peux peut pouvez avait gout'.split(' '));
// Mots de CATÉGORIE : gardés (le client peut chercher une catégorie), mais on privilégie un mot spécifique (équipe) s'il y en a un.
const CATEGORY_WORDS = new Set('maillot maillots kit kits ensemble ensembles survetement survetements casquette casquettes ballon ballons short shorts chaussette chaussettes accessoire accessoires gourde'.split(' '));
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
// Trouve les collections (équipe/catégorie) qui correspondent aux mots-clés, triées par pertinence.
// Renvoie un tableau [{c, score}] (score>0), pour pouvoir détecter une AMBIGUÏTÉ (ex: "inter" → Inter Miami ET Inter Milan).
async function matchCollections(searchTerms) {
  const cols = await getCollections();
  const scored = [];
  for (const c of cols) {
    const ct = normTxt(c.title);
    if (!ct) continue;
    let score = 0;
    for (const w of searchTerms) { if (w.length >= 4 && (ct.indexOf(w) !== -1 || w.indexOf(ct.split(' ')[0]) !== -1)) score++; }
    if (score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
async function searchCatalog(text) {
  try {
    const norm = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const allToks = [...new Set(norm.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !CATALOG_STOPWORDS.has(w)))].slice(0, 8);
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
    // recherche par titre (wildcard) — gère le pluriel via les stems ajoutés ci-dessus
    const qstr = searchTerms.map((t) => `title:*${t}*`).join(' OR ');
    const gql = 'query($q:String!){ products(first:40, query:$q){ edges{ node{ title status variants(first:25){ edges{ node{ title price inventoryQuantity } } } } } } }';
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
    for (const { p } of scored) {
      if (lines.length >= 6) break;
      if (p.status !== 'ACTIVE') continue; // pas de brouillon/archivé
      const avail = ((p.variants && p.variants.edges) || []).map((e) => e.node).filter((v) => Number(v.inventoryQuantity) > 0);
      if (!avail.length) continue; // rien en stock
      const sizes = [...new Set(avail.map((v) => { const mm = String(v.title || '').match(SIZE_RE); return mm ? mm[1].toUpperCase() : ''; }).filter(Boolean))];
      const price = avail[0].price;
      const q = encodeURIComponent(String(p.title).replace(/[–—|]/g, ' ').replace(/\s+/g, ' ').trim());
      lines.push(`- ${p.title} : ~${price} dh — EN STOCK${sizes.length ? ' [tailles ' + sizes.join(',') + ']' : ''} | lien: https://touni.ma/search?q=${q}`);
    }
    const cms = await matchCollections(searchTerms);
    let colLine = '';
    if (cms.length) {
      const top = cms[0].score;
      const tied = cms.filter((m) => m.score === top).map((m) => m.c);
      if (tied.length >= 2) {
        // Ambigu (ex: "inter" → Inter Miami ET Inter Milan ; "maroc" → Classic/CDM/Rétro) → l'agent DOIT demander laquelle AVANT d'envoyer un lien
        colLine = `⚠️ AMBIGU — PLUSIEURS COLLECTIONS correspondent à la demande : ${tied.map((c) => c.title).join(' / ')}. NE partage AUCUN lien tout de suite : DEMANDE d'abord au client de LAQUELLE il parle, puis envoie le lien de la bonne. Liens (à n'utiliser qu'APRÈS clarification, jamais avant) :\n${tied.map((c) => `  • ${c.title} → https://touni.ma/collections/${c.handle}`).join('\n')}\n\n`;
      } else {
        const col = cms[0].c;
        colLine = `COLLECTION ÉQUIPE (page du site avec TOUS les modèles — partage CE lien en PRIORITÉ, au lieu de lister les produits un par un) : ${col.title} → https://touni.ma/collections/${col.handle}\n\n`;
      }
    }
    if (!lines.length) return colLine ? colLine.trim() : '';
    return colLine + 'CATALOGUE (stock & prix EN DIRECT Shopify — UNIQUEMENT produits ACTIFS et EN STOCK ; ne propose QUE ceux-ci) :\n' + lines.join('\n');
  } catch (e) { return ''; }
}

async function runPoll(q) {
  // EGROW_ONLY (env) = mode TEST : l'agent ne répond QU'à ce numéro, et ignore la porte horaire.
  // (Vide en prod → tous les clients, porte horaire active.)
  const envOnly = (process.env.EGROW_ONLY || '').replace(/\D/g, '');
  const dry = q.dry === '1';                          // dry-run : ne pas envoyer, juste lister
  const bypassTime = q.test === '1' || !!envOnly;     // scope env = test → ignore l'heure
  const onlyPhone = envOnly || (q.only || '').toString().replace(/\D/g, ''); // numéro ciblé
  const nowSec = Math.floor(Date.now() / 1000);
  const results = [];
  let processed = 0;

  for (const integrationId of INTEGRATIONS) {
    const convs = await egrowGetConversations(integrationId, 1);
    for (const c of convs) {
      if (processed >= MAX_PER_RUN) break;
      try {
        const lm = c.lastMessage || {};
        const contactWaId = String(c.contactWaId || '');
        const senderWaId = String(lm.senderWaId || '');
        const lastTime = parseInt(c.lastMessageTime || lm.sentAt || '0', 10);
        const body = (lm.body || (lm.content && lm.content.body) || '').toString();
        const type = (lm.type || '').toString();
        const msgId = String(lm.id || '');

        if (onlyPhone && contactWaId !== onlyPhone) continue;
        const incoming = senderWaId && contactWaId && senderWaId === contactWaId; // dernier msg = du client (sans réponse)
        if (!incoming) continue;
        if (!lastTime || (nowSec - lastTime) > FRESH_WINDOW_SEC) continue;        // frais uniquement (jamais le backlog)
        if (!msgId) continue;
        const isImage = type === 'image';
        if (!isImage && type && type !== 'text') continue;                        // pas template/audio/sticker/bouton
        if (!isImage && !body.trim()) continue;
        if (!dry && !(await claimMessage(msgId, c.id, contactWaId, body))) continue; // anti-doublon ATOMIQUE : un seul run traite ce message (pas de claim en dry-run)
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

        // Historique de la conversation → réponse en contexte (multi-tours)
        let history = [];
        try {
          const raw = await egrowGetMessages(c.id, 14);
          history = raw
            .filter((m) => { const t = (m.type || ''); return t === 'text' || t === 'template'; })
            .map((m) => ({ role: (m.mine === true || m.mine === 'true') ? 'assistant' : 'user', content: (m.body || (m.content && m.content.body) || '').toString() }))
            .reverse(); // ancien -> récent
        } catch (e) {}

        // Catalogue Shopify en direct (selon la demande + contexte récent)
        let catalog = '';
        try {
          const histText = history.filter((h) => h.role === 'user').slice(-3).map((h) => h.content).join(' ');
          catalog = await searchCatalog(body + ' ' + histText);
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

        const decision = await handleIncoming(
          { text: body, name: c.title || (c.contact && c.contact.name) || '', city: (c.contact && c.contact.city) || '', history, catalog, imageBase64, imageMime },
          { bypassTime }
        );
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
          } else {
            const sendRes = await egrowSend(integrationId, contactWaId, decision.reply);
            entry.sent = sendRes && sendRes.status;
            if (!(sendRes && sendRes.status === 'success')) await releaseClaim(msgId); // envoi raté → libère pour réessayer au prochain run
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
                entry.orderCreated = r.ok ? { deal: r.dealId, product: r.product, value: r.value } : ('fail:' + (r.reason || 'unknown'));
                if (r.ok) {
                  const o = decision.order;
                  if (r.dealId) await addDealNote(r.dealId, `Commande prise par l'agent IA (WhatsApp). ${r.qty}x ${r.product}${o.size ? ' taille ' + o.size : ''}${o.color ? ' ' + o.color : ''}. Client: ${o.customer_name}. Adresse: ${o.address}, ${o.city}. Confirmer la taille par appel.`);
                  const saleMsg = `💰 *Nouvelle commande (agent IA)*\n👤 ${o.customer_name} (${contactWaId})\n📦 ${r.qty}x ${r.product}${o.size ? ' (' + o.size + ')' : ''}\n💵 ${r.value} dh · 📍 ${o.city}\n→ créée dans « Confirmer Wtsp »`;
                  try { if (MERCHANT_PHONE) await egrowSend(integrationId, MERCHANT_PHONE, saleMsg); } catch (e) {}
                }
              } catch (e) { entry.orderCreated = 'err'; }
            }
          }
          processed++;
        }
        results.push(entry);
      } catch (e) {
        results.push({ conv: c && c.id, error: String(e) });
      }
    }
  }
  return { ok: true, dry, bypassTime, processed, count: results.length, results };
}

module.exports = async (req, res) => {
  const q = req.query || {};
  if (q.secret !== SECRET) return res.status(401).json({ error: 'unauthorized' });

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
    const text = body.message || body.text || body.body || body.content || body.last_message || '';
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
    let catalog = ''; try { catalog = await searchCatalog(text); } catch (e) {}
    const imageBase64 = body.image_base64 || null;
    const imageMime = body.image_mime || 'image/jpeg';
    const d = await handleIncoming({ text, name, orderItems, total, city, catalog, imageBase64, imageMime }, opts);
    return res.status(200).json({ reply: d.reply || '', intent: d.intent || 'answer', note: d.note || '', order: d.order || null, send: !!d.send, skipped: d.skipped, hour: d.hour, usage: d.usage, catalogText: catalog || '' });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
