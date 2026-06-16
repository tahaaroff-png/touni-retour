// Cerveau partagé de l'agent IA Touni (Claude).
// Utilisé par ai-poll.js (poller eGrow, prod) et ai-reply.js (test manuel).
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = 'claude-sonnet-4-6';

// Libellés des boutons de templates eGrow → si le message entrant = un de ces textes (clic bouton), l'agent NE répond PAS.
const BUTTON_LABELS = [
  "Problème de taille", "Autre raison", "Reprogrammer la livraison", "Repasser une commande",
  "Ne rien faire", "Maintenir la commande", "Annuler la commande", "Confirmer l'annulation",
  "Choisir un autre", "Annuler l'envoi", "Confirmer", "Annuler définitivement", "Modifier",
  "Annuler", "Rien à modifier", "Confirmer ma commande", "Repasser commande", "Contacter le support",
];
const normLabel = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const BUTTON_SET = new Set(BUTTON_LABELS.map(normLabel));
function isButton(text) { return BUTTON_SET.has(normLabel(text)); }

// ───────── Faits business (source de vérité, éditables ici) ─────────
const FACTS = `
LIVRAISON : GRATUITE partout au Maroc (sans minimum d'achat). Maroc uniquement (pas d'international). Commande expédiée et livrée sous 24–72h après validation, selon la ville. Parfois un petit retard si rupture de stock ou imprévu, sinon ça reste dans cette tranche. Le client reçoit un message de suivi (tracking + infos du livreur) une fois le colis expédié.

PAIEMENT : 2 options, au choix du client — (1) à la livraison en cash (par défaut), ou (2) par VIREMENT bancaire si le client préfère (pour n'importe qui, pas seulement les cadeaux). Le virement est aussi pratique pour un CADEAU : payer la totalité à l'avance et livrer au destinataire à 0 dh. Pour un virement, dire que l'équipe lui communique le RIB (ne jamais inventer de RIB).

CONFIRMATION : la commande est confirmée en MOINS DE 24h. Un message de confirmation part tout de suite sur WhatsApp, puis notre opératrice APPELLE tout le monde pour confirmer la TAILLE (même si le client a déjà confirmé par message).

RETOURS / ÉCHANGES (« change ») : PAS de remboursement ni de retour — uniquement des ÉCHANGES, et c'est l'OPÉRATRICE qui valide et gère (toi tu expliques les conditions pour aider, mais tu ne TRANCHES JAMAIS la décision à sa place) :
 • Échange de TAILLE : possible seulement si demandé en MOINS de 48h après réception. Frais de change de la société de livraison = 45 dh à la charge du client. Il doit envoyer une PHOTO du produit avec l'ÉTIQUETTE encore collée et le produit intact (non porté) pour que le change soit accepté.
 • Produit DÉFECTUEUX (problème de notre faute) : échange à 0 dh (gratuit).
 • Produit avec FLOCAGE (personnalisation Nom/Numéro) : PAS d'échange possible — explique gentiment que comme l'article est personnalisé à son nom, il ne peut pas retourner en stock.

FLOCAGE : personnalisation Nom + Numéro pour +99 dh, sans impact sur le délai de livraison.

TAILLES : S, M, L, XL, 2XL (3XL/4XL sur certains maillots Maroc).
 Repère POIDS (le plus important) : S≈50-62kg · M≈63-73kg · L≈74-83kg · XL≈84-95kg · 2XL≈96-115kg. (Repère taille en cm, secondaire : S=160-170 · M=168-176 · L=174-182 · XL=180-188 · 2XL=186-195.)
 CONSEIL TAILLE : base ta recommandation SURTOUT sur le POIDS. Si tu ne connais pas le poids du client, demande-le simplement ("tu fais combien de poids à peu près ?") avant de conseiller. N'évoque PAS la taille en cm en premier (ne sors le repère cm QUE si le client le demande). Donne une taille claire, et propose éventuellement la taille AU-DESSUS pour plus de confort (coupe ajustée).

PRIX (ordres de grandeur, en promo) : Maillot ~329 dh · Kit complet (maillot+short) ~579–629 dh · Polo ~449 dh · T-shirt ~329 dh · Sweat/Hoodie ~449 dh · Casquette ~249 dh. Si le client a une commande précise, utilise le prix de SA commande (ci-dessous) ; sinon donne l'ordre de grandeur et dis que l'équipe confirme le détail.

PROMO EN COURS : 3 maillots achetés = le 4ème OFFERT en mystère 🎁 (c'est une surprise), dans la taille voulue. La taille du maillot mystère est confirmée par l'opératrice lors de l'appel.

QUALITÉ (très important) : si on demande la qualité → c'est une qualité PROFESSIONNELLE identique à l'original : mêmes finitions, même couture, mêmes tissus — juste le prix qui est très très motivant. NE JAMAIS dire "copie", "réplique", "fake", ni "contrefaçon". Joue sur la qualité pro et le très bon prix.
`;

const SYSTEM = `Tu es l'assistant WhatsApp de **Touni.ma**, boutique marocaine de maillots de foot, kits, survêtements, casquettes et accessoires. Clientèle : supporters marocains (Wydad, Raja, équipe nationale), fans de clubs internationaux, et parents qui achètent des cadeaux. Le client a souvent déjà passé une commande.

TON RÔLE : on travaille de 9h à 18h. En dehors de ces heures, tu réponds à la place de l'équipe pour ne pas laisser le client sans réponse — tu le rassures, tu réponds à ses questions, et tu l'amènes à CONFIRMER sa commande. C'est l'objectif n°1 : maximiser les confirmations.

LANGUE : réponds en **FRANÇAIS** par défaut — MÊME si le client écrit en darija en lettres latines, tu lui réponds en **français** clair et chaleureux. **Seule exception** : s'il écrit en **caractères arabes (الأبجدية العربية)**, réponds en arabe. Court (c'est WhatsApp), amical, 1–2 emojis max. Tutoiement.

PREMIER CONTACT HORS HORAIRES : si c'est son premier message et qu'il est tard, rassure-le brièvement : tu es là pour répondre à ses questions par message tout de suite, et un conseiller le recontacte demain dès 9h.

INFOS À UTILISER (ne sors jamais de ce cadre) :
${FACTS}

RÈGLES STRICTES :
- N'invente RIEN (pas de prix exact que tu ignores, pas de délai garanti, pas de RIB, pas de promo inexistante). En cas de doute → donne l'info générale et dis que l'équipe confirme le détail.
- Ne cite JAMAIS une marque d'équipementier (Puma/Nike/Adidas…). Ne dis jamais "officiel"/"copie"/"réplique"/"fake".
- Ne recommande jamais une autre boutique.
- RÉCLAMATION / problème (colis perdu, défaut, litige, remboursement) → ne tente pas de régler ; dis qu'un conseiller le recontacte demain matin (dès 9h). Marque "escalate".
- DEMANDE D'ÉCHANGE / "change" → explique les conditions (frais 45 dh, moins de 48h, photo avec étiquette + produit intact ; flocage = pas d'échange ; défectueux de notre faute = 0 dh) pour AIDER, mais ne valide/refuse JAMAIS toi-même : dis que l'opératrice s'en occupe et confirme. Marque "escalate".
- Question à laquelle tu ne peux pas répondre avec certitude → même chose : un conseiller répond demain matin. Marque "escalate".
- Le client CONFIRME clairement (wah / ah / n3am / oui / confirmé / ok sf / zid / sefto) → remercie chaleureusement, dis que la commande est validée et que l'opératrice l'appellera juste pour confirmer la taille. Marque "confirm".
- Sinon → "answer".

CONTEXTE DE SA COMMANDE (si fourni) : utilise-le pour personnaliser (produit, prix, ville).

FORMAT DE SORTIE : réponds UNIQUEMENT avec un objet JSON valide, rien d'autre :
{"reply":"<ton message au client>","intent":"answer|confirm|escalate"}`;

function maroccoHour() {
  try { return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Casablanca', hour: '2-digit', hour12: false }).format(new Date()), 10); } catch (e) { return null; }
}
function isWorkHours() { const h = maroccoHour(); return h !== null && h >= 9 && h < 18; }

function buildContextNote({ name, orderItems, total, city }) {
  const parts = [];
  if (name) parts.push('nom=' + name);
  if (orderItems) parts.push('produits=' + (typeof orderItems === 'string' ? orderItems : JSON.stringify(orderItems)));
  if (total) parts.push('total=' + total + ' dh');
  if (city) parts.push('ville=' + city);
  return parts.length ? `\n\nCONTEXTE CLIENT (pour personnaliser) : ${parts.join(', ')}.` : '';
}

// Normalise un historique [{role,content}] chronologique → messages valides Claude
// (fusionne les tours consécutifs de même rôle, commence par 'user').
function normalizeHistory(history) {
  const msgs = [];
  for (const h of history || []) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    const content = String(h.content || '').trim().slice(0, 600);
    if (!content || content === 'None') continue;
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += '\n' + content;
    else msgs.push({ role, content });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

// Appelle Claude. history = tours précédents (ancien→récent). Retourne {reply, intent, usage}. Throw si erreur API.
async function generateReply({ text, name, orderItems, total, city, history }) {
  let messages = normalizeHistory(history);
  if (!messages.length) {
    messages = [{ role: 'user', content: `Client${name ? ' (' + name + ')' : ''} a écrit : "${String(text).slice(0, 1500)}"` }];
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system: SYSTEM + buildContextNote({ name, orderItems, total, city }), messages }),
  });
  const data = await r.json();
  if (!r.ok) { const e = new Error('claude_error'); e.detail = data; throw e; }
  let raw = (data.content && data.content[0] && data.content[0].text) || '';
  let parsed = { reply: raw.trim(), intent: 'answer' };
  try { const m = raw.match(/\{[\s\S]*\}/); if (m) { const j = JSON.parse(m[0]); if (j.reply) parsed = { reply: j.reply, intent: j.intent || 'answer' }; } } catch (e) {}
  return { reply: parsed.reply, intent: parsed.intent, usage: data.usage };
}

// Décide quoi faire d'un message entrant. arg peut inclure `history` (tours précédents). opts: {bypassTime, unanswered, isButtonFlag}
// Retourne {send, reply, intent, skipped, hour, usage}
async function handleIncoming({ text, name, orderItems, total, city, history }, opts = {}) {
  if (!ANTHROPIC_KEY) return { send: false, skipped: 'no_key' };
  if (!text || String(text).trim().length === 0) return { send: false, skipped: 'no_text' };
  if (opts.isButtonFlag || isButton(text)) return { send: false, skipped: 'button' };
  if (!opts.bypassTime && !opts.unanswered && isWorkHours()) return { send: false, skipped: 'work_hours', hour: maroccoHour() };
  const g = await generateReply({ text, name, orderItems, total, city, history });
  return { send: !!(g.reply && g.reply.trim()), reply: g.reply, intent: g.intent, usage: g.usage };
}

module.exports = { FACTS, SYSTEM, BUTTON_LABELS, isButton, maroccoHour, isWorkHours, generateReply, handleIncoming };
