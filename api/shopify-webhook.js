// Vercel serverless function — Shopify webhook handler
// Triggers on: products/create, products/update, products/delete
// Uses the public Shopify storefront JSON (no token needed)
// Commits updated products.json to GitHub → Vercel auto-redeploys

const crypto = require('crypto');

const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'tounikora.myshopify.com';
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_OWNER   = process.env.GITHUB_OWNER;
const GITHUB_REPO    = process.env.GITHUB_REPO;
const GITHUB_BRANCH  = process.env.GITHUB_BRANCH || 'main';

// ── Size normalization ────────────────────────────────────────────────────────
const SIZE_MAP = {
  's':'S','s (168-173 cm)':'S','s (168-173cm)':'S',
  'm':'M','m (173-178 cm)':'M','m (173-178cm)':'M',
  'l':'L','l (178-183 cm)':'L','l (178-183cm)':'L',
  'xl':'XL','xl (183-188 cm)':'XL','xl (183-188cm)':'XL',
  'xxl':'2XL','xxl (188-193 cm)':'2XL','xxl (188-193cm)':'2XL',
  '2xl':'2XL','3xl':'3XL','4xl':'4XL','xs':'XS',
};
const SIZE_COLORS = new Set([
  'black','blanc','rouge','beige','gray','noir','yellow','halo ivory',
  'gris-clair','gris-fonces','with','without','light brown',
  'black/field silver/field silver','thunder blue/safety orange/safety orange',
]);
const SIZE_ORDER = ['XS','S','M','L','XL','2XL','3XL','4XL'];

function normalizeSize(s) {
  if (!s) return null;
  const k = s.trim().toLowerCase();
  if (SIZE_COLORS.has(k)) return null;
  return SIZE_MAP[k] || s.trim();
}
function sortSizes(arr) {
  return arr.slice().sort((a, b) => {
    const ia = SIZE_ORDER.indexOf(a), ib = SIZE_ORDER.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
}

// ── Fetch ALL products via public storefront JSON (no token needed) ──────────
async function fetchAllProducts() {
  const products = [];
  let page = 1;
  while (true) {
    const url = `https://${SHOPIFY_DOMAIN}/products.json?limit=250&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Shopify fetch error: ${res.status}`);
    const data = await res.json();
    if (!data.products || data.products.length === 0) break;
    products.push(...data.products);
    if (data.products.length < 250) break;
    page++;
  }
  return products;
}

function shopifyProductToEntry(p) {
  const rawSizes = p.variants.map(v => v.option1).filter(Boolean);
  const sizes = sortSizes([...new Set(rawSizes.map(normalizeSize).filter(Boolean))]);
  const rawColors = p.variants.flatMap(v => [v.option2, v.option3]).filter(Boolean);
  const colors = [...new Set(rawColors.filter(c => {
    const k = c.trim().toLowerCase();
    return !SIZE_MAP[k] && !SIZE_COLORS.has(k);
  }))];
  const image = p.images && p.images[0] ? p.images[0].src : '';
  return { title: p.title, sizes, colors, image };
}

// ── GitHub: commit products.json ──────────────────────────────────────────────
async function getFileSha() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/products.json?ref=${GITHUB_BRANCH}`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
  );
  if (!res.ok) return null;
  return (await res.json()).sha;
}
async function commitProductsJson(content) {
  const sha = await getFileSha();
  const body = {
    message: '[auto] sync products from Shopify',
    content: Buffer.from(JSON.stringify(content)).toString('base64'),
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/products.json`,
    {
      method: 'PUT',
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`GitHub error: ${res.status} ${await res.text()}`);
}

// ── Webhook HMAC verification ─────────────────────────────────────────────────
function verifySignature(rawBody, signature) {
  if (!SHOPIFY_SECRET) return true;
  const expected = crypto.createHmac('sha256', SHOPIFY_SECRET).update(rawBody).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || '')); }
  catch { return false; }
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString();

  if (!verifySignature(rawBody, req.headers['x-shopify-hmac-sha256'])) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    // Wait 15s for Shopify to index the new/updated product in the public feed
    await new Promise(resolve => setTimeout(resolve, 15000));
    const products = await fetchAllProducts();
    const entries = products.map(shopifyProductToEntry);
    await commitProductsJson(entries);
    console.log(`[shopify-webhook] synced ${entries.length} products`);
    return res.status(200).json({ synced: entries.length });
  } catch (err) {
    console.error('[shopify-webhook]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
