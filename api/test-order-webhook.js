// Endpoint de diagnostic — simule un ordre Shopify sans HMAC
// GET /api/test-order-webhook?secret=touni-sync-2026&title=TITRE&size=M&color=Noir
// POST /api/test-order-webhook?secret=touni-sync-2026  (body JSON = payload Shopify réel)

const { SB_URL, supabaseHeaders, normalizeSize, normalizeColor } = require('./_shopify-helpers.js');

function jaccardSim(a, b) {
  const tokenize = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  const sa = tokenize(a); const sb = tokenize(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

async function findMatchingStock(productTitle, size, color) {
  const normSize = normalizeSize(size);
  const normColor = normalizeColor(color);

  const filterBySizeColor = (rows) => rows.filter(c => {
    const parts = String(c.size || '').split('|');
    const cSize = parts[0] ? parts[0].trim() : '';
    const cColor = parts.length > 1 ? parts[1].trim() : '';
    const ms = normalizeSize(cSize);
    const mc = normalizeColor(cColor);
    if (ms !== normSize) return false;
    if (normColor && mc !== normColor) return false;
    return true;
  });

  // 1) Exact
  const exactUrl = `${SB_URL}/rest/v1/stock?select=id,product,size,qty,status&product=eq.${encodeURIComponent(productTitle)}&qty=gt.0&status=eq.retour`;
  const exactRes = await fetch(exactUrl, { headers: supabaseHeaders() });
  const exactAll = exactRes.ok ? await exactRes.json() : [];
  const exactMatched = filterBySizeColor(exactAll);
  if (exactMatched.length) return { method: 'exact', matches: exactMatched, allByTitle: exactAll };

  // 2) Fuzzy
  const allUrl = `${SB_URL}/rest/v1/stock?select=id,product,size,qty,status&qty=gt.0&status=eq.retour&limit=500`;
  const allRes = await fetch(allUrl, { headers: supabaseHeaders() });
  const allStock = allRes.ok ? await allRes.json() : [];

  const scored = allStock
    .map(s => ({ ...s, _score: jaccardSim(productTitle, s.product) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, 10); // top 10 pour debug

  const above = scored.filter(s => s._score >= 0.55);
  if (above.length) {
    const topScore = above[0]._score;
    const bestGroup = above.filter(s => s._score >= topScore - 0.05);
    return { method: 'fuzzy', topScore, matches: filterBySizeColor(bestGroup), bestGroup };
  }

  return { method: 'none', matches: [], top10: scored };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const expectedSecret = process.env.SYNC_SECRET || 'touni-sync-2026';
  const secret = req.query?.secret || req.headers['x-sync-secret'];
  if (secret !== expectedSecret) return res.status(401).json({ error: 'Unauthorized' });

  // ── GET : simulation manuelle ──
  if (req.method === 'GET') {
    const { title, size, color } = req.query;
    if (!title) return res.status(400).json({ error: 'Missing ?title= param' });

    const result = await findMatchingStock(title, size || null, color || null);
    const normSize = normalizeSize(size);
    const normColor = normalizeColor(color);

    return res.status(200).json({
      input: { title, size, color },
      normalized: { normSize, normColor },
      ...result,
    });
  }

  // ── POST : tester avec un vrai payload Shopify order ──
  if (req.method === 'POST') {
    let body;
    try {
      body = req.body || {};
    } catch(e) {
      return res.status(400).json({ error: 'Bad JSON: '+e.message });
    }

    const lineItems = body.line_items || [];
    const report = [];
    for (const item of lineItems) {
      const productTitle = item.title || '';
      const variantTitle = item.variant_title || '';
      const parts = variantTitle.split(/\s*[\/\|]\s*/).map(p => p.trim());
      const SIZE_LITERALS = new Set(['XS','S','M','L','XL','XXL','2XL','3XL','4XL']);
      let size = null, color = null;
      if (parts.length === 1) {
        if (SIZE_LITERALS.has(parts[0].toUpperCase())) size = parts[0];
        else color = parts[0];
      } else {
        size = parts[0] || null;
        color = parts.slice(1).join(' / ') || null;
      }
      const result = await findMatchingStock(productTitle, size, color);
      report.push({ productTitle, variantTitle, size, color, ...result });
    }
    return res.status(200).json({ line_items_count: lineItems.length, report });
  }

  return res.status(405).json({ error: 'Use GET or POST' });
};
