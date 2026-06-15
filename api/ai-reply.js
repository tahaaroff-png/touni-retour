// Agent IA Touni (Claude) — répond aux messages WhatsApp clients (via eGrow Api Request).
// Sécurisé par ?secret=. La clé Claude est en variable d'env ANTHROPIC_API_KEY (jamais en clair).
const SECRET = 'touni-sync-2026';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = 'claude-sonnet-4-6';

// ───────── Faits business (à ajuster facilement) ─────────
const FACTS = {
  livraison: 'Livraison GRATUITE partout au Maroc, paiement à la livraison (cash). Délai 24–72h selon la ville.',
  retours: 'Échange de taille possible à la livraison (le livreur peut rapporter une autre taille). Pas de remboursement, mais échange OK.',
  tailles: 'Tailles dispo : S, M, L, XL, 2XL. (3XL/4XL sur certains maillots Maroc.)',
  flocage: 'Personnalisation possible : floquage Nom + Numéro pour +99 dh.',
  prix: 'Maillot ~329 dh · Kit complet (maillot+short) ~579–629 dh · Polo ~449 dh · T-shirt ~329 dh · Sweat/Hoodie ~449 dh · Casquette ~249 dh.',
};

const SYSTEM = `Tu es l'assistant WhatsApp de **Touni.ma**, une boutique marocaine de maillots de foot, ensembles, survêtements, casquettes et accessoires. Le client a (souvent) déjà passé une commande sur le site ; ton rôle = répondre à ses questions le soir/nuit quand l'équipe n'est pas dispo, le rassurer, et l'amener à CONFIRMER sa commande.

LANGUE : réponds TOUJOURS dans la langue du client. Par défaut **darija marocaine** naturelle et chaleureuse (lettres latines ou arabes selon ce qu'il écrit). S'il écrit en français → français. En arabe classique → arabe. Reste court (c'est WhatsApp), amical, 1–2 emojis max.

CE QUE TU SAIS (et que tu peux dire) :
- ${FACTS.livraison}
- ${FACTS.retours}
- ${FACTS.tailles}
- ${FACTS.flocage}
- Ordres de prix : ${FACTS.prix}

RÈGLES STRICTES :
- ❌ Ne JAMAIS citer une marque d'équipementier (surtout pas "Puma", ni Nike/Adidas comme argument). Ne dis JAMAIS "officiel", "authentique", "original".
- ❌ N'invente RIEN (ni prix exact d'un produit précis, ni délai garanti, ni promo). Si tu n'es pas sûr du prix/dispo d'un article précis, donne l'ordre de prix de la catégorie et dis que l'équipe confirme le détail.
- ❌ Ne recommande jamais une autre boutique.
- Si le client a un PROBLÈME (réclamation, colis perdu, remboursement, litige) → ne tente pas de régler, dis qu'un conseiller le recontacte très vite, et marque "escalate".
- Si le client CONFIRME clairement sa commande (ex : "wah", "ah", "n3am", "oui", "confirmé", "ok sf", "zid") → marque "confirm" et remercie chaleureusement en confirmant que la commande est validée et sera livrée.
- Sinon → "answer".

FORMAT DE SORTIE : réponds UNIQUEMENT avec un objet JSON valide, rien d'autre :
{"reply":"<ton message au client>","intent":"answer|confirm|escalate"}`;

module.exports = async (req, res) => {
  if ((req.query || {}).secret !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY missing' });
  try {
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    // champs souples (eGrow Api Request peut envoyer différents noms)
    const text = body.message || body.text || body.body || body.content || body.last_message || '';
    const name = body.customer_name || body.name || body.contact_name || body.first_name || '';
    const order = body.order || body.order_id || body.deal || '';
    if (!text || String(text).trim().length === 0) return res.status(200).json({ reply: '', intent: 'answer', skipped: 'no_text' });

    const userMsg = `Client${name ? ' (' + name + ')' : ''}${order ? ' — commande ' + order : ''} a écrit : "${String(text).slice(0, 1500)}"`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, system: SYSTEM, messages: [{ role: 'user', content: userMsg }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'claude_error', detail: data });
    let raw = (data.content && data.content[0] && data.content[0].text) || '';
    let parsed = { reply: raw.trim(), intent: 'answer' };
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) { const j = JSON.parse(m[0]); if (j.reply) parsed = { reply: j.reply, intent: j.intent || 'answer' }; }
    } catch (e) { /* garder raw */ }

    return res.status(200).json({ reply: parsed.reply, intent: parsed.intent, usage: data.usage });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
