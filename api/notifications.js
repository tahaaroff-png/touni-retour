// API simple pour les notifications Shopify (consultées par le dashboard admin)
// GET /api/notifications?secret=...&status=unread → liste
// PATCH /api/notifications?secret=...&id=XXX → marquer comme lu/archivé
// DELETE /api/notifications?secret=...&id=XXX → supprimer

const { SB_URL, supabaseHeaders } = require('./_shopify-helpers.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // FIX: Auth guard — protect all methods (not just mutation) to avoid exposing order data
  const expectedSecret = process.env.SYNC_SECRET || 'touni-sync-2026';
  const providedSecret = req.query?.secret || req.headers['x-sync-secret'];
  if (providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (req.method === 'GET') {
      const status = req.query?.status || 'unread';
      const limit = parseInt(req.query?.limit || '50');
      const url = `${SB_URL}/rest/v1/shopify_notifications?select=*&status=eq.${status}&order=created_at.desc&limit=${limit}`;
      const r = await fetch(url, { headers: supabaseHeaders(true) });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      return res.status(200).json({ notifications: data, count: data.length });
    }

    if (req.method === 'PATCH') {
      const id = req.query?.id;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const newStatus = req.query?.status || 'read';
      if (!['unread', 'read', 'archived'].includes(newStatus)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      const updateBody = { status: newStatus };
      if (newStatus === 'read') updateBody.read_at = new Date().toISOString();
      const r = await fetch(`${SB_URL}/rest/v1/shopify_notifications?id=eq.${id}`, {
        method: 'PATCH',
        headers: supabaseHeaders(true),
        body: JSON.stringify(updateBody),
      });
      if (!r.ok) throw new Error(await r.text());
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const r = await fetch(`${SB_URL}/rest/v1/shopify_notifications?id=eq.${id}`, {
        method: 'DELETE',
        headers: supabaseHeaders(true),
      });
      if (!r.ok) throw new Error(await r.text());
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
