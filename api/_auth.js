// Accès aux API de gestion — DEUX niveaux :
//  • ÉQUIPE (SYNC_SECRET_NEW) : stock, commandes, inventaire, précommande, catalogue…
//  • PATRON (SYNC_SECRET_BOSS) : tout ça + données confidentielles (Meta Ads…)
// TRANSITION : l'ancien mot de passe partagé (SYNC_SECRET / 'touni-sync-2026') reste accepté (niveau patron) tant que SYNC_ALLOW_OLD !== '0'.
function _old(p) { return process.env.SYNC_ALLOW_OLD !== '0' && p === (process.env.SYNC_SECRET || 'touni-sync-2026'); }
function bossOk(provided) {
  const p = String(provided || ''); if (!p) return false;
  const b = process.env.SYNC_SECRET_BOSS || '';
  return (b && p === b) || _old(p);
}
function syncOk(provided) {
  const p = String(provided || ''); if (!p) return false;
  const t = process.env.SYNC_SECRET_NEW || '';
  return (t && p === t) || bossOk(p);
}
module.exports = { syncOk, bossOk };
