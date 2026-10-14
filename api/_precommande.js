// ───────────────────────────────────────
// PRÉCOMMANDE MAGASIN — catalogue (Shopify public + stock magasin + prix ajustés) et création de commande eGrow V2.
// Fichier préfixé "_" : exclu du compte de fonctions Vercel. Branché dans notifications.js
//   GET  /api/notifications?secret=…&precommande=catalog
//   POST /api/notifications?secret=…&action=precommande_create
// La commande est créée à l'étape 70661 « Attente retrait magasin » (même mutation que le bot).
// ───────────────────────────────────────
const STAGE_ATTENTE_RETRAIT = 70661;
const SHOPIFY_CONN = 5631;     // connexion Shopify Touni.ma dans eGrow (exigée pour lier les lignes aux produits)
const WA_CONN = 7887;          // 0625254090
const MAILLOT_TYPES = new Set(['Maillot', 'Maillot de football', 'Maillot Rétro', 'retro']);
const SELF = process.env.SELF_URL || 'https://touni-retour.vercel.app';
const nrm = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

let CACHE = null, REFRESHING = null;

async function loadCatalog(secret) {
  const page = async (p) => (await (await fetch(`https://touni.ma/products.json?limit=250&page=${p}`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json()).products || [];
  const first = await Promise.all([1, 2, 3, 4].map(page));
  let all = [].concat(...first);
  for (let p = 5; first[first.length - 1].length === 250 && p <= 10; p++) { const x = await page(p); all = all.concat(x); if (x.length < 250) break; }
  const [stockRes, ovRes] = await Promise.all([
    fetch(`${SELF}/api/notifications?cat=list&secret=${encodeURIComponent(secret)}`).then((r) => r.json()).catch(() => ({})),
    fetch(`${SELF}/api/notifications?action=cat_price_get&secret=${encodeURIComponent(secret)}`).then((r) => r.json()).catch(() => ({})),
  ]);
  const stock = {}; (stockRes.products || []).forEach((p) => { const m = {}; (p.sizes || []).forEach((s) => { m[String(s.size).toUpperCase().replace('XXL', '2XL')] = s.qty; }); stock[nrm(p.product)] = m; });
  const ovn = {}; Object.entries(ovRes.overrides || {}).forEach(([k, v]) => (ovn[nrm(k)] = v));
  const map = (p) => ({
    id: p.id, handle: p.handle, title: p.title, type: p.product_type || '',
    image: ((p.images[0] && p.images[0].src) || '').replace(/^https:\/\/cdn\.shopify\.com\/s\/files\/1\/0774\/1312\/2267\//, '~'),
    price: Math.min(...p.variants.map((v) => parseFloat(v.price))),
    sizes: ((p.options.find((o) => /taille|size/i.test(o.name)) || {}).values) || [],
    av: p.variants.filter((v) => v.available).map((v) => v.title.split(' / ')[0]),
    vid: Object.fromEntries(p.variants.map((v) => [v.title.split(' / ')[0], { id: v.id, sku: v.sku || '' }])),
    pk: [].concat((p.tags || []).map((t) => String(t).toLowerCase()).includes('coupe du monde 2026') ? ['cdm'] : [], (p.tags || []).map((t) => String(t).toLowerCase()).includes('champions league') ? ['cl'] : []),
  });
  const flocage = all.filter((p) => p.product_type === 'Personnalisation').map(map);
  const patchsRaw = all.filter((p) => p.product_type === 'Patch' || /^Patch /.test(p.title));
  // Produit patch multi-coloris (prix différents) → un choix par coloris, avec SON prix et SA variante.
  const patchs = [];
  const singles = patchsRaw.filter((p) => p.variants.length <= 1);
  singles.forEach((p) => patchs.push(map(p)));
  // Produit patch multi-coloris → un choix par coloris SEULEMENT si ce coloris n'existe pas déjà comme produit séparé
  // (les produits séparés sont ceux qu'eGrow connaît : ligne de commande liée au bon produit).
  const normC = (t) => nrm(t).replace(/wc 2026|football unites the world|brode thermocollant|[^a-z0-9]+/g, ' ').trim();
  patchsRaw.filter((p) => p.variants.length > 1).forEach((p) => {
    const m = map(p);
    p.variants.forEach((v) => {
      const c = normC(v.title);
      if (singles.some((sp) => normC(sp.title).includes(c) || c.includes(normC(sp.title).replace(/^patch /, '')))) return;
      patchs.push(Object.assign({}, m, { title: `${p.title} · ${v.title}`, price: parseFloat(v.price), vid: { [v.title]: { id: v.id, sku: v.sku || '' } } }));
    });
  });
  patchs.forEach((x) => { x.kind = /champions league/i.test(x.title) ? 'cl' : 'cdm'; });
  const skip = new Set([...flocage, ...patchs].map((p) => p.id));
  const products = all.filter((p) => !skip.has(p.id) && !/Mystère|MYSTERE|Mystere/i.test(p.title))
    .map((p) => { const m = map(p); const k = nrm(p.title); return Object.assign(m, { custom: MAILLOT_TYPES.has(p.product_type), stock: stock[k] || null, override: ovn[k] || null }); });
  return { products, flocage, patchs, ts: Date.now() };
}

// Sert l'ancienne version tout de suite si périmée (>3 min) et rafraîchit en arrière-plan.
async function catalog(secret) {
  const refresh = () => (REFRESHING = REFRESHING || loadCatalog(secret).then((c) => { CACHE = c; }).catch(() => {}).finally(() => { REFRESHING = null; }));
  if (!CACHE) await refresh();
  else if (Date.now() - CACHE.ts > 180000) refresh();
  return CACHE || { products: [], flocage: [], patchs: [], ts: 0 };
}

// Retrouve le produit/variante eGrow (ids internes) à partir de l'id Shopify de la connexion Touni → la ligne est LIÉE au produit (image, fiche).
const RESOLVED = new Map();
async function resolveEgrow(egrowKey, title, extPid, extVid) {
  const key = extPid + ':' + (extVid || '');
  if (RESOLVED.has(key)) return RESOLVED.get(key);
  let out = null;
  try {
    const q = `{ products(perPage:20, query:${JSON.stringify(String(title).slice(0, 60))}){ nodes{ id title externalIds{ externalProductId userConnection{ id } } variants{ id title externalIds{ externalVariantId } } } } }`;
    const r = await fetch('https://api5.egrow.com/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': egrowKey, 'User-Agent': 'Mozilla/5.0' }, body: JSON.stringify({ query: q }) });
    const nodes = (((await r.json()).data || {}).products || {}).nodes || [];
    const prod = nodes.find((p) => (p.externalIds || []).some((e) => String(e.externalProductId) === String(extPid) && Number(e.userConnection && e.userConnection.id) === SHOPIFY_CONN));
    if (prod) {
      const vr = (prod.variants || []).find((v) => extVid && (v.externalIds || []).some((e) => String(e.externalVariantId) === String(extVid))) || (prod.variants || [])[0];
      out = { productId: prod.id, variantId: vr ? vr.id : undefined };
    }
  } catch (e) {}
  RESOLVED.set(key, out);
  return out;
}

async function createOrder(b, egrowKey) {
  if (!b || !b.client || !Array.isArray(b.lignes) || !b.lignes.length) return { ok: false, userErrors: [{ message: 'Panier vide' }] };
  const digits = String(b.client.telephone || '').replace(/\D/g, '').replace(/^0/, '212');
  if (digits.length < 11) return { ok: false, userErrors: [{ message: 'Téléphone invalide' }] };
  const lineItems = []; let value = 0; const notes = [];
  const img = (u) => (u || '').replace(/^~/, 'https://cdn.shopify.com/s/files/1/0774/1312/2267/');
  for (const l of b.lignes) {
    const qty = Math.max(1, parseInt(l.qty, 10) || 1);
    const base = l.unit - (l.flocage ? l.flocage.prix : 0) - (l.patches || (l.patch ? [l.patch] : [])).reduce((a, x) => a + x.prix, 0);
    const v = (l.vid && l.vid[l.size]) || {};
    lineItems.push({ title: (l.size ? `${l.title} - ${l.size}` : l.title).slice(0, 250), quantity: qty, price: base, requiresShipping: true,
      userConnectionId: SHOPIFY_CONN, externalProductId: String(l.pid), externalVariantId: v.id ? String(v.id) : undefined, sku: v.sku || undefined, imageUrl: img(l.image) || undefined,
      metadata: { source: 'precommande_magasin', taille: l.size || null, flocage: l.flocage ? { nom: l.flocage.nom, numero: l.flocage.numero } : null, patch: (l.patches || (l.patch ? [l.patch] : [])).map((x) => x.titre) } });
    value += base * qty;
    if (l.flocage) {
      lineItems.push({ title: 'Flocage Personnalisé PRO - Nom + Numéro', quantity: qty, price: l.flocage.prix, requiresShipping: false, userConnectionId: SHOPIFY_CONN, externalProductId: String(l.flocage.pid),
        externalVariantId: l.flocage.vid ? String(l.flocage.vid) : undefined, metadata: { source: 'precommande_magasin', pour: l.title, nom: l.flocage.nom, numero: l.flocage.numero } });
      value += l.flocage.prix * qty; notes.push(`FLOCAGE ${l.title}: ${[l.flocage.nom, l.flocage.numero].filter(Boolean).join(' ')}`);
    }
    for (const pt of (l.patches || (l.patch ? [l.patch] : []))) {
      lineItems.push({ title: String(pt.titre).slice(0, 250), quantity: qty, price: pt.prix, requiresShipping: false, userConnectionId: SHOPIFY_CONN, externalProductId: String(pt.pid),
        externalVariantId: pt.vid ? String(pt.vid) : undefined, imageUrl: img(pt.image) || undefined, metadata: { source: 'precommande_magasin', pour: l.title } });
      value += pt.prix * qty; notes.push(`PATCH ${l.title}: ${pt.titre}`);
    }
  }
  // Liaison produit : id internes eGrow si le produit existe côté Touni, sinon on garde les ids Shopify et on signale.
  const unlinked = [];
  for (const li of lineItems) {
    if (!li.externalProductId) continue;
    const hit = await resolveEgrow(egrowKey, li.title.replace(/ - [^-]+$/, '').replace(/ · .*$/, ''), li.externalProductId, li.externalVariantId);
    if (hit) { li.productId = hit.productId; if (hit.variantId) li.variantId = hit.variantId; delete li.externalProductId; delete li.externalVariantId; delete li.userConnectionId; }
    else unlinked.push(li.title);
  }
  // Prix total saisi à la main : l'écart est reporté sur les lignes ARTICLE (flocage/patch gardent leur prix catalogue)
  if (b.total_override != null && Number.isFinite(+b.total_override) && Math.round(+b.total_override) !== Math.round(value)) {
    const target = Math.round(+b.total_override), art = lineItems.filter((x) => x.requiresShipping);
    const artSum = art.reduce((a, x) => a + x.price * x.quantity, 0), others = value - artSum, want = target - others;
    if (want < 0 || !art.length) return { ok: false, userErrors: [{ message: 'Total saisi trop bas par rapport au flocage/patch.' }] };
    let left = want;
    art.forEach((x, i) => { const share = i === art.length - 1 ? left : Math.round(want * (x.price * x.quantity) / (artSum || 1)); const unitP = Math.round((share / x.quantity) * 100) / 100; x.price = unitP; left -= unitP * x.quantity; });
    value = target; notes.push(`PRIX TOTAL IMPOSÉ ${target} DH (calculé ${Math.round(b.total)} DH)`);
  }
  const parts = String(b.client.nom || '').trim().split(/\s+/);
  const input = { phone: digits, customer: { firstName: parts[0] || '', lastName: parts.slice(1).join(' '), phone: digits },
    shippingAddress: { firstName: b.client.nom, phone: digits, city: 'Casablanca', address1: 'Retrait magasin Touni (Sidi Maârouf)', countryCode: 'MA' },
    lineItems, pipelineId: STAGE_ATTENTE_RETRAIT, note: ('PRÉCOMMANDE MAGASIN (retrait au magasin) ' + (b.test ? '[TEST] ' : '') + '| ' + notes.join(' / ')).slice(0, 1500),
    paymentMethod: 'Cash on Delivery (COD)', currency: 'MAD', subtotal: value, sourceUserConnectionId: WA_CONN };
  const r = await fetch('https://api5.egrow.com/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': egrowKey, 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ query: 'mutation($in:OrderCreateOrUpdateInput!){ orderCreateOrUpdate(input:$in){ userErrors{ field message } order{ id orderNumber } } }', variables: { in: input } }) });
  const j = await r.json();
  if (j.errors) return { ok: false, errors: j.errors };
  const n = j.data.orderCreateOrUpdate;
  return { ok: !(n.userErrors || []).length && !!n.order, userErrors: n.userErrors, order: n.order, unlinked };
}

module.exports = { catalog, createOrder };
