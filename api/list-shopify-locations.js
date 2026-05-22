// Liste les locations Shopify pour aider à configurer SHOPIFY_LOCATION_ID
// Utilisé une seule fois au setup
const { SHOPIFY_CLIENT_ID, listLocations } = require('./_shopify-helpers.js');

module.exports = async function handler(req, res) {
  const expectedSecret = process.env.SYNC_SECRET || 'touni-sync-2026';
  const providedSecret = req.query?.secret || req.headers['x-sync-secret'];
  if (providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SHOPIFY_CLIENT_ID) {
    return res.status(503).json({ error: 'SHOPIFY_CLIENT_ID not configured' });
  }
  try {
    const locations = await listLocations();
    return res.status(200).json({
      locations: locations.map(l => ({
        id: l.id,
        name: l.name,
        address: l.address1,
        city: l.city,
        active: l.active,
        primary: l.legacy ? false : (l.id === locations[0]?.id),
      })),
      hint: 'Set SHOPIFY_LOCATION_ID to the active+primary location id',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
