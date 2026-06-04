// TEMPORARY — Update product descriptions (no emojis, clean SEO) + theme infos/conditions for balls
// DELETE AFTER USE
// ?action=descriptions  → update body_html + metafields for 6 products
// ?action=theme         → update product.json template to add ball-specific Infos & Conditions
// ?action=all           → both

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');
const SYNC_SECRET = process.env.SYNC_SECRET || '';

// ─────────────────────────────────────────────────────────────
// PRODUCT DESCRIPTIONS (clean, no emojis, no delivery info)
// ─────────────────────────────────────────────────────────────
const PRODUCTS = [
  {
    id: 9365962916059,
    body_html: `<p><strong>Colombie — Maillot Adidas Originals Rétro</strong></p>
<p>Un design qui rend hommage aux grandes heures de la Selección Colombia. Ce maillot rétro bleu électrique, rehaussé de détails jaunes, arbore le logo Trefoil Adidas et l'écusson brodé de la fédération colombienne — une pièce pour les passionnés du football sud-américain.</p>
<ul>
<li>Design rétro inspiré des années 90</li>
<li>Écusson Selección Colombia brodé</li>
<li>Logo Adidas Trefoil</li>
<li>Tissu technique respirant, coupe moderne</li>
<li>Coloris bleu électrique et jaune</li>
</ul>`,
    title_tag: "Colombie Maillot Adidas Originals Rétro — Selección Colombia | Touni.ma",
    description_tag: "Maillot rétro de la Selección Colombia, coloris bleu électrique et jaune, logo Trefoil Adidas, écusson brodé. Livraison rapide partout au Maroc, paiement à la livraison.",
  },
  {
    id: 9365962948827,
    body_html: `<p><strong>Allemagne — Maillot Adidas Originals 4 Étoiles</strong></p>
<p>La Mannschaft en version collector. Ce maillot bleu nuit aux touches émeraude reprend les codes graphiques Adidas avec l'écusson DFB et les 4 étoiles de la nation la plus titrée d'Europe — une pièce rare pour les amateurs du football allemand.</p>
<ul>
<li>Écusson DFB brodé — 4 étoiles</li>
<li>Coloris bleu nuit et émeraude</li>
<li>Logo Adidas Trefoil</li>
<li>Tissu technique respirant, coupe moderne</li>
</ul>`,
    title_tag: "Allemagne Maillot Adidas Originals 4 Étoiles DFB | Touni.ma",
    description_tag: "Maillot Adidas Originals de l'équipe d'Allemagne — écusson DFB brodé, 4 étoiles, coloris bleu nuit et émeraude. Livraison rapide partout au Maroc, paiement à la livraison.",
  },
  {
    id: 9365959835867,
    body_html: `<p><strong>Adidas Trionda Pro — Ballon FIFA Coupe du Monde 2026</strong></p>
<p>Le ballon de match de la Coupe du Monde FIFA 2026, organisée au Canada, aux États-Unis et au Mexique. Conçu par Adidas et labellisé FIFA Quality Pro, il allie précision de vol, excellente touche de balle et durabilité éprouvée. Disponible en trois coloris : Orange, Blanc Multicolore et Jaune Fluo.</p>
<ul>
<li>Labellisé FIFA Quality Pro</li>
<li>Technologie de vol stabilisé — trajectoire précise</li>
<li>Taille 5 — convient à la compétition et à l'entraînement</li>
<li>Revêtement texturé haute performance</li>
<li>3 coloris : Orange — Blanc Multicolore — Jaune Fluo</li>
</ul>`,
    title_tag: "Adidas Trionda Pro Ballon FIFA Coupe du Monde 2026 | Touni.ma",
    description_tag: "Ballon Adidas Trionda Pro — Coupe du Monde FIFA 2026. Labellisé FIFA Quality Pro, taille 5, 3 coloris. Livraison rapide au Maroc, paiement à la livraison.",
  },
  {
    id: 9365962981595,
    body_html: `<p><strong>Adidas Trionda Pro — Ballon FIFA Coupe du Monde 2026 — Orange</strong></p>
<p>Le ballon de match de la Coupe du Monde FIFA 2026, organisée au Canada, aux États-Unis et au Mexique. Conçu par Adidas et labellisé FIFA Quality Pro, il allie précision de vol, excellente touche de balle et durabilité éprouvée. Coloris Orange.</p>
<ul>
<li>Labellisé FIFA Quality Pro</li>
<li>Technologie de vol stabilisé — trajectoire précise</li>
<li>Taille 5 — convient à la compétition et à l'entraînement</li>
<li>Revêtement texturé haute performance</li>
<li>Coloris Orange</li>
</ul>`,
    title_tag: "Adidas Trionda Pro Ballon FIFA Coupe du Monde 2026 Orange | Touni.ma",
    description_tag: "Ballon Adidas Trionda Pro Coupe du Monde FIFA 2026 — coloris Orange. Labellisé FIFA Quality Pro, taille 5. Livraison rapide au Maroc, paiement à la livraison.",
  },
  {
    id: 9365963047131,
    body_html: `<p><strong>Adidas Trionda Pro — Ballon FIFA Coupe du Monde 2026 — Blanc Multicolore</strong></p>
<p>Le ballon de match de la Coupe du Monde FIFA 2026, organisée au Canada, aux États-Unis et au Mexique. Conçu par Adidas et labellisé FIFA Quality Pro, il allie précision de vol, excellente touche de balle et durabilité éprouvée. Coloris Blanc Multicolore.</p>
<ul>
<li>Labellisé FIFA Quality Pro</li>
<li>Technologie de vol stabilisé — trajectoire précise</li>
<li>Taille 5 — convient à la compétition et à l'entraînement</li>
<li>Revêtement texturé haute performance</li>
<li>Coloris Blanc Multicolore</li>
</ul>`,
    title_tag: "Adidas Trionda Pro Ballon FIFA Coupe du Monde 2026 Blanc | Touni.ma",
    description_tag: "Ballon Adidas Trionda Pro Coupe du Monde FIFA 2026 — coloris Blanc Multicolore. Labellisé FIFA Quality Pro, taille 5. Livraison rapide au Maroc, paiement à la livraison.",
  },
  {
    id: 9365963079899,
    body_html: `<p><strong>Adidas Trionda Pro — Ballon FIFA Coupe du Monde 2026 — Jaune Fluo</strong></p>
<p>Le ballon de match de la Coupe du Monde FIFA 2026, organisée au Canada, aux États-Unis et au Mexique. Conçu par Adidas et labellisé FIFA Quality Pro, il allie précision de vol, excellente touche de balle et durabilité éprouvée. Coloris Jaune Fluo.</p>
<ul>
<li>Labellisé FIFA Quality Pro</li>
<li>Technologie de vol stabilisé — trajectoire précise</li>
<li>Taille 5 — convient à la compétition et à l'entraînement</li>
<li>Revêtement texturé haute performance</li>
<li>Coloris Jaune Fluo</li>
</ul>`,
    title_tag: "Adidas Trionda Pro Ballon FIFA Coupe du Monde 2026 Jaune Fluo | Touni.ma",
    description_tag: "Ballon Adidas Trionda Pro Coupe du Monde FIFA 2026 — coloris Jaune Fluo. Labellisé FIFA Quality Pro, taille 5. Livraison rapide au Maroc, paiement à la livraison.",
  },
];

// ─────────────────────────────────────────────────────────────
// THEME: new conditional Infos & Conditions block
// ─────────────────────────────────────────────────────────────
const NEW_TIC_LIQUID = `<style>
  .tic { margin: 0; font-family: inherit; }
  .tic-trigger { width: 100%; display: flex !important; align-items: center !important; justify-content: space-between !important; padding: 13px 0 !important; background: transparent !important; border: none !important; border-top: 1px solid #f0f0f0 !important; cursor: pointer !important; outline: none !important; gap: 10px !important; border-radius: 0 !important; min-height: unset !important; }
  .tic-left { display: flex; align-items: center; gap: 9px; }
  .tic-line { width: 2px; height: 22px; background: #e60012 !important; border-radius: 2px; flex-shrink: 0; }
  .tic-title { font-size: 11.5px; font-weight: 800; color: #111 !important; text-transform: uppercase; letter-spacing: 0.7px; }
  .tic-arrow { width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: transform 0.25s ease; }
  .tic-arrow svg { width: 13px; height: 13px; stroke: #ccc !important; fill: none !important; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; transition: stroke 0.2s; }
  .tic.open .tic-arrow { transform: rotate(180deg); }
  .tic.open .tic-arrow svg { stroke: #e60012 !important; }
  .tic-body { max-height: 0; overflow: hidden; transition: max-height 0.35s ease, opacity 0.3s ease; opacity: 0; }
  .tic.open .tic-body { max-height: 700px; opacity: 1; }
  .tic-inner { padding: 12px 0 16px; border-bottom: 1px solid #f0f0f0; }
  .tic-list { list-style: none !important; margin: 0 !important; padding: 0 !important; display: flex !important; flex-direction: column !important; gap: 9px !important; }
  .tic-list li { display: flex !important; align-items: flex-start !important; gap: 10px !important; font-size: 12px !important; color: #555 !important; line-height: 1.55 !important; background: none !important; padding: 0 !important; border: none !important; margin: 0 !important; }
  .tic-list li::before { content: '' !important; width: 14px !important; height: 14px !important; min-width: 14px !important; border-radius: 50% !important; background-color: #111 !important; margin-top: 2px !important; flex-shrink: 0 !important; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E") !important; background-size: 8px !important; background-repeat: no-repeat !important; background-position: center !important; }
  .tic-list li strong { font-weight: 700 !important; color: #111 !important; }
  .tic-list li span { color: #555 !important; }
  .tic-wa { display: inline-flex !important; align-items: center !important; gap: 4px !important; color: #25d366 !important; font-weight: 700 !important; text-decoration: none !important; font-size: 11px !important; }
  .tic-wa svg { width: 12px !important; height: 12px !important; fill: #25d366 !important; }
  .tic-note { margin-top: 12px !important; padding: 9px 12px !important; background: #fafafa !important; border-left: 2px solid #e60012 !important; border-radius: 0 6px 6px 0 !important; font-size: 11px !important; color: #666 !important; line-height: 1.55 !important; }
  .tic-note strong { color: #e60012 !important; font-weight: 700 !important; }
</style>

<div class="tic" id="tic-block">
  <button class="tic-trigger" onclick="ticToggle()" aria-expanded="false">
    <div class="tic-left">
      <div class="tic-line"></div>
      <span class="tic-title">Infos & conditions</span>
    </div>
    <div class="tic-arrow">
      <svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
  </button>
  <div class="tic-body">
    <div class="tic-inner">
      <ul class="tic-list">
        {% if product.type == 'Ballon de Football' %}
          <li><span><strong>Construction haute performance</strong> — chambre à air de qualité, revêtement texturé pour une touche et une trajectoire optimales</span></li>
          <li><span><strong>Taille 5</strong> — taille standard pour la compétition et l'entraînement</span></li>
          <li><span><strong>Poids et pression conformes FIFA</strong> — précision de vol et trajectoire stable garanties</span></li>
        {% elsif product.type == 'Casquette' or product.type == 'Casquettes' %}
          <li><span><strong>Qualité premium</strong> — matière solide, finitions soignées et coutures renforcées</span></li>
          <li><span><strong>Taille ajustable</strong> — convient à la plupart des tailles de tête</span></li>
        {% else %}
          <li><span><strong>Qualité professionnelle</strong> — tissus respirants, coutures solides et finitions soignées</span></li>
          {% if product.tags contains 'Maillot' %}
          <li>
            <span><strong>Flocage en option</strong> — personnalisez votre maillot avec votre nom & numéro au dos pour <strong>+99 DH</strong> (optionnel, au choix)</span>
          </li>
          {% endif %}
          <li>
            <span><strong>Tailles S à 2XL</strong> — les tailles sont correctes et adaptées au guide de taille disponible sur cette page. Pour une taille au-delà du 2XL, <a class="tic-wa" href="https://wa.me/212625254090" target="_blank">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
              contactez-nous sur WhatsApp
            </a> pour vérifier la disponibilité</span>
          </li>
        {% endif %}
        <li><span><strong>Livraison 24h à 48h</strong> — partout au Maroc, rapide et fiable</span></li>
        <li><span><strong>Paiement à la livraison</strong> — vous payez uniquement à la réception</span></li>
        <li><span><strong>Ouverture du colis autorisée</strong> — vérifiez votre article avant de payer</span></li>
        <li><span><strong>Échange accepté</strong> — défaut ou article incorrect, on règle ça ensemble</span></li>
      </ul>
      <div class="tic-note">
        <strong>Important :</strong> toute demande d'échange doit être signalée dans les <strong>48h suivant la réception</strong>. Passé ce délai, aucun échange ne sera effectué.
      </div>
    </div>
  </div>
</div>

<script>
window.ticToggle = function() {
  var block = document.getElementById('tic-block');
  var btn = block.querySelector('.tic-trigger');
  var isOpen = block.classList.contains('open');
  block.classList.toggle('open', !isOpen);
  btn.setAttribute('aria-expanded', String(!isOpen));
};
(function() {
  function supprimerEspace() {
    var bloc = document.getElementById('tic-block');
    if (!bloc) return;
    var parent = bloc.closest('.bee-pr__custom-liquid');
    if (parent) {
      var prev = parent.previousElementSibling;
      if (!prev || prev.className.indexOf('cda-wr') === -1) {
        parent.style.setProperty('margin-top', '-20px', 'important');
      } else {
        parent.style.setProperty('margin-top', '0', 'important');
      }
      parent.style.setProperty('margin-bottom', '0', 'important');
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', supprimerEspace);
  } else {
    supprimerEspace();
  }
})();
</script>`;

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const action = req.query.action || 'all';
  const hdrs = await shopifyAdminHeaders();
  const results = {};

  // ── 1. Update product descriptions ──────────────────────
  if (action === 'descriptions' || action === 'all') {
    results.descriptions = [];
    for (const p of PRODUCTS) {
      try {
        // Update body_html
        const pr = await fetch(`https://${_SD}/admin/api/${_SV}/products/${p.id}.json`, {
          method: 'PUT',
          headers: hdrs,
          body: JSON.stringify({ product: { id: p.id, body_html: p.body_html } }),
        });
        const pData = await pr.json();

        // Update metafields (title_tag + description_tag)
        const mfRes = await fetch(`https://${_SD}/admin/api/${_SV}/products/${p.id}/metafields.json`, { headers: hdrs });
        const mfData = await mfRes.json();
        const existingMfs = mfData.metafields || [];

        for (const [key, value] of [['title_tag', p.title_tag], ['description_tag', p.description_tag]]) {
          const existing = existingMfs.find(m => m.namespace === 'global' && m.key === key);
          if (existing) {
            await fetch(`https://${_SD}/admin/api/${_SV}/metafields/${existing.id}.json`, {
              method: 'PUT',
              headers: hdrs,
              body: JSON.stringify({ metafield: { id: existing.id, value } }),
            });
          } else {
            await fetch(`https://${_SD}/admin/api/${_SV}/products/${p.id}/metafields.json`, {
              method: 'POST',
              headers: hdrs,
              body: JSON.stringify({ metafield: { namespace: 'global', key, value, type: 'single_line_text_field' } }),
            });
          }
        }

        results.descriptions.push({ id: p.id, title: pData.product?.title, ok: pr.ok });
      } catch (e) {
        results.descriptions.push({ id: p.id, error: e.message });
      }
    }
  }

  // ── 2. Update theme template ─────────────────────────────
  if (action === 'theme' || action === 'all') {
    try {
      // Get active theme
      const themeR = await fetch(`https://${_SD}/admin/api/${_SV}/themes.json`, { headers: hdrs });
      const themes = await themeR.json();
      const activeTheme = (themes.themes || []).find(t => t.role === 'main');
      if (!activeTheme) throw new Error('No active theme found');

      // Read current product.json
      const assetR = await fetch(
        `https://${_SD}/admin/api/${_SV}/themes/${activeTheme.id}/assets.json?asset[key]=templates/product.json`,
        { headers: hdrs }
      );
      const assetData = await assetR.json();
      const template = JSON.parse(assetData.asset.value);

      // Update the tic block
      template.sections.main.blocks['custom_liquid_deyRad'].settings.custom_liquid = NEW_TIC_LIQUID;

      // Write back
      const putR = await fetch(`https://${_SD}/admin/api/${_SV}/themes/${activeTheme.id}/assets.json`, {
        method: 'PUT',
        headers: hdrs,
        body: JSON.stringify({
          asset: { key: 'templates/product.json', value: JSON.stringify(template) }
        }),
      });
      const putData = await putR.json();
      results.theme = { ok: putR.ok, theme: activeTheme.name, key: putData.asset?.key };
    } catch (e) {
      results.theme = { error: e.message };
    }
  }

  return res.json({ success: true, action, ...results });
};
