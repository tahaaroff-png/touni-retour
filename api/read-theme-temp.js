// TEMPORARY — Read theme assets to diagnose lazy loading image bug
// DELETE AFTER USE
// ?asset=sections/main-product.liquid  (or any key)
// ?action=list → list assets matching query
// ?action=search&q=lazyload → search content across key files

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

    const themeId = activeTheme.id;

    if (req.query.action === 'list') {
      const assR = await fetch(`https://${_SD}/admin/api/${_SV}/themes/${themeId}/assets.json`, { headers: hdrs });
      const assData = await assR.json();
      const q = (req.query.q || '').toLowerCase();
      const keys = (assData.assets || []).map(a => a.key).filter(k => !q || k.toLowerCase().includes(q));
      return res.json({ theme: activeTheme.name, id: themeId, assets: keys });
    }

    const assetKey = req.query.asset;
    if (!assetKey) return res.status(400).json({ error: 'Missing ?asset=' });

    const assetR = await fetch(
      `https://${_SD}/admin/api/${_SV}/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(assetKey)}`,
      { headers: hdrs }
    );
    const assetData = await assetR.json();
    return res.json({ key: assetKey, value: assetData.asset?.value });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
