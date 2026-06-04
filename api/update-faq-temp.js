// TEMPORARY — Pousse le nouveau design FAQ vers sections/seo-faq.liquid
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';
const THEME_ID = '160864698587'; // Claude modif 1 published (LIVE)

const NEW_FAQ_CONTENT = `
{%- if section.blocks.size > 0 -%}
<section class="touni-faq">

  <div class="touni-faq__header">
    <div class="touni-faq__line"></div>
    <h2 class="touni-faq__title">Questions fréquentes</h2>
  </div>

  <div class="touni-faq__list">
    {%- for block in section.blocks -%}
      {%- if block.type == 'faq_item' -%}
        <details class="touni-faq__item" {{ block.shopify_attributes }}>
          <summary class="touni-faq__question">
            <span>{{ block.settings.question }}</span>
            <svg class="touni-faq__icon" viewBox="0 0 24 24" aria-hidden="true">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </summary>
          <div class="touni-faq__body">
            <p class="touni-faq__answer">{{ block.settings.answer }}</p>
          </div>
        </details>
      {%- endif -%}
    {%- endfor -%}
  </div>

</section>
{%- endif -%}

{% stylesheet %}
  .touni-faq {
    padding: 52px 20px 56px;
    max-width: 780px;
    margin: 0 auto;
  }

  .touni-faq__header {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    margin-bottom: 36px;
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
    padding: 15px 0;
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
    padding: 2px 0 18px;
    font-size: 12.5px;
    line-height: 1.68;
    color: #555;
  }

  @media (max-width: 640px) {
    .touni-faq { padding: 36px 16px 40px; }
    .touni-faq__header { margin-bottom: 28px; }
    .touni-faq__question { font-size: 13px; }
  }
{% endstylesheet %}

{% schema %}
{
  "name": "FAQ",
  "tag": "div",
  "class": "section-faq",
  "max_blocks": 12,
  "blocks": [
    {
      "type": "faq_item",
      "name": "Question",
      "settings": [
        {
          "type": "text",
          "id": "question",
          "label": "Question",
          "default": "Question fréquente"
        },
        {
          "type": "textarea",
          "id": "answer",
          "label": "Réponse",
          "default": "Réponse détaillée ici."
        }
      ]
    }
  ],
  "presets": [
    {
      "name": "FAQ",
      "blocks": [
        {
          "type": "faq_item",
          "settings": {
            "question": "Quelle est la qualité de vos produits ?",
            "answer": "Nos articles sont sélectionnés pour leur qualité de finition et leur rendu visuel soigné — tissus respirants, broderies solides et matières durables. Chaque produit est contrôlé avant expédition pour vous garantir une satisfaction à la réception."
          }
        },
        {
          "type": "faq_item",
          "settings": {
            "question": "Comment fonctionne la livraison au Maroc ?",
            "answer": "Touni.ma livre partout au Maroc en 24 à 48 heures ouvrables. La livraison est gratuite sur toutes vos commandes, quelle que soit la destination — du Nord au Sud, de l'Est à l'Ouest."
          }
        },
        {
          "type": "faq_item",
          "settings": {
            "question": "Le paiement à la livraison est-il disponible ?",
            "answer": "Oui. Vous ne payez qu'à la réception de votre colis, en espèces, directement au livreur. Aucune avance n'est requise."
          }
        },
        {
          "type": "faq_item",
          "settings": {
            "question": "Puis-je vérifier le colis avant de payer ?",
            "answer": "Absolument. Vous êtes libre de contrôler votre article en présence du livreur avant tout paiement. Si le produit ne correspond pas à votre commande, vous pouvez le refuser sur place."
          }
        },
        {
          "type": "faq_item",
          "settings": {
            "question": "Comment effectuer un échange ?",
            "answer": "Tout échange doit être signalé dans les 48 heures suivant la réception. Contactez-nous via WhatsApp ou par e-mail avec votre numéro de commande — notre équipe vous accompagne jusqu'à la résolution."
          }
        },
        {
          "type": "faq_item",
          "settings": {
            "question": "Comment choisir la bonne taille ?",
            "answer": "Un guide des tailles est disponible sur chaque fiche produit. En cas de doute entre deux tailles, nous conseillons de prendre la taille supérieure pour plus de confort. Pour une demande spécifique, contactez-nous sur WhatsApp."
          }
        },
        {
          "type": "faq_item",
          "settings": {
            "question": "Proposez-vous le flocage (nom + numéro) ?",
            "answer": "Oui, le flocage est disponible sur une sélection de maillots pour +99 DH. Choisissez l'option sur la fiche produit et indiquez votre nom et numéro — réalisé à la commande."
          }
        },
        {
          "type": "faq_item",
          "settings": {
            "question": "Livrez-vous en grandes tailles (3XL, 4XL) ?",
            "answer": "Pour les tailles au-delà du 2XL, contactez-nous directement sur WhatsApp pour vérifier la disponibilité sur le produit souhaité. Nous faisons notre possible pour satisfaire chaque demande."
          }
        }
      ]
    }
  ]
}
{% endschema %}
`.trim();

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  try {
    const hdrs = await shopifyAdminHeaders();

    // Push new seo-faq.liquid to Shopify theme
    const assetKey = 'sections/seo-faq.liquid';
    const r = await fetch(
      `https://${_SD}/admin/api/${_SV}/themes/${THEME_ID}/assets.json`,
      {
        method: 'PUT',
        headers: { ...hdrs, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset: {
            key: assetKey,
            value: NEW_FAQ_CONTENT,
          },
        }),
      }
    );

    const txt = await r.text();
    let data;
    try { data = JSON.parse(txt); } catch (_) { data = { raw: txt }; }

    if (!r.ok) {
      return res.status(r.status).json({ error: 'Shopify error', detail: data });
    }

    res.json({
      ok: true,
      asset: data.asset?.key,
      updated_at: data.asset?.updated_at,
      theme_id: THEME_ID,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
