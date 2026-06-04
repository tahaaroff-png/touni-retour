// TEMPORARY — Read theme assets
// DELETE AFTER USE
const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');
const SYNC_SECRET = process.env.SYNC_SECRET || '';

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const hdrs = await shopifyAdminHeaders();
  try {
    const themeR = await fetch(`https://${_SD}/admin/api/${_SV}/themes.json`, { headers: hdrs });
    const themes = await themeR.json();
    const activeTheme = (themes.themes || []).find(t => t.role === 'main');
    if (!activeTheme) return res.status(404).json({ error: 'No active theme' });
    if (req.query.action === 'list') {
      const r = await fetch(`https://${_SD}/admin/api/${_SV}/themes/${activeTheme.id}/assets.json`, { headers: hdrs });
      const d = await r.json();
      const q = (req.query.q || '').toLowerCase();
      return res.json({ assets: (d.assets||[]).map(a=>a.key).filter(k => !q || k.toLowerCase().includes(q)) });
    }
    const key = req.query.asset;
    if (!key) return res.status(400).json({ error: 'Missing ?asset=' });
    const r = await fetch(`https://${_SD}/admin/api/${_SV}/themes/${activeTheme.id}/assets.json?asset[key]=${encodeURIComponent(key)}`, { headers: hdrs });
    const d = await r.json();
    return res.json({ key, value: d.asset?.value });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
