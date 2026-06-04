// TEMPORARY — Create Colombia + Germany jerseys + 3 Trionda balls (separate products)
// DELETE AFTER USE

const {
  SHOPIFY_DOMAIN: _SD, SHOPIFY_API_VERSION: _SV,
  shopifyAdminHeaders,
} = require('./_shopify-helpers.js');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

// Collection IDs
const COLLECTIONS = {
  international: 516199022811,
  tousNosMaillots: 523328323803,
  tousNosArticles: 532561068251,
  nouvellesArrivees: 529974460635,
  accessoires: 527817670875,
  bestSellers: 516171694299,
};

async function shopifyPost(path, body, hdrs) {
  const r = await fetch(`https://${_SD}/admin/api/${_SV}/${path}`, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`POST ${path} failed: ${JSON.stringify(data)}`);
  return data;
}

async function addToCollections(productId, collectionIds, hdrs) {
  const results = [];
  for (const cid of collectionIds) {
    try {
      const r = await shopifyPost('collects.json', { collect: { product_id: productId, collection_id: cid } }, hdrs);
      results.push({ collection_id: cid, collect_id: r.collect?.id, ok: true });
    } catch (e) {
      results.push({ collection_id: cid, error: e.message });
    }
  }
  return results;
}

module.exports = async (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const hdrs = await shopifyAdminHeaders();
  const results = [];

  try {
    // ─────────────────────────────────────────────
    // 1. COLOMBIA JERSEY
    // ─────────────────────────────────────────────
    const colombiaProduct = {
      product: {
        title: "Colombie — Maillot Adidas Originals Rétro",
        body_html: `<p><strong>PORTEZ LES COULEURS DE LA SELECCIÓN 🇨🇴🔥</strong></p>

<p><strong>Colombie — Maillot Adidas Originals Rétro</strong></p>

<p>La Colombie, l'une des équipes les plus élégantes du football mondial. Ce maillot bleu électrique aux motifs géométriques audacieux et touches jaunes rend hommage au style légendaire des années 90. Logo Trefoil Adidas, écusson de la Selección Colombia — une pièce collector intemporelle.</p>

<p><strong>NOS AVANTAGES</strong></p>
<ul>
  <li><strong>Livraison GRATUITE PARTOUT AU MAROC 🇲🇦</strong></li>
  <li><strong>Expédition rapide — 1 à 3 jours ouvrables</strong></li>
  <li><strong>Paiement à la livraison disponible</strong></li>
  <li>🇨🇴 Écusson Selección Colombia brodé</li>
  <li>🎨 Design rétro exclusif — motif géométrique signature bleu & jaune</li>
  <li>Logo Adidas Trefoil — collection streetwear</li>
  <li>Tissu technique respirant, coupe moderne</li>
</ul>

<p><strong>Commandez maintenant sur touni.ma — paiement à la livraison disponible partout au Maroc.</strong></p>`,
        vendor: "Touni.ma",
        product_type: "Maillot de Football",
        tags: "maillot,colombie,adidas,retro,international,national,collector,adidas originals",
        status: "active",
        published_scope: "global",
        options: [{ name: "Taille", values: ["S", "M", "L", "XL", "XXL"] }],
        variants: ["S", "M", "L", "XL", "XXL"].map(size => ({
          option1: size,
          price: "429.00",
          compare_at_price: "799.00",
          inventory_management: "shopify",
          inventory_policy: "deny",
          fulfillment_service: "manual",
          requires_shipping: true,
          taxable: false,
          weight: 0.25,
          weight_unit: "kg",
        })),
        metafields: [
          {
            namespace: "global",
            key: "title_tag",
            value: "Colombie Maillot Adidas Originals Rétro | Touni.ma",
            type: "single_line_text_field",
          },
          {
            namespace: "global",
            key: "description_tag",
            value: "Maillot rétro de la Selección Colombia — Adidas Originals. Design bleu électrique & jaune, écusson brodé, livraison gratuite au Maroc, paiement à la livraison.",
            type: "single_line_text_field",
          }
        ],
      }
    };

    const colombiaRes = await shopifyPost('products.json', colombiaProduct, hdrs);
    const colombiaId = colombiaRes.product?.id;
    const colombiaCollects = await addToCollections(colombiaId, [
      COLLECTIONS.international,
      COLLECTIONS.tousNosMaillots,
      COLLECTIONS.tousNosArticles,
      COLLECTIONS.nouvellesArrivees,
    ], hdrs);
    results.push({ product: "Colombie", id: colombiaId, title: colombiaRes.product?.title, collects: colombiaCollects });

    // ─────────────────────────────────────────────
    // 2. GERMANY JERSEY
    // ─────────────────────────────────────────────
    const germanyProduct = {
      product: {
        title: "Allemagne — Maillot Adidas Originals 4 Étoiles",
        body_html: `<p><strong>PORTEZ LES COULEURS DE LA MANNSCHAFT 🇩🇪⭐🔥</strong></p>

<p><strong>Allemagne — Maillot Adidas Originals 4 Étoiles</strong></p>

<p>L'Allemagne, 4 fois Championne du Monde. Ce maillot bleu nuit aux touches émeraude incarne la puissance et l'élégance de la Mannschaft. Logo Trefoil Adidas, écusson DFB et 4 étoiles emblématiques — pour les vrais passionnés de football.</p>

<p><strong>NOS AVANTAGES</strong></p>
<ul>
  <li><strong>Livraison GRATUITE PARTOUT AU MAROC 🇲🇦</strong></li>
  <li><strong>Expédition rapide — 1 à 3 jours ouvrables</strong></li>
  <li><strong>Paiement à la livraison disponible</strong></li>
  <li>🇩🇪 Écusson DFB brodé — ⭐⭐⭐⭐ 4 fois Champion du Monde</li>
  <li>🎨 Coloris bleu nuit & émeraude exclusif</li>
  <li>Logo Adidas Trefoil — collection streetwear</li>
  <li>Tissu technique respirant, coupe moderne</li>
</ul>

<p><strong>Commandez maintenant sur touni.ma — paiement à la livraison disponible partout au Maroc.</strong></p>`,
        vendor: "Touni.ma",
        product_type: "Maillot de Football",
        tags: "maillot,allemagne,germany,adidas,retro,international,national,dfb,4 etoiles,collector,adidas originals",
        status: "active",
        published_scope: "global",
        options: [{ name: "Taille", values: ["S", "M", "L", "XL", "XXL"] }],
        variants: ["S", "M", "L", "XL", "XXL"].map(size => ({
          option1: size,
          price: "429.00",
          compare_at_price: "799.00",
          inventory_management: "shopify",
          inventory_policy: "deny",
          fulfillment_service: "manual",
          requires_shipping: true,
          taxable: false,
          weight: 0.25,
          weight_unit: "kg",
        })),
        metafields: [
          {
            namespace: "global",
            key: "title_tag",
            value: "Allemagne Maillot Adidas Originals 4 Étoiles DFB | Touni.ma",
            type: "single_line_text_field",
          },
          {
            namespace: "global",
            key: "description_tag",
            value: "Maillot Adidas Originals de l'équipe d'Allemagne — 4 étoiles, écusson DFB brodé, coloris bleu nuit & émeraude. Livraison gratuite au Maroc, paiement à la livraison.",
            type: "single_line_text_field",
          }
        ],
      }
    };

    const germanyRes = await shopifyPost('products.json', germanyProduct, hdrs);
    const germanyId = germanyRes.product?.id;
    const germanyCollects = await addToCollections(germanyId, [
      COLLECTIONS.international,
      COLLECTIONS.tousNosMaillots,
      COLLECTIONS.tousNosArticles,
      COLLECTIONS.nouvellesArrivees,
    ], hdrs);
    results.push({ product: "Allemagne", id: germanyId, title: germanyRes.product?.title, collects: germanyCollects });

    // ─────────────────────────────────────────────
    // 3. BALLS — 3 separate products (1 per color)
    // ─────────────────────────────────────────────
    const ballColors = [
      {
        color: "Orange",
        titleTag: "Adidas Trionda Pro Ballon FIFA Coupe du Monde 2026 Orange | Touni.ma",
        descTag: "Ballon Adidas Trionda Pro Coupe du Monde FIFA 2026 — coloris Orange. Certifié FIFA Quality Pro, taille 5. Livraison gratuite au Maroc, paiement à la livraison.",
        tags: "ballon,adidas,trionda,coupe du monde,world cup 2026,fifa,match ball,football,collector,orange,taille 5",
      },
      {
        color: "Blanc Multicolore",
        titleTag: "Adidas Trionda Pro Ballon FIFA Coupe du Monde 2026 Blanc | Touni.ma",
        descTag: "Ballon Adidas Trionda Pro Coupe du Monde FIFA 2026 — coloris Blanc Multicolore. Certifié FIFA Quality Pro, taille 5. Livraison gratuite au Maroc, paiement à la livraison.",
        tags: "ballon,adidas,trionda,coupe du monde,world cup 2026,fifa,match ball,football,collector,blanc,multicolore,taille 5",
      },
      {
        color: "Jaune Fluo",
        titleTag: "Adidas Trionda Pro Ballon FIFA Coupe du Monde 2026 Jaune | Touni.ma",
        descTag: "Ballon Adidas Trionda Pro Coupe du Monde FIFA 2026 — coloris Jaune Fluo. Certifié FIFA Quality Pro, taille 5. Livraison gratuite au Maroc, paiement à la livraison.",
        tags: "ballon,adidas,trionda,coupe du monde,world cup 2026,fifa,match ball,football,collector,jaune,fluo,taille 5",
      },
    ];

    const ballBodyHtml = (color) => `<p><strong>LE BALLON DE LA COUPE DU MONDE 2026™ ⚽🔥</strong></p>

<p><strong>Adidas Trionda Pro — Ballon FIFA Coupe du Monde 2026 — ${color}</strong></p>

<p>L'Adidas Trionda Pro est le ballon de match utilisé lors de toutes les rencontres de la Coupe du Monde FIFA 2026™, organisée au Canada, aux États-Unis et au Mexique. Certifié <strong>FIFA Quality Pro</strong>, il allie précision de vol, touche de balle irréprochable et durabilité d'exception — conçu pour les plus grandes scènes du football mondial.</p>

<p><strong>NOS AVANTAGES</strong></p>
<ul>
  <li><strong>Livraison GRATUITE PARTOUT AU MAROC 🇲🇦</strong></li>
  <li><strong>Expédition rapide — 1 à 3 jours ouvrables</strong></li>
  <li><strong>Paiement à la livraison disponible</strong></li>
  <li>✅ Certifié FIFA Quality Pro — ballon de match CdM 2026</li>
  <li>⚽ Technologie de vol stabilisé — trajectoire parfaite à chaque frappe</li>
  <li>🔶 Taille 5 — compétition & entraînement</li>
  <li>🌍 Édition collector — design inspiré des 3 nations hôtes</li>
  <li>💧 Revêtement texturé haute performance — grip optimal</li>
  <li>🎨 Coloris <strong>${color}</strong></li>
</ul>

<p><strong>Commandez maintenant sur touni.ma — paiement à la livraison disponible partout au Maroc.</strong></p>`;

    for (const ball of ballColors) {
      const ballProduct = {
        product: {
          title: `Adidas Trionda Pro — Ballon FIFA Coupe du Monde 2026 — ${ball.color}`,
          body_html: ballBodyHtml(ball.color),
          vendor: "Adidas",
          product_type: "Ballon de Football",
          tags: ball.tags,
          status: "active",
          published_scope: "global",
          options: [{ name: "Taille", values: ["Taille 5"] }],
          variants: [{
            option1: "Taille 5",
            price: "449.00",
            compare_at_price: "799.00",
            inventory_management: "shopify",
            inventory_policy: "deny",
            fulfillment_service: "manual",
            requires_shipping: true,
            taxable: false,
            weight: 0.43,
            weight_unit: "kg",
          }],
          metafields: [
            { namespace: "global", key: "title_tag", value: ball.titleTag, type: "single_line_text_field" },
            { namespace: "global", key: "description_tag", value: ball.descTag, type: "single_line_text_field" },
          ],
        }
      };

      const ballRes = await shopifyPost('products.json', ballProduct, hdrs);
      const ballId = ballRes.product?.id;
      const ballCollects = await addToCollections(ballId, [
        COLLECTIONS.accessoires,
        COLLECTIONS.tousNosArticles,
        COLLECTIONS.nouvellesArrivees,
      ], hdrs);
      results.push({ product: `Trionda ${ball.color}`, id: ballId, title: ballRes.product?.title, collects: ballCollects });
    }

    return res.json({ success: true, created: results.length, results });

  } catch (e) {
    return res.status(500).json({ error: e.message, partial_results: results });
  }
};
