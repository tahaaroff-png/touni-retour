// TEMP - regenerate products.json from Shopify Admin API
// GET /api/gen-products-json-temp?secret=touni-sync-2026
// DELETE AFTER USE
const {
  shopifyAdminHeaders, fetchShopifyProductsAdmin,
} = require('./_shopify-helpers.js');

const SIZE_MAP = {
  's':'S','s (168-173 cm)':'S','s (168-173cm)':'S',
  'm':'M','m (173-178 cm)':'M','m (173-178cm)':'M',
  'l':'L','l (178-183 cm)':'L','l (178-183cm)':'L',
  'xl':'XL','xl (183-188 cm)':'XL','xl (183-188cm)':'XL',
  'xxl':'2XL','xxl (188-193 cm)':'2XL','xxl (188-193cm)':'2XL',
  '2xl':'2XL','3xl':'3XL','4xl':'4XL','xs':'XS',
};
const SIZE_ORDER = ['XS','S','M','L','XL','2XL','3XL','4XL'];
const SIZE_OPTION_NAMES = new Set(['taille','size','pointure','pointures','sizes','tailles']);
const COLOR_OPTION_NAMES = new Set(['couleur','color','coloris','couleurs','colors']);
const KNOWN_COLORS = new Set([
  'black','blanc','rouge','beige','gray','noir','yellow','orange','rose','marron',
  'bleu','bleu marine','vert','violet','bleu ciel','gris','gris clair','gris foncé',
  'bordeaux','corail','kaki','olive','navy','white','red','blue','green','purple','pink',
  'brown','grey','gold','silver','multicolor','multicolore','cream','ivory','turquoise',
]);

function sortSizes(arr) {
  return arr.slice().sort((a,b) => {
    const ia=SIZE_ORDER.indexOf(a), ib=SIZE_ORDER.indexOf(b);
    if(ia>=0&&ib>=0) return ia-ib;
    if(ia>=0) return -1;
    if(ib>=0) return 1;
    return a.localeCompare(b);
  });
}

function normalizeSize(s) {
  if(!s) return null;
  const k = s.trim().toLowerCase();
  if(k==='default title'||k==='default'||k==='standard'||k==='taille unique'||k==='unique') return null;
  if(KNOWN_COLORS.has(k)) return null;
  return SIZE_MAP[k] || s.trim();
}

function extractSizesColors(product) {
  const opts = (product.options||[]).map(o=>({
    name:(o.name||'').trim().toLowerCase(), pos:o.position-1
  }));
  const sizeOpt = opts.find(o=>SIZE_OPTION_NAMES.has(o.name));
  const colorOpt = opts.find(o=>COLOR_OPTION_NAMES.has(o.name));

  const getVal = (v, pos) => pos===0?v.option1:pos===1?v.option2:v.option3;

  const rawSizes = new Set();
  const rawColors = new Set();

  for(const v of (product.variants||[])) {
    if(sizeOpt!==undefined) {
      const s = getVal(v, sizeOpt.pos);
      if(s) rawSizes.add(s);
    } else {
      // No explicit size option — try option1
      const s = v.option1;
      if(s && normalizeSize(s)) rawSizes.add(s);
    }
    if(colorOpt!==undefined) {
      const c = getVal(v, colorOpt.pos);
      if(c && c!=='Default Title') rawColors.add(c);
    }
  }

  const sizes = sortSizes([...rawSizes].map(normalizeSize).filter(Boolean));
  const colors = [...rawColors].filter(c=>c&&c!=='Default Title');
  return { sizes: [...new Set(sizes)], colors: [...new Set(colors)] };
}

module.exports = async function handler(req, res) {
  if ((req.query?.secret||req.headers['x-sync-secret']) !== (process.env.SYNC_SECRET||'touni-sync-2026'))
    return res.status(401).json({ error: 'Unauthorized' });

  const products = await fetchShopifyProductsAdmin();

  const entries = products.map(p => {
    const { sizes, colors } = extractSizesColors(p);
    const image = p.images&&p.images[0] ? p.images[0].src : '';
    return { title: p.title, sizes, colors, image };
  });

  // Sort alphabetically
  entries.sort((a,b) => a.title.localeCompare(b.title, 'fr'));

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json(entries);
};
