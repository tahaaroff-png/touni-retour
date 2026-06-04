// TEMPORARY — Push FAQ hardcoded + lazy v6 to the CORRECT live theme (160850116827)
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';
const THEME_ID = '160850116827'; // "claude working ..." — role: main (LIVE)

const NEW_FAQ = `<section class="touni-faq">

  <div class="touni-faq__header">
    <div class="touni-faq__line"></div>
    <h2 class="touni-faq__title">Questions fréquentes</h2>
  </div>

  <div class="touni-faq__list">

    <details class="touni-faq__item">
      <summary class="touni-faq__question">
        <span>Quelle est la qualité de vos produits ?</span>
        <svg class="touni-faq__icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="touni-faq__body">
        <p class="touni-faq__answer">Nos articles sont sélectionnés pour leur qualité de finition et leur rendu visuel soigné — tissus respirants, broderies solides et matières durables. Chaque produit est contrôlé avant expédition pour vous garantir une satisfaction à la réception.</p>
      </div>
    </details>

    <details class="touni-faq__item">
      <summary class="touni-faq__question">
        <span>Comment fonctionne la livraison au Maroc ?</span>
        <svg class="touni-faq__icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="touni-faq__body">
        <p class="touni-faq__answer">Touni.ma livre partout au Maroc en 24 à 48 heures ouvrables. La livraison est gratuite sur toutes vos commandes, quelle que soit la destination — du Nord au Sud, de l'Est à l'Ouest.</p>
      </div>
    </details>

    <details class="touni-faq__item">
      <summary class="touni-faq__question">
        <span>Le paiement à la livraison est-il disponible ?</span>
        <svg class="touni-faq__icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="touni-faq__body">
        <p class="touni-faq__answer">Oui. Vous ne payez qu'à la réception de votre colis, en espèces, directement au livreur. Aucune avance n'est requise.</p>
      </div>
    </details>

    <details class="touni-faq__item">
      <summary class="touni-faq__question">
        <span>Puis-je vérifier le colis avant de payer ?</span>
        <svg class="touni-faq__icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="touni-faq__body">
        <p class="touni-faq__answer">Absolument. Vous êtes libre de contrôler votre article en présence du livreur avant tout paiement. Si le produit ne correspond pas à votre commande, vous pouvez le refuser sur place.</p>
      </div>
    </details>

    <details class="touni-faq__item">
      <summary class="touni-faq__question">
        <span>Comment effectuer un échange ?</span>
        <svg class="touni-faq__icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="touni-faq__body">
        <p class="touni-faq__answer">Tout échange doit être signalé dans les 48 heures suivant la réception. Contactez-nous via WhatsApp ou par e-mail avec votre numéro de commande — notre équipe vous accompagne jusqu'à la résolution.</p>
      </div>
    </details>

    <details class="touni-faq__item">
      <summary class="touni-faq__question">
        <span>Comment choisir la bonne taille ?</span>
        <svg class="touni-faq__icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="touni-faq__body">
        <p class="touni-faq__answer">Un guide des tailles est disponible sur chaque fiche produit. En cas de doute entre deux tailles, nous conseillons de prendre la taille supérieure pour plus de confort. Pour une demande spécifique, contactez-nous sur WhatsApp.</p>
      </div>
    </details>

    <details class="touni-faq__item">
      <summary class="touni-faq__question">
        <span>Proposez-vous le flocage (nom + numéro) ?</span>
        <svg class="touni-faq__icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="touni-faq__body">
        <p class="touni-faq__answer">Oui, le flocage est disponible sur une sélection de maillots pour +99 DH. Choisissez l'option sur la fiche produit et indiquez votre nom et numéro — réalisé à la commande.</p>
      </div>
    </details>

    <details class="touni-faq__item">
      <summary class="touni-faq__question">
        <span>Livrez-vous en grandes tailles (3XL, 4XL) ?</span>
        <svg class="touni-faq__icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="touni-faq__body">
        <p class="touni-faq__answer">Pour les tailles au-delà du 2XL, contactez-nous directement sur WhatsApp pour vérifier la disponibilité sur le produit souhaité. Nous faisons notre possible pour satisfaire chaque demande.</p>
      </div>
    </details>

  </div>
</section>

{% stylesheet %}
  .touni-faq {
    padding: 48px 20px 52px;
    max-width: 780px;
    margin: 0 auto;
  }
  .touni-faq__header {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    margin-bottom: 32px;
  }
  .touni-faq__line {
    width: 2px;
    height: 22px;
    background: #e60012;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .touni-faq__title {
    font-size: 11.5px;
    font-weight: 800;
    color: #111;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    margin: 0;
  }
  .touni-faq__list {
    display: flex;
    flex-direction: column;
  }
  .touni-faq__item {
    border-top: 1px solid #f0f0f0;
  }
  .touni-faq__item:last-child {
    border-bottom: 1px solid #f0f0f0;
  }
  .touni-faq__question {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 0;
    cursor: pointer;
    font-weight: 700;
    font-size: 13px;
    color: #111;
    gap: 16px;
    list-style: none;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    background: none;
    border: none;
    width: 100%;
    text-align: left;
    line-height: 1.4;
  }
  .touni-faq__question::-webkit-details-marker { display: none; }
  .touni-faq__question span { flex: 1; }
  .touni-faq__icon {
    flex-shrink: 0;
    width: 15px;
    height: 15px;
    stroke: #ccc;
    fill: none;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 0.25s ease, stroke 0.2s;
  }
  details[open] > summary .touni-faq__icon {
    transform: rotate(180deg);
    stroke: #e60012;
  }
  .touni-faq__body {
    overflow: hidden;
    max-height: 0;
    transition: max-height 0.32s ease, opacity 0.28s ease;
    opacity: 0;
  }
  details[open] .touni-faq__body {
    max-height: 400px;
    opacity: 1;
  }
  .touni-faq__answer {
    padding: 2px 0 16px;
    font-size: 12.5px;
    line-height: 1.68;
    color: #555;
    margin: 0;
  }
  @media (max-width: 640px) {
    .touni-faq { padding: 32px 16px 36px; }
    .touni-faq__header { margin-bottom: 24px; }
    .touni-faq__question { font-size: 13px; padding: 13px 0; }
  }
{% endstylesheet %}

{% schema %}
{
  "name": "FAQ",
  "tag": "div",
  "class": "section-faq",
  "settings": [],
  "presets": [{"name": "FAQ"}]
}
{% endschema %}`;

const LAZY_V6 = `<script data-touni-lazy="v6">
(function () {
  function tryUnveil(img) {
    var lz = window.lazySizesBe;
    if (lz) { try { lz.loader.unveil(img); return; } catch (e) {} }
    var ds = img.getAttribute('data-src');
    var dss = img.getAttribute('data-srcset');
    if (ds)  { img.src = ds;    img.removeAttribute('data-src'); }
    if (dss) { img.srcset = dss; img.removeAttribute('data-srcset'); }
    img.classList.remove('lazyloadbee', 'lazybeefore');
  }
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
      var hasData = img.getAttribute('data-src') || img.getAttribute('data-srcset');
      var stuck = hasData && (src === '' || src.indexOf('data:') !== -1 || img.naturalWidth === 0);
      if (stuck) tryUnveil(img);
    }
  }
  document.addEventListener('lazysizebee:loaded', function () { fixAll(); setTimeout(fixAll, 400); });
  window.addEventListener('load', function () {
    fixAll();
    [600, 1500, 3000, 5000].forEach(function (d) { setTimeout(fixAll, d); });
  });
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) { setTimeout(fixAll, 200); setTimeout(fixAll, 600); }
  });
  document.addEventListener('settle.flickity', function () {
    setTimeout(function () {
      fixAll();
      var fc = document.querySelector('.flickity-enabled');
      if (fc) fixAll(fc);
    }, 80);
  }, true);
  document.addEventListener('dragEnd.flickity', function () { setTimeout(fixAll, 100); }, true);
  var _n = 0;
  var _iv = setInterval(function () { _n++; fixAll(); if (_n >= 12) clearInterval(_iv); }, 700);
  var rw = document.getElementById('recently_wrap');
  if (rw) {
    new MutationObserver(function (muts, self) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].addedNodes.length > 0 && rw.querySelector('.bee-product')) {
          self.disconnect();
          [700, 1400, 2500].forEach(function (d) { setTimeout(function () { fixAll(rw); }, d); });
          break;
        }
      }
    }).observe(rw, { childList: true, subtree: true });
  }
})();
</script>`;

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const results = {};
  try {
    const hdrs = await shopifyAdminHeaders();
    const base = `https://${_SD}/admin/api/${_SV}/themes/${THEME_ID}/assets.json`;

    // ── 1. Push FAQ ──────────────────────────────────────────────────────
    const faqR = await fetch(base, {
      method: 'PUT',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset: { key: 'sections/seo-faq.liquid', value: NEW_FAQ } }),
    });
    const faqD = await faqR.json();
    results.faq = { ok: faqR.ok, updated_at: faqD.asset?.updated_at };

    // ── 2. Read + update theme.liquid ────────────────────────────────────
    const themeR = await fetch(`${base}?asset[key]=layout/theme.liquid`, { headers: hdrs });
    const themeD = await themeR.json();
    let theme = themeD.asset?.value || '';
    if (!theme) {
      results.lazy = { ok: false, error: 'Could not read theme.liquid' };
    } else {
      let replaced = false;

      const byAttr = theme.indexOf('<script data-touni-lazy=');
      if (byAttr !== -1) {
        const end = theme.indexOf('</script>', byAttr) + '</script>'.length;
        theme = theme.slice(0, byAttr) + LAZY_V6 + theme.slice(end);
        replaced = true;
        results.lazy_method = 'replaced by data-touni-lazy attr';
      }

      if (!replaced) {
        const fnIdx = theme.indexOf('function fixLazySizes()');
        if (fnIdx === -1) {
          // No existing lazy fix — check for tryUnveil (v6 already there?)
          const v6Idx = theme.indexOf('function tryUnveil');
          if (v6Idx !== -1) {
            const so = theme.lastIndexOf('<script', v6Idx);
            const sc = theme.indexOf('</script>', v6Idx) + '</script>'.length;
            theme = theme.slice(0, so) + LAZY_V6 + theme.slice(sc);
            replaced = true;
            results.lazy_method = 'replaced existing tryUnveil block';
          }
        } else {
          const so = theme.lastIndexOf('<script', fnIdx);
          const sc = theme.indexOf('</script>', fnIdx) + '</script>'.length;
          theme = theme.slice(0, so) + LAZY_V6 + theme.slice(sc);
          replaced = true;
          results.lazy_method = 'replaced by fixLazySizes function name';
        }
      }

      if (!replaced) {
        theme = theme.replace('</head>', LAZY_V6 + '\n</head>');
        results.lazy_method = 'injected before </head>';
      }

      const pushR = await fetch(base, {
        method: 'PUT',
        headers: { ...hdrs, 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset: { key: 'layout/theme.liquid', value: theme } }),
      });
      const pushD = await pushR.json();
      results.lazy = { ok: pushR.ok, updated_at: pushD.asset?.updated_at };

      // Confirm v6 tag present
      const tag = theme.match(/data-touni-lazy="([^"]+)"/);
      results.lazy_version = tag ? tag[1] : 'unknown';
    }

    res.json({ ok: true, theme_id: THEME_ID, theme_name: 'claude working ... (LIVE)', results });
  } catch (e) {
    res.status(500).json({ error: e.message, results });
  }
};
