// Poller agent IA Touni — lit l'inbox eGrow, répond via Claude, envoie via l'API eGrow.
// Contourne le déclencheur eGrow (cassé). Appelé par un cron toutes les ~1-2 min.
// Sécurité : ?secret= obligatoire. Tokens eGrow en env. Anti-doublon via Supabase (table wa_agent_replied).
const { handleIncoming } = require('./_agent.js');
const { SB_URL, supabaseHeaders } = require('./_shopify-helpers.js');

const SECRET = 'touni-sync-2026';
const EGROW_ME = process.env.EGROW_ME || '';
const EGROW_AK = process.env.EGROW_AK || '';
const EGROW_BASE = 'https://api.egrow.com';
const INTEGRATIONS = (process.env.EGROW_INTEGRATIONS || '5425').split(',').map((s) => s.trim()).filter(Boolean);
const FRESH_WINDOW_SEC = parseInt(process.env.EGROW_FRESH_SEC || '600', 10); // ne répond qu'aux messages des 10 dernières min
const MAX_PER_RUN = parseInt(process.env.EGROW_MAX_PER_RUN || '8', 10);      // garde-fou anti-blast

async function egrowGetConversations(integrationId, page) {
  const url = `${EGROW_BASE}/inbox/get_conversations.php?me=${EGROW_ME}&dev=0&integrationId=${integrationId}&page=${page}&limit=20`;
  const r = await fetch(url, { headers: { 'account-key': EGROW_AK } });
  const j = await r.json();
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

async function alreadyReplied(msgId) {
  const r = await fetch(`${SB_URL}/rest/v1/wa_agent_replied?msg_id=eq.${encodeURIComponent(msgId)}&select=msg_id`, { headers: supabaseHeaders(true) });
  const j = await r.json().catch(() => []);
  return Array.isArray(j) && j.length > 0;
}

async function markReplied(msgId, convId, phone, preview) {
  await fetch(`${SB_URL}/rest/v1/wa_agent_replied`, {
    method: 'POST',
    headers: Object.assign({}, supabaseHeaders(true), { 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates' }),
    body: JSON.stringify({ msg_id: String(msgId), conv_id: String(convId), contact_phone: String(phone || ''), body_preview: String(preview || '').slice(0, 200) }),
  }).catch(() => {});
}

module.exports = async (req, res) => {
  const q = req.query || {};
  if (q.secret !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (!EGROW_ME || !EGROW_AK) return res.status(503).json({ error: 'egrow_tokens_missing' });

  const dry = q.dry === '1';          // dry-run : ne pas envoyer, juste lister ce qui serait fait
  const bypassTime = q.test === '1';  // ignorer la porte horaire (test en journée)
  const onlyPhone = (q.only || '').toString().replace(/\D/g, ''); // limiter à un numéro précis (test ciblé)
  const nowSec = Math.floor(Date.now() / 1000);
  const results = [];
  let processed = 0;

  try {
    for (const integrationId of INTEGRATIONS) {
      const convs = await egrowGetConversations(integrationId, 1);
      for (const c of convs) {
        if (processed >= MAX_PER_RUN) break;
        const lm = c.lastMessage || {};
        const contactWaId = String(c.contactWaId || '');
        const senderWaId = String(lm.senderWaId || '');
        const lastTime = parseInt(c.lastMessageTime || lm.sentAt || '0', 10);
        const body = (lm.body || (lm.content && lm.content.body) || '').toString();
        const type = (lm.type || '').toString();
        const msgId = String(lm.id || '');

        if (onlyPhone && contactWaId !== onlyPhone) continue;
        // Le DERNIER message doit être ENTRANT (du client) = conversation sans réponse humaine.
        const incoming = senderWaId && contactWaId && senderWaId === contactWaId;
        if (!incoming) continue;
        // Frais uniquement (jamais le backlog).
        if (!lastTime || (nowSec - lastTime) > FRESH_WINDOW_SEC) continue;
        // Texte uniquement (pas template/image/bouton interactif).
        if (type && type !== 'text') continue;
        if (!msgId || !body.trim()) continue;
        if (await alreadyReplied(msgId)) continue;

        const decision = await handleIncoming(
          { text: body, name: c.title || (c.contact && c.contact.name) || '', city: (c.contact && c.contact.city) || '' },
          { bypassTime }
        );
        const entry = { conv: c.id, phone: contactWaId, name: c.title, msgId, body: body.slice(0, 60), decision: decision.skipped || (decision.send ? 'reply' : 'no_send') };

        if (decision.send && decision.reply) {
          if (dry) {
            entry.reply_preview = decision.reply.slice(0, 140);
          } else {
            const sendRes = await egrowSend(integrationId, contactWaId, decision.reply);
            entry.sent = sendRes && sendRes.status;
            await markReplied(msgId, c.id, contactWaId, body);
          }
          entry.intent = decision.intent;
          processed++;
        }
        results.push(entry);
      }
    }
    return res.status(200).json({ ok: true, dry, bypassTime, processed, count: results.length, results });
  } catch (e) {
    return res.status(500).json({ error: String(e), stack: (e && e.stack || '').split('\n').slice(0, 3) });
  }
};
