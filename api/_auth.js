// Mot de passe d'accès aux API de gestion (stock, commandes, synchro…).
// SYNC_SECRET_NEW = nouveau code (équipe). SYNC_SECRET / ancien code = encore accepté tant que SYNC_ALLOW_OLD !== '0' (période de transition).
function syncOk(provided) {
  const p = String(provided || '');
  if (!p) return false;
  const nw = process.env.SYNC_SECRET_NEW || '';
  if (nw && p === nw) return true;
  if (process.env.SYNC_ALLOW_OLD === '0') return false;
  return p === (process.env.SYNC_SECRET || 'touni-sync-2026');
}
module.exports = { syncOk };
