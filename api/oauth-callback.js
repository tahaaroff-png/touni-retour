// OAuth callback pour installer l'app Dev Dashboard sur la boutique
// Visiter /api/oauth-install?secret=touni-sync-2026 pour lancer l'installation

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '65e7c4bb41dec7a0383faf39512459da';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const SHOP = process.env.SHOPIFY_DOMAIN || 'bjuanm-1r.myshopify.com';
const SCOPES = 'read_products,write_products,read_inventory,write_inventory,read_locations,read_orders,write_orders,read_customers,write_customers,read_themes,write_themes,read_discounts,write_discounts,read_shipping,read_fulfillments,write_fulfillments,read_translations,write_translations';
const REDIRECT_URI = 'https://touni-retour.vercel.app/api/oauth-callback';

const SB_URL = process.env.SUPABASE_URL || 'https://dwjjrgjbkftejdcmwpgc.supabase.co';
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR3ampyZ2pia2Z0ZWpkY213cGdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0NzI2MDYsImV4cCI6MjA5MTA0ODYwNn0.6GxM9u1Om7zP-_MEYVhdtHBESyGLDZGFofxSKGwixPo';

module.exports = async function handler(req, res) {
  const { code, shop, error, secret } = req.query;

  // Step 1: Initiate install (GET /api/oauth-callback?secret=xxx)
  if (secret) {
    const expectedSecret = process.env.SYNC_SECRET || 'touni-sync-2026';
    if (secret !== expectedSecret) return res.status(401).json({ error: 'Unauthorized' });
    const installUrl = `https://${SHOP}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${encodeURIComponent(SCOPES)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
    return res.redirect(installUrl);
  }

  // Step 2: Handle OAuth callback
  if (error) {
    return res.status(400).json({ error, message: 'OAuth authorization failed' });
  }

  if (!code) {
    return res.status(400).json({ error: 'Missing code parameter' });
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      return res.status(400).json({ error: 'Token exchange failed', details: tokenData });
    }

    // Sauvegarder le token d'installation dans Supabase (a les scopes OAuth complets)
    await fetch(`${SB_URL}/rest/v1/app_settings`, {
      method: 'POST',
      headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${SB_ANON_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ key: 'shopify_install_token', value: tokenData.access_token, updated_at: new Date().toISOString() }),
    }).catch(() => {});

    // App is now installed — verify with client_credentials
    const ccRes = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`,
    });
    const ccData = await ccRes.json();

    return res.status(200).json({
      success: true,
      message: 'App installée avec succès !',
      install_token_preview: tokenData.access_token?.slice(0, 12) + '...',
      client_credentials_works: !!ccData.access_token,
      cc_token_preview: ccData.access_token ? ccData.access_token.slice(0, 12) + '...' : null,
      expires_in: ccData.expires_in,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
