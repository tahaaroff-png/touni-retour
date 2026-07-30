// Inscription newsletter depuis le footer du site (touni.ma « Le Vestiaire »).
//
// POST /api/newsletter  { email }
// Crée / abonne un client Shopify avec le tag "newsletter" côté serveur (Admin API),
// donc SANS dépendre du reCAPTCHA Shopify (qui casse sous le thème Nitro).
//
// Réponses : 200 {ok:true,status:'subscribed'|'already'} | 400 email invalide | 5xx erreur.

const { shopifyAdminHeaders, SHOPIFY_DOMAIN, SHOPIFY_API_VERSION } = require('./_shopify-helpers.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const email = ((body && body.email) || '').trim().toLowerCase();
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!re.test(email)) return res.status(400).json({ ok: false, error: 'Email invalide' });

  try {
    const headers = await shopifyAdminHeaders();
    const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/customers.json`;
    const payload = {
      customer: {
        email,
        tags: 'newsletter',
        email_marketing_consent: { state: 'subscribed', opt_in_level: 'single_opt_in' },
      },
    };
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (r.ok) return res.status(200).json({ ok: true, status: 'subscribed' });

    const txt = await r.text();
    // Déjà client → inscription idempotente : on considère que c'est bon.
    if (r.status === 422 && /already been taken|has already|déjà/i.test(txt)) {
      return res.status(200).json({ ok: true, status: 'already' });
    }
    return res.status(502).json({ ok: false, error: 'Shopify: ' + txt.slice(0, 200) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
