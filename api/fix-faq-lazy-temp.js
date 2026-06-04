// TEMPORARY — Fix FAQ (hardcoded, no blocks dependency) + lazy load v5
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';
const THEME_ID = '160864698587';

// ── New seo-faq.liquid (hardcoded, no blocks) ─────────────────────────────
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

// ── Lazy load v5 script ────────────────────────────────────────────────────
const LAZY_V5 = `<script data-touni-lazy="v5">
(function () {
  function fixLazySizes() {
    var lz = window.lazySizesBe;
    if (!lz) return;
    if (lz.cfg) {
      var m = lz.cfg.loadMode;
      if (m !== 2 && m !== 3) lz.cfg.loadMode = 2;
    }
    try { lz.loader.checkElems(); } catch (e) {}
  }
  function unveilAll(scope) {
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
  // 1. lazysizebee:loaded
  document.addEventListener('lazysizebee:loaded', function () {
    fixLazySizes();
    setTimeout(fixLazySizes, 400);
  });
  // 2. window.load
  window.addEventListener('load', function () {
    fixLazySizes();
    setTimeout(fixLazySizes, 600);
    setTimeout(fixLazySizes, 1500);
  });
  // 3. Global sweep at 3s
  window.addEventListener('load', function () {
    setTimeout(function () { fixLazySizes(); unveilAll(); }, 3000);
  });
  // 4. bfcache
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) { setTimeout(fixLazySizes, 200); setTimeout(unveilAll, 500); }
  });
  // 5. Flickity settle + dragEnd
  document.addEventListener('settle.flickity', function () {
    setTimeout(function () {
      fixLazySizes();
      var active = document.querySelector('.flickity-enabled');
      if (active) unveilAll(active);
    }, 80);
  }, true);
  document.addEventListener('dragEnd.flickity', function () { setTimeout(fixLazySizes, 100); }, true);
  // 6. Interval sweep — every 700ms for first 8s (fixes product thumbnails)
  var _n = 0;
  var _iv = setInterval(function () {
    _n++;
    fixLazySizes();
    if (_n >= 12) { clearInterval(_iv); unveilAll(); }
  }, 700);
  // 7. Recently viewed section
  var rw = document.getElementById('recently_wrap');
  if (rw) {
    new MutationObserver(function (muts, self) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].addedNodes.length > 0 && rw.querySelector('.bee-product')) {
          self.disconnect();
          [700, 1400, 2500].forEach(function (d) {
            setTimeout(function () { fixLazySizes(); unveilAll(rw); }, d);
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

  const results = {};
  try {
    const hdrs = await shopifyAdminHeaders();
    const base = `https://${_SD}/admin/api/${_SV}/themes/${THEME_ID}/assets.json`;

    // ── 1. Read current seo-faq.liquid to confirm state ─────────────────
    const readFaq = await fetch(`${base}?asset[key]=sections/seo-faq.liquid`, { headers: hdrs });
    const faqData = await readFaq.json();
    results.old_faq_snippet = (faqData.asset?.value || '').slice(0, 150);

    // ── 2. Push new hardcoded FAQ ────────────────────────────────────────
    const pushFaq = await fetch(base, {
      method: 'PUT',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset: { key: 'sections/seo-faq.liquid', value: NEW_FAQ } }),
    });
    const faqPut = await pushFaq.json();
    results.faq_updated = pushFaq.ok;
    results.faq_updated_at = faqPut.asset?.updated_at;

    // ── 3. Read theme.liquid ─────────────────────────────────────────────
    const readTheme = await fetch(`${base}?asset[key]=layout/theme.liquid`, { headers: hdrs });
    const themeData = await readTheme.json();
    let themeContent = themeData.asset?.value || '';

    // ── 4. Find & replace old lazy fix script ───────────────────────────
    // Markers: look for data-touni-lazy attribute OR the function name
    const oldV4Start = themeContent.indexOf('<script data-touni-lazy=');
    const oldV4End_tag = '</script>';
    let replaced = false;

    if (oldV4Start !== -1) {
      const oldV4End = themeContent.indexOf(oldV4End_tag, oldV4Start) + oldV4End_tag.length;
      themeContent = themeContent.slice(0, oldV4Start) + LAZY_V5 + themeContent.slice(oldV4End);
      replaced = true;
      results.lazy_replacement = 'found data-touni-lazy attr, replaced';
    } else {
      // Fallback: look for the IIFE with fixLazySizes
      const fnIdx = themeContent.indexOf('function fixLazySizes()');
      if (fnIdx !== -1) {
        // Walk back to find opening <script>
        const scriptOpen = themeContent.lastIndexOf('<script', fnIdx);
        // Walk forward to find closing </script>
        const scriptClose = themeContent.indexOf('</script>', fnIdx) + '</script>'.length;
        if (scriptOpen !== -1 && scriptClose !== -1) {
          themeContent = themeContent.slice(0, scriptOpen) + LAZY_V5 + themeContent.slice(scriptClose);
          replaced = true;
          results.lazy_replacement = 'found via function name, replaced';
        }
      }
    }

    if (!replaced) {
      // Inject before </head> as fallback
      themeContent = themeContent.replace('</head>', LAZY_V5 + '\n</head>');
      results.lazy_replacement = 'injected before </head> (no existing script found)';
    }

    // ── 5. Push updated theme.liquid ────────────────────────────────────
    const pushTheme = await fetch(base, {
      method: 'PUT',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset: { key: 'layout/theme.liquid', value: themeContent } }),
    });
    const themePut = await pushTheme.json();
    results.theme_updated = pushTheme.ok;
    results.theme_updated_at = themePut.asset?.updated_at;

    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message, results });
  }
};
