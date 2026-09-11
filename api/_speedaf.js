// ════════════════════════════════════════════════════════════════════
//  Client Speedaf Express — Open API v2 (transporteur Touni.ma)
//  Doc : Open API 202607 V1.2. Auth = appCode + timestamp (ms) en query,
//  body JSON { data: ... }. AUCUNE signature en sortie (confirmé en prod).
//  Le webhook ENTRANT est signé HMAC-SHA256(secretKey, ts + "\n" + rawBody).
// ════════════════════════════════════════════════════════════════════
const crypto = require('crypto');

const SPEEDAF_BASE = process.env.SPEEDAF_BASE || 'https://apis.speedaf.com';
const SPEEDAF_APPCODE = process.env.SPEEDAF_APPCODE || '';
const SPEEDAF_SECRET = process.env.SPEEDAF_SECRET || '';
const SPEEDAF_CUSTOMER = process.env.SPEEDAF_CUSTOMER || '';
const SPEEDAF_PLATFORM = process.env.SPEEDAF_PLATFORM || 'Touni.ma';

function configured() { return !!(SPEEDAF_APPCODE); }

async function speedafPost(path, dataObj) {
  const ts = Date.now();
  const url = `${SPEEDAF_BASE}${path}?appCode=${encodeURIComponent(SPEEDAF_APPCODE)}&timestamp=${ts}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: dataObj }),
  });
  const txt = await r.text();
  let json; try { json = JSON.parse(txt); } catch { json = { success: false, raw: txt }; }
  return json;
}

// ── Créer un colis → renvoie billCode (numéro de suivi) + labelUrl ──
async function createOrder(o) {
  // o : objet déjà mappé au format Speedaf (voir buildOrderPayload)
  const base = {
    customerCode: SPEEDAF_CUSTOMER, platformSource: SPEEDAF_PLATFORM,
    parcelType: 'PT01', deliveryType: 'DE01', transportType: 'TT01', shipType: 'ST01',
    payMethod: 'PA02', isAllowOpen: 0, pickUpAging: 0, currencyType: 'MAD',
    acceptCountryCode: 'MA', acceptCountryName: 'Morocco',
    sendCountryCode: 'MA', sendCountryName: 'Morocco',
  };
  return speedafPost('/open-api/express/order/v2/createOrder', Object.assign(base, o));
}

// ── Annuler des colis ──
async function cancelOrder(billCode, cancelReason, by) {
  return speedafPost('/open-api/express/order/v2/cancelOrder',
    [{ customerCode: SPEEDAF_CUSTOMER, billCode, cancelReason: cancelReason || 'Annulation', cancelBy: by || 'touni.ma' }]);
}

// ── Étiquette (Maroc = labelType 46, 10x10) → PDF url + base64 ──
async function printLabel(billCodes, labelType = 46, withLogo = true) {
  return speedafPost('/open-api/express/order/v2/print',
    { waybillNoList: Array.isArray(billCodes) ? billCodes : [billCodes], labelType, withLogo });
}

// ── Suivi à la demande ──
async function track(mailNos) {
  return speedafPost('/open-api/express/track/v2/query',
    { mailNoList: Array.isArray(mailNos) ? mailNos : [mailNos] });
}

// ── Abonner notre webhook pour recevoir les évènements de suivi en push ──
async function subscribeWebhook(callbackUrl) {
  return speedafPost('/open-api/express/track/webhook/subscribe',
    { customerCode: SPEEDAF_CUSTOMER, callbackUrl, appCode: SPEEDAF_APPCODE });
}

// ── Vérifier la signature d'un webhook entrant Speedaf ──
function verifyWebhook(rawBody, timestamp, signatureHeader) {
  if (!SPEEDAF_SECRET || !signatureHeader) return false;
  const mac = crypto.createHmac('sha256', SPEEDAF_SECRET).update(`${timestamp}\n${rawBody}`).digest('hex');
  const expected = `hmac-sha256=${mac.toLowerCase()}`;
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signatureHeader))); }
  catch { return false; }
}

// ── Mapping code statut Speedaf → statut lisible + étape eGrow suggérée ──
// action/subAction (voir §5.2 doc). eGrow stage ids (V1) : Livrer 49152, Retourner 49153,
// Mise en distribution 49199, Ramassé 49213, En cours 49200.
const SPEEDAF_STATUS = {
  '1':     { label: 'Ramassé (Pick Up)',        egrowStage: 49213 },
  '2/2002':{ label: 'Départ du site',           egrowStage: 49200 },
  '3/3001':{ label: 'Arrivée au hub',           egrowStage: 49200 },
  '2/2001':{ label: 'Départ du hub',            egrowStage: 49200 },
  '4':     { label: 'En cours de livraison',    egrowStage: 49199 },
  '5':     { label: 'Livré',                    egrowStage: 49152 },
  '-710':  { label: 'En retour',                egrowStage: 49153 },
  '730':   { label: 'Retour signé',             egrowStage: 49153 },
};
function mapStatus(action, subAction) {
  return SPEEDAF_STATUS[`${action}/${subAction}`] || SPEEDAF_STATUS[String(action)] || { label: `Statut ${action}/${subAction}`, egrowStage: null };
}

module.exports = {
  configured, speedafPost, createOrder, cancelOrder, printLabel, track,
  subscribeWebhook, verifyWebhook, mapStatus, SPEEDAF_STATUS,
};
