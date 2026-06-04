// Helpers partagés pour l'intégration Shopify Admin API
// Utilisé par sync-products-admin.js, sync-return-to-shopify.js, shopify-order-webhook.js
// Auth: client_credentials grant (touni-master-api Dev Dashboard app)
// Token auto-renouvelé toutes les 24h — aucune rotation manuelle nécessaire

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'bjuanm-1r.myshopify.com';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const SHOPIFY_LOCATION_ID = process.env.SHOPIFY_LOCATION_ID || '';
const SHOPIFY_API_VERSION = '2024-10';

const SB_URL = process.env.SUPABASE_URL || 'https://dwjjrgjbkftejdcmwpgc.supabase.co';
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR3ampyZ2pia2Z0ZWpkY213cGdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0NzI2MDYsImV4cCI6MjA5MTA0ODYwNn0.6GxM9u1Om7zP-_MEYVhdtHBESyGLDZGFofxSKGwixPo';

// ── Token cache (in-memory, renewed automatically before expiry) ──
let _tokenCache = { token: null, expiresAt: 0 };

async function getAdminToken() {
  const MARGIN_MS = 5 * 60 * 1000; // refresh 5min before expiry
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - MARGIN_MS) {
    return _tokenCache.token;
  }
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error('SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET not configured in Vercel env vars');
  }
  const res = await fetch(`https://${SHOPIFY_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${SHOPIFY_CLIENT_ID}&client_secret=${SHOPIFY_CLIENT_SECRET}`,
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh returned no access_token');
  _tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 86400) * 1000,
  };
  return _tokenCache.token;
}

async function shopifyAdminHeaders() {
  const token = await getAdminToken();
  return {
    'X-Shopify-Access-Token': token,
    'Content-Type': 'application/json',
  };
}

function supabaseHeaders(useService = false) {
  const key = useService && SB_SERVICE_KEY ? SB_SERVICE_KEY : SB_ANON_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

// Normalize size for matching (S/M/L/XL/2XL)
const SIZE_MAP = {
  's':'S', 's (168-173 cm)':'S', 's (168-173cm)':'S',
  'm':'M', 'm (173-178 cm)':'M', 'm (173-178cm)':'M',
  'l':'L', 'l (178-183 cm)':'L', 'l (178-183cm)':'L',
  'xl':'XL', 'xl (183-188 cm)':'XL', 'xl (183-188cm)':'XL',
  'xxl':'2XL', 'xxl (188-193 cm)':'2XL', 'xxl (188-193cm)':'2XL',
  '2xl':'2XL', '3xl':'3XL', '4xl':'4XL', 'xs':'XS',
};

const SIZE_OPTION_NAMES = new Set(['taille','size','pointure','pointures','sizes','tailles']);
const COLOR_OPTION_NAMES = new Set(['couleur','color','coloris','couleurs','colors']);

function normalizeSize(s) {
  if (!s) return null;
  const k = String(s).trim().toLowerCase();
  if (k === 'default title' || k === 'default') return null;
  // Taille unique variants — treat as "no size" so they match null-size stock items
  if (k === 'standard' || k === 'taille unique' || k === 'unique') return null;
  return SIZE_MAP[k] || String(s).trim();
}

// English → French color translations (for stock items where color was entered in English)
const COLOR_EN_FR = {
  'black': 'Noir', 'white': 'Blanc', 'red': 'Rouge', 'blue': 'Bleu',
  'green': 'Vert', 'yellow': 'Jaune', 'orange': 'Orange', 'pink': 'Rose',
  'purple': 'Violet', 'grey': 'Gris', 'gray': 'Gris', 'brown': 'Marron',
  'gold': 'Or', 'silver': 'Argent', 'navy': 'Marine', 'beige': 'Beige',
  'light brown': 'Light Brown',
};

function normalizeColor(c) {
  if (!c) return null;
  const k = String(c).trim().toLowerCase();
  if (k === 'default title' || k === 'default') return null;
  // Translate English color names to French (Shopify uses French on this store)
  if (COLOR_EN_FR[k]) return COLOR_EN_FR[k];
  return String(c).trim();
}

// ── Shopify Admin API : fetch all products with variants + inventory_item_id ──
async function fetchShopifyProductsAdmin() {
  const headers = await shopifyAdminHeaders();
  const products = [];
  let url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250&fields=id,title,options,variants,images`;
  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Shopify Admin error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    products.push(...(data.products || []));
    const link = res.headers.get('link') || '';
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }
  return products;
}

// ── Get current inventory level for a specific inventory_item_id at our location ──
async function getInventoryLevel(inventoryItemId) {
  if (!SHOPIFY_LOCATION_ID) throw new Error('SHOPIFY_LOCATION_ID not configured');
  const headers = await shopifyAdminHeaders();
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${SHOPIFY_LOCATION_ID}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`getInventoryLevel ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const level = (data.inventory_levels || [])[0];
  return level ? (level.available || 0) : null;
}

// ── Adjust inventory by delta (+N or -N) ──
async function adjustInventory(inventoryItemId, delta) {
  if (!SHOPIFY_LOCATION_ID) throw new Error('SHOPIFY_LOCATION_ID not configured');
  const headers = await shopifyAdminHeaders();
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels/adjust.json`;
  const body = {
    location_id: parseInt(SHOPIFY_LOCATION_ID),
    inventory_item_id: parseInt(inventoryItemId),
    available_adjustment: parseInt(delta),
  };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`adjustInventory ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── List Shopify locations (to find SHOPIFY_LOCATION_ID at setup) ──
async function listLocations() {
  const headers = await shopifyAdminHeaders();
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/locations.json`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`listLocations ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.locations || [];
}

// ── Match a stock_retours item to a Shopify variant via the cache ──
async function matchVariantInCache(productTitle, size, color) {
  const normSize = normalizeSize(size);
  const normColor = normalizeColor(color);
  const params = new URLSearchParams();
  params.set('select', 'variant_id,inventory_item_id,inventory_quantity,size,color');
  params.set('product_title', `eq.${productTitle}`);
  const url = `${SB_URL}/rest/v1/shopify_variants_cache?${params.toString()}`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) return null;
  const candidates = await res.json();
  if (!candidates.length) return null;
  let match = candidates.find(c => normalizeSize(c.size) === normSize && normalizeColor(c.color) === normColor);
  if (match) return match;
  match = candidates.find(c => normalizeSize(c.size) === normSize);
  return match || null;
}

module.exports = {
  SHOPIFY_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_LOCATION_ID,
  SHOPIFY_API_VERSION,
  SB_URL,
  SB_SERVICE_KEY,
  SB_ANON_KEY,
  getAdminToken,
  shopifyAdminHeaders,
  supabaseHeaders,
  normalizeSize,
  normalizeColor,
  fetchShopifyProductsAdmin,
  getInventoryLevel,
  adjustInventory,
  listLocations,
  matchVariantInCache,
  SIZE_OPTION_NAMES,
  COLOR_OPTION_NAMES,
};
