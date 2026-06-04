// TEMPORARY — Création produit Adidas Trionda Pro FIFA CdM 2026
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  try {
    // 1. Récupérer un produit existant similaire pour comprendre la structure
    if (req.query.action === 'sample') {
      const hdrs = await shopifyAdminHeaders();
      const r = await fetch(
        `https://${_SD}/admin/api/${_SV}/products.json?limit=5&fields=id,title,body_html,tags,product_type,vendor,options`,
        { headers: hdrs }
      );
      const data = await r.json();
      return res.json(data);
    }

    // 2. Créer le produit
    const hdrs = await shopifyAdminHeaders();

    const body_html = `<p><strong>Le ballon officiel de la Coupe du Monde FIFA 2026™</strong> — l'Adidas Trionda Pro est le ballon de match officiel utilisé lors des rencontres du Mondial 2026 organisé au Canada, aux États-Unis et au Mexique.</p>

<p>Conçu avec la technologie <strong>Adidas Pro</strong> et certifié <strong>FIFA Quality Pro</strong>, il offre une précision de vol, une touche de balle et une durabilité d'exception. Disponible en 3 coloris exclusifs : Orange, Blanc Multicolore et Jaune Fluo.</p>

<ul>
  <li>✅ Ballon officiel FIFA Quality Pro — Coupe du Monde 2026</li>
  <li>⚽ Technologie de vol stabilisé — trajectoire parfaite</li>
  <li>🔶 Taille officielle 5 — pour compétition et entraînement</li>
  <li>🌍 Édition collector — design inspiré des 3 nations hôtes</li>
  <li>💧 Revêtement texturé haute performance</li>
  <li>🎨 3 coloris exclusifs : Orange · Blanc · Jaune Fluo</li>
</ul>

<p>Un ballon d'exception pour les passionnés de football. Que ce soit pour une utilisation en match ou en collection, le <strong>Trionda Pro</strong> est un incontournable de la Coupe du Monde 2026.</p>`;

    const product = {
      product: {
        title: "Adidas Trionda Pro — Ballon Officiel FIFA Coupe du Monde 2026",
        body_html,
        vendor: "Adidas",
        product_type: "Ballon de Football",
        tags: "ballon,fifa,coupe du monde,world cup 2026,adidas,trionda,match ball,football,collector,officiel",
        status: "active",
        options: [
          { name: "Couleur", values: ["Orange", "Blanc Multicolore", "Jaune Fluo"] }
        ],
        variants: [
          {
            option1: "Orange",
            price: "449.00",
            compare_at_price: "799.00",
            inventory_management: "shopify",
            inventory_policy: "deny",
            fulfillment_service: "manual",
            requires_shipping: true,
            taxable: false,
            weight: 0.43,
            weight_unit: "kg",
          },
          {
            option1: "Blanc Multicolore",
            price: "449.00",
            compare_at_price: "799.00",
            inventory_management: "shopify",
            inventory_policy: "deny",
            fulfillment_service: "manual",
            requires_shipping: true,
            taxable: false,
            weight: 0.43,
            weight_unit: "kg",
          },
          {
            option1: "Jaune Fluo",
            price: "449.00",
            compare_at_price: "799.00",
            inventory_management: "shopify",
            inventory_policy: "deny",
            fulfillment_service: "manual",
            requires_shipping: true,
            taxable: false,
            weight: 0.43,
            weight_unit: "kg",
          }
        ],
        metafields: [
          {
            namespace: "global",
            key: "title_tag",
            value: "Adidas Trionda Pro — Ballon Officiel FIFA Coupe du Monde 2026 | Touni.ma",
            type: "single_line_text_field",
          },
          {
            namespace: "global",
            key: "description_tag",
            value: "Achetez l'Adidas Trionda Pro, le ballon officiel de la Coupe du Monde FIFA 2026. FIFA Quality Pro, taille 5, disponible en Orange, Blanc et Jaune Fluo. Livraison rapide au Maroc.",
            type: "single_line_text_field",
          }
        ],
        published_scope: "global",
      }
    };

    const createRes = await fetch(
      `https://${_SD}/admin/api/${_SV}/products.json`,
      { method: 'POST', headers: hdrs, body: JSON.stringify(product) }
    );

    if (!createRes.ok) {
      const err = await createRes.text();
      return res.status(createRes.status).json({ error: err });
    }

    const created = await createRes.json();
    return res.json({ success: true, product_id: created.product?.id, title: created.product?.title });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
