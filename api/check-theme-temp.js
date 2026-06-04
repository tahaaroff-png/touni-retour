// TEMPORARY — List all themes + read seo-faq.liquid on each published theme
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  try {
    const hdrs = await shopifyAdminHeaders();

    // List all themes
    const r = await fetch(`https://${_SD}/admin/api/${_SV}/themes.json`, { headers: hdrs });
    const data = await r.json();
    const themes = data.themes || [];

    const result = [];
    for (const t of themes) {
      const entry = {
        id: t.id,
        name: t.name,
        role: t.role, // "main" = live
        created_at: t.created_at,
        updated_at: t.updated_at,
      };

      // Read seo-faq.liquid for this theme
      const ar = await fetch(
        `https://${_SD}/admin/api/${_SV}/themes/${t.id}/assets.json?asset[key]=sections/seo-faq.liquid`,
        { headers: hdrs }
      );
      if (ar.ok) {
        const ad = await ar.json();
        entry.faq_snippet = (ad.asset?.value || '').slice(0, 120);
        entry.faq_updated_at = ad.asset?.updated_at;
      } else {
        entry.faq_snippet = `[error ${ar.status}]`;
      }

      result.push(entry);
    }

    res.json({ themes: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
