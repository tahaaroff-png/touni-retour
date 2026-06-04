// TEMPORARY — Reduce FAQ top spacing (padding-top: 0)
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';
const THEME_ID = '160850116827';

const NEW_FAQ = `<section class="touni-faq">

  <div class="touni-faq__header">
    <span class="touni-faq__label">Questions fréquentes</span>
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
    padding: 0 20px 20px;
    max-width: 760px;
    margin: 0 auto;
  }
  .touni-faq__header {
    display: flex;
    justify-content: center;
    margin-bottom: 20px;
  }
  .touni-faq__label {
    display: inline-block;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #C8252D;
    border: 1.5px solid #C8252D;
    border-radius: 4px;
    padding: 7px 16px;
    line-height: 1;
  }
  .touni-faq__list { display: flex; flex-direction: column; }
  .touni-faq__item { border-top: 1px solid #ECECEC; }
  .touni-faq__item:last-child { border-bottom: 1px solid #ECECEC; }
  .touni-faq__question {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 13px 0;
    cursor: pointer;
    font-weight: 600;
    font-size: 13px;
    color: #1A1A1A;
    gap: 14px;
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
    width: 14px;
    height: 14px;
    stroke: #B8B8B8;
    fill: none;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 0.22s cubic-bezier(0.4,0,0.2,1), stroke 0.18s;
  }
  details[open] > summary .touni-faq__icon {
    transform: rotate(180deg);
    stroke: #C8252D;
  }
  .touni-faq__body {
    overflow: hidden;
    max-height: 0;
    transition: max-height 0.3s cubic-bezier(0.4,0,0.2,1), opacity 0.25s;
    opacity: 0;
  }
  details[open] .touni-faq__body { max-height: 400px; opacity: 1; }
  .touni-faq__answer {
    padding: 2px 0 14px;
    font-size: 13px;
    line-height: 1.6;
    color: #6E6E6E;
    margin: 0;
  }
  @media (max-width: 640px) {
    .touni-faq { padding: 0 16px 16px; }
    .touni-faq__header { margin-bottom: 16px; }
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

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const hdrs = await shopifyAdminHeaders();
    const base = `https://${_SD}/admin/api/${_SV}/themes/${THEME_ID}/assets.json`;
    const r = await fetch(base, {
      method: 'PUT',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset: { key: 'sections/seo-faq.liquid', value: NEW_FAQ } }),
    });
    const d = await r.json();
    res.json({ ok: r.ok, updated_at: d.asset?.updated_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
