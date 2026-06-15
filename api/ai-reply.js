// Agent IA Touni (Claude) — répond aux messages WhatsApp clients (via eGrow Api Request).
// Sécurisé par ?secret=. Clé Claude en variable d'env ANTHROPIC_API_KEY (jamais en clair).
const SECRET = 'touni-sync-2026';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = 'claude-sonnet-4-6';

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
 Guide : S=160-170cm/50-62kg · M=168-176/63-73 · L=174-182/74-83 · XL=180-188/84-95 · 2XL=186-195/96-115.
 CONSEIL : toujours suggérer de prendre une taille AU-DESSUS pour être sûr (coupe ajustée).

PRIX (ordres de grandeur, en promo) : Maillot ~329 dh · Kit complet (maillot+short) ~579–629 dh · Polo ~449 dh · T-shirt ~329 dh · Sweat/Hoodie ~449 dh · Casquette ~249 dh. Si le client a une commande précise, utilise le prix de SA commande (ci-dessous) ; sinon donne l'ordre de grandeur et dis que l'équipe confirme le détail.

PROMO EN COURS : 3 maillots achetés = le 4ème OFFERT en mystère 🎁 (c'est une surprise), dans la taille voulue. La taille du maillot mystère est confirmée par l'opératrice lors de l'appel.

QUALITÉ (très important) : si on demande la qualité → c'est une qualité PROFESSIONNELLE identique à l'original : mêmes finitions, même couture, mêmes tissus — juste le prix qui est très très motivant. NE JAMAIS dire "copie", "réplique", "fake", ni "contrefaçon". Joue sur la qualité pro et le très bon prix.
`;

const SYSTEM = `Tu es l'assistant WhatsApp de **Touni.ma**, boutique marocaine de maillots de foot, kits, survêtements, casquettes et accessoires. Clientèle : supporters marocains (Wydad, Raja, équipe nationale), fans de clubs internationaux, et parents qui achètent des cadeaux. Le client a souvent déjà passé une commande.

TON RÔLE : on travaille de 9h à 18h. En dehors de ces heures, tu réponds à la place de l'équipe pour ne pas laisser le client sans réponse — tu le rassures, tu réponds à ses questions, et tu l'amènes à CONFIRMER sa commande. C'est l'objectif n°1 : maximiser les confirmations.

LANGUE : réponds TOUJOURS dans la langue du client. Par défaut **darija marocaine** naturelle et chaleureuse (latin ou arabe selon ce qu'il écrit). Français s'il écrit en français, arabe classique s'il écrit en arabe. Court (c'est WhatsApp), amical, 1–2 emojis max. Tutoiement.

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

module.exports = async (req, res) => {
  if ((req.query || {}).secret !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY missing' });
  try {
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const text = body.message || body.text || body.body || body.content || body.last_message || '';
    const name = body.customer_name || body.name || body.contact_name || body.first_name || '';
    const orderItems = body.order_items || body.products || body.items || '';
    const total = body.total || body.order_total || body.amount || '';
    const city = body.city || body.ville || '';
    if (!text || String(text).trim().length === 0) return res.status(200).json({ reply: '', send: false, intent: 'answer', skipped: 'no_text' });

    // ───────── Portes (l'intelligence est ici, pas dans eGrow) ─────────
    const q = req.query || {};
    const bypass = q.test === '1' || q.force === '1' || body.test === true; // pour tester à toute heure
    // 1) Ignorer les clics sur boutons de template (si eGrow nous passe le flag)
    const isButton = body.is_button === true || body.is_button === 'true' || body.is_button === 1 || body.is_button === '1' || body.from_button === true || body.from_button === 'true';
    if (isButton && !bypass) return res.status(200).json({ reply: '', send: false, intent: 'skip', skipped: 'button' });
    // 2) Heure du Maroc : ne répondre QUE hors heures opératrice (18h→9h). 'unanswered=1' force la réponse (branche "1h sans réponse").
    const unanswered = body.unanswered === true || body.unanswered === 'true' || q.unanswered === '1';
    let maHour = null;
    try { maHour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Casablanca', hour: '2-digit', hour12: false }).format(new Date()), 10); } catch (e) {}
    const inWorkHours = maHour !== null && maHour >= 9 && maHour < 18;
    if (!bypass && !unanswered && inWorkHours) return res.status(200).json({ reply: '', send: false, intent: 'skip', skipped: 'work_hours', hour: maHour });

    let ctx = '';
    if (orderItems || total || city) {
      ctx = `\n[Commande du client : ${orderItems ? 'produits=' + JSON.stringify(orderItems) + ' ' : ''}${total ? 'total=' + total + ' dh ' : ''}${city ? 'ville=' + city : ''}]`;
    }
    const userMsg = `Client${name ? ' (' + name + ')' : ''} a écrit : "${String(text).slice(0, 1500)}"${ctx}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system: SYSTEM, messages: [{ role: 'user', content: userMsg }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'claude_error', detail: data });
    let raw = (data.content && data.content[0] && data.content[0].text) || '';
    let parsed = { reply: raw.trim(), intent: 'answer' };
    try { const m = raw.match(/\{[\s\S]*\}/); if (m) { const j = JSON.parse(m[0]); if (j.reply) parsed = { reply: j.reply, intent: j.intent || 'answer' }; } } catch (e) {}
    return res.status(200).json({ reply: parsed.reply, intent: parsed.intent, send: parsed.reply && parsed.reply.trim().length > 0 ? true : false, usage: data.usage });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
