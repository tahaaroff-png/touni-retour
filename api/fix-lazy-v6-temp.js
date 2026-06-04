// TEMPORARY — Replace lazy load fix with v6 (manual data-src fallback)
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';
const THEME_ID = '160864698587';

// v6: unveils every stuck image on every interval tick
// Key fix: data-src → src manual copy as fallback when lazySizesBe misses images
const LAZY_V6 = `<script data-touni-lazy="v6">
(function () {
  // Try lazySizesBe.loader.unveil(), fallback to manual data-src copy
  function tryUnveil(img) {
    var lz = window.lazySizesBe;
    if (lz) { try { lz.loader.unveil(img); return; } catch (e) {} }
    var ds = img.getAttribute('data-src');
    var dss = img.getAttribute('data-srcset');
    if (ds)  { img.src = ds;    img.removeAttribute('data-src'); }
    if (dss) { img.srcset = dss; img.removeAttribute('data-srcset'); }
    img.classList.remove('lazyloadbee', 'lazybeefore');
  }

  // checkElems + sweep all stuck images in scope
  function fixAll(scope) {
    var lz = window.lazySizesBe;
    if (lz) {
      if (lz.cfg && lz.cfg.loadMode !== 2 && lz.cfg.loadMode !== 3) lz.cfg.loadMode = 2;
      try { lz.loader.checkElems(); } catch (e) {}
    }
    var root = scope || document;
    var imgs = root.querySelectorAll('img.lazyloadbee, img[data-src], img[data-srcset]');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var src = img.getAttribute('src') || '';
      // stuck = no real src yet AND has a data-src to pull from
      var hasData = img.getAttribute('data-src') || img.getAttribute('data-srcset');
      var stuck   = hasData && (src === '' || src.indexOf('data:') !== -1 || img.naturalWidth === 0);
      if (stuck) tryUnveil(img);
    }
  }

  // 1. lazysizebee:loaded
  document.addEventListener('lazysizebee:loaded', function () { fixAll(); setTimeout(fixAll, 400); });

  // 2. window.load — multiple passes
  window.addEventListener('load', function () {
    fixAll();
    [600, 1500, 3000, 5000].forEach(function (d) { setTimeout(fixAll, d); });
  });

  // 3. bfcache
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) { setTimeout(fixAll, 200); setTimeout(fixAll, 600); }
  });

  // 4. Flickity settle + dragEnd
  document.addEventListener('settle.flickity', function () {
    setTimeout(function () {
      fixAll();
      var fc = document.querySelector('.flickity-enabled');
      if (fc) fixAll(fc);
    }, 80);
  }, true);
  document.addEventListener('dragEnd.flickity', function () { setTimeout(fixAll, 100); }, true);

  // 5. Interval sweep every 700ms for 8s — runs fixAll (not just checkElems) each tick
  var _n = 0;
  var _iv = setInterval(function () {
    _n++;
    fixAll();
    if (_n >= 12) clearInterval(_iv);
  }, 700);

  // 6. Recently viewed section
  var rw = document.getElementById('recently_wrap');
  if (rw) {
    new MutationObserver(function (muts, self) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].addedNodes.length > 0 && rw.querySelector('.bee-product')) {
          self.disconnect();
          [700, 1400, 2500].forEach(function (d) {
            setTimeout(function () { fixAll(rw); }, d);
          });
          break;
        }
      }
    }).observe(rw, { childList: true, subtree: true });
  }
})();
</script>`;

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  try {
    const hdrs = await shopifyAdminHeaders();
    const base = `https://${_SD}/admin/api/${_SV}/themes/${THEME_ID}/assets.json`;

    // Read theme.liquid
    const readR = await fetch(`${base}?asset[key]=layout/theme.liquid`, { headers: hdrs });
    const readData = await readR.json();
    let theme = readData.asset?.value || '';
    if (!theme) return res.status(500).json({ error: 'Could not read theme.liquid' });

    // Find existing lazy fix script (v4, v5 or earlier)
    let replaced = false;

    // Try by data-touni-lazy attribute
    const byAttr = theme.indexOf('<script data-touni-lazy=');
    if (byAttr !== -1) {
      const endTag = theme.indexOf('</script>', byAttr) + '</script>'.length;
      theme = theme.slice(0, byAttr) + LAZY_V6 + theme.slice(endTag);
      replaced = true;
    }

    // Fallback: find by function name
    if (!replaced) {
      const fnIdx = theme.indexOf('function fixLazySizes()');
      if (fnIdx !== -1) {
        const scriptOpen = theme.lastIndexOf('<script', fnIdx);
        const scriptClose = theme.indexOf('</script>', fnIdx) + '</script>'.length;
        if (scriptOpen !== -1 && scriptClose > scriptOpen) {
          theme = theme.slice(0, scriptOpen) + LAZY_V6 + theme.slice(scriptClose);
          replaced = true;
        }
      }
    }

    // Last resort: before </head>
    if (!replaced) {
      theme = theme.replace('</head>', LAZY_V6 + '\n</head>');
      replaced = true;
    }

    // Push updated theme.liquid
    const pushR = await fetch(base, {
      method: 'PUT',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset: { key: 'layout/theme.liquid', value: theme } }),
    });
    const pushData = await pushR.json();

    res.json({
      ok: pushR.ok,
      replaced,
      updated_at: pushData.asset?.updated_at,
      theme_id: THEME_ID,
      // confirm v6 is now in theme
      snippet: theme.slice(theme.indexOf('data-touni-lazy'), theme.indexOf('data-touni-lazy') + 40),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
