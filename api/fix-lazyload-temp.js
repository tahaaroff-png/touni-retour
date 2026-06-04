// TEMPORARY — Fix lazy loading bugs in theme.liquid
// Replaces the inline fix script at the bottom of </body>
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');
const SYNC_SECRET = process.env.SYNC_SECRET || '';

// The improved fix script to inject at bottom of </body>
const NEW_SCRIPT = `<script>
/* ── Fix lazy loading — v4 ─────────────────────────────────────────────────────
   Problèmes résolus :
   1. Déclenchement sur lazysizebee:loaded (plus tôt que window.load)
   2. Safety net global : force-unveil toute image encore en placeholder après 3s
   3. Flickity carousel : force checkElems() sur chaque slide settle
   4. Récemment vus : 3 passes (700ms / 1 400ms / 2 500ms) au lieu d'une seule
   ─────────────────────────────────────────────────────────────────────────────── */
(function () {

  /* ── Utilitaire central ── */
  function fixLazySizes() {
    var lz = window.lazySizesBe;
    if (!lz) return;
    if (lz.cfg) {
      var m = lz.cfg.loadMode;
      if (m !== 2 && m !== 3) lz.cfg.loadMode = 2;
    }
    try { lz.loader.checkElems(); } catch (e) {}
  }

  function unveilStuckImages(scope) {
    var lz = window.lazySizesBe;
    if (!lz) return;
    var root = scope || document;
    var imgs = root.querySelectorAll('img.lazyloadbee');
    for (var i = 0; i < imgs.length; i++) {
      var src = imgs[i].getAttribute('src') || '';
      if (src === '' || src.indexOf('data:image') !== -1) {
        try { lz.loader.unveil(imgs[i]); } catch (e) {}
      }
    }
  }

  /* ── 1. Déclenchement immédiat dès que lazySizesBe est prêt ── */
  document.addEventListener('lazysizebee:loaded', function () {
    fixLazySizes();
    setTimeout(fixLazySizes, 400);
  });

  /* ── 2. Fallback window.load (double passe) ── */
  window.addEventListener('load', function () {
    fixLazySizes();
    setTimeout(fixLazySizes, 600);
    setTimeout(fixLazySizes, 1500);
  });

  /* ── 3. Safety net global : toute image encore grise après 3s est forcée ── */
  window.addEventListener('load', function () {
    setTimeout(function () {
      fixLazySizes();
      unveilStuckImages(document);
    }, 3000);
  });

  /* ── 4. bfcache (retour arrière navigateur) ── */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) {
      setTimeout(fixLazySizes, 200);
      setTimeout(function () { unveilStuckImages(document); }, 500);
    }
  });

  /* ── 5. Flickity carousel : force checkElems sur chaque slide settle ──
     Quand le carousel se stabilise, de nouvelles images entrent dans le viewport
     mais ne déclenchent pas l'IntersectionObserver (CSS transform). ── */
  document.addEventListener('settle.flickity', function () {
    setTimeout(function () {
      fixLazySizes();
      /* Unveil les images du carousel actif */
      var active = document.querySelector('.flickity-enabled');
      if (active) unveilStuckImages(active);
    }, 80);
  }, true);

  /* Aussi sur DragEnd pour mobile swipe */
  document.addEventListener('dragEnd.flickity', function () {
    setTimeout(fixLazySizes, 100);
  }, true);

  /* ── 6. Fix spécifique récemment vus — 3 passes ── */
  var recentWrap = document.getElementById('recently_wrap');
  if (recentWrap) {
    new MutationObserver(function (mutations, self) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0 && recentWrap.querySelector('.bee-product')) {
          self.disconnect();
          /* 3 passes pour couvrir Flickity init lente + connexions lentes */
          [700, 1400, 2500].forEach(function (delay) {
            setTimeout(function () {
              fixLazySizes();
              unveilStuckImages(recentWrap);
            }, delay);
          });
          break;
        }
      }
    }).observe(recentWrap, { childList: true, subtree: true });
  }

})();
</script>`;

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const hdrs = await shopifyAdminHeaders();

  try {
    // Get active theme
    const themeR = await fetch(`https://${_SD}/admin/api/${_SV}/themes.json`, { headers: hdrs });
    const themes = await themeR.json();
    const activeTheme = (themes.themes || []).find(t => t.role === 'main');
    if (!activeTheme) return res.status(404).json({ error: 'No active theme' });

    // Read theme.liquid
    const assetR = await fetch(
      `https://${_SD}/admin/api/${_SV}/themes/${activeTheme.id}/assets.json?asset[key]=layout/theme.liquid`,
      { headers: hdrs }
    );
    const assetData = await assetR.json();
    let themeContent = assetData.asset?.value;
    if (!themeContent) return res.status(404).json({ error: 'theme.liquid not found' });

    // Replace the old fix script block
    // Identify block: from <script> containing "Fix lazySizesBe" to the matching </script>
    const oldBlockStart = '<script>\n/* ── Fix lazySizesBe loadMode';
    const oldBlockEnd = '</script>\n</body>';
    const newBlockEnd = '\n</body>';

    if (!themeContent.includes(oldBlockStart)) {
      return res.status(400).json({
        error: 'Could not find old fix block — manual check needed',
        preview: themeContent.substring(themeContent.indexOf('Fix laz'), themeContent.indexOf('Fix laz') + 200),
      });
    }

    const startIdx = themeContent.indexOf(oldBlockStart);
    const endIdx = themeContent.indexOf(oldBlockEnd, startIdx);
    if (endIdx === -1) return res.status(400).json({ error: 'Could not find end of fix block' });

    const before = themeContent.substring(0, startIdx);
    const after = oldBlockEnd + themeContent.substring(endIdx + oldBlockEnd.length);
    // Reconstruct: before + NEW_SCRIPT + </body>\n</html>
    // The 'after' starts with </body> so we need to strip </body> from after and let NEW_SCRIPT precede it
    const newContent = before + NEW_SCRIPT + newBlockEnd + themeContent.substring(endIdx + oldBlockEnd.length);

    // Also update the version comment
    const updatedContent = newContent.replace('{%- comment -%}v3{%- endcomment -%}', '{%- comment -%}v4{%- endcomment -%}');

    // Write back
    const putR = await fetch(`https://${_SD}/admin/api/${_SV}/themes/${activeTheme.id}/assets.json`, {
      method: 'PUT',
      headers: hdrs,
      body: JSON.stringify({ asset: { key: 'layout/theme.liquid', value: updatedContent } }),
    });
    const putData = await putR.json();

    if (!putR.ok) return res.status(putR.status).json({ error: 'Theme write failed', details: putData });

    return res.json({
      success: true,
      theme: activeTheme.name,
      key: putData.asset?.key,
      version: 'v4',
      changes: [
        'lazysizebee:loaded event → trigger immédiat',
        'Safety net global à 3s → force-unveil toute image bloquée',
        'settle.flickity + dragEnd.flickity → fix carousels',
        'Récemment vus : 3 passes (700ms / 1400ms / 2500ms)',
        'unveilStuckImages() centralisé — appliqué partout',
      ],
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
