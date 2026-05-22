# 🌅 Handoff Matin — Activation Sync Shopify

> **TLDR** : J'ai construit toute l'infrastructure pendant que vous dormiez. Pour activer, **3 actions de votre côté (10 minutes max)** puis tout fonctionne.

---

## ✅ Ce qui est déjà fait (déployé sur Vercel)

### Base de données
- ✅ Colonnes `shopify_pushed_at`, `shopify_variant_id`, `shopify_inventory_item_id`, `shopify_qty_pushed` ajoutées à `stock`
- ✅ Nouvelle table `shopify_notifications` (commandes Shopify matchées avec votre stock retours, dédup par order+variant)
- ✅ Nouvelle table `shopify_variants_cache` (cache des variantes Shopify : titre + size + color → variant_id + inventory_item_id + inventory_quantity)

### 6 nouveaux endpoints Vercel
| Endpoint | Rôle | Méthode |
|---|---|---|
| `/api/sync-products-cache` | Sync TOUS les produits Shopify dans le cache local (titre/size/color/inventory) | POST + secret |
| `/api/sync-return-to-shopify` | Vérifie le stock retours vs Shopify et push qty si rupture | POST + secret |
| `/api/shopify-order-webhook` | Reçoit les commandes Shopify et crée des notifications si match | POST (Shopify) |
| `/api/list-shopify-locations` | Helper pour trouver votre `SHOPIFY_LOCATION_ID` | GET + secret |
| `/api/notifications` | API pour lire/marquer lu/archiver les notifications | GET/PATCH/DELETE |
| `/api/_shopify-helpers.js` | Helpers internes partagés | (interne) |

### UI déployée
- ✅ **Page Stock Retours** : bouton **🔄 Sync Shopify** dans le header (admin only) + icône 🔔 avec compteur + bandeau jaune si notifications en attente + dropdown notifications complet
- ✅ **Dashboard admin** : icône 🔔 dans le header + dropdown notifications (poll auto toutes les 60s)
- ✅ Chaque notification montre : numéro commande, client+ville, produit, taille, qty dispo, boutons Voir/Lu/Archiver

### Sécurité
- ✅ Endpoints sensibles protégés par `?secret=touni-sync-2026`
- ✅ Webhook Shopify protégé par HMAC SHA256 (vérification signature)
- ✅ Endpoints retournent **HTTP 503 explicite** si les variables d'env ne sont pas définies (pas de crash silencieux)

---

## 🎯 Vos 3 actions du matin (~10 min)

### Action 1 — Créer le token Shopify Admin (~5 min)

1. Ouvrez https://admin.shopify.com/store/tounikora/settings/apps/development (vous y étiez déjà)
2. Cliquez **"Développeur d'applications dans le Dev Dashboard"** (bouton noir)
3. **Create an app** → nom : `Touni Stock Sync` → Create
4. Onglet **Configuration** → **Configure Admin API scopes** → cochez :
   - ✅ `read_products`
   - ✅ `read_inventory`
   - ✅ `write_inventory`
   - ✅ `read_orders`
5. **Save**
6. Onglet **API credentials** → **Install app** → confirmer
7. Section **Admin API access token** → **Reveal token once** → **copier** (commence par `shpat_...`)

⚠ Ce token n'est visible qu'**une seule fois**. Si vous le perdez, faut le régénérer.

### Action 2 — Ajouter les variables d'env Vercel (~2 min)

Allez sur https://vercel.com/tahaaroff-pngs-projects/touni-retour/settings/environment-variables

Ajoutez ces 4 variables (toutes en Production) :

| Nom | Valeur | Explication |
|---|---|---|
| `SHOPIFY_ADMIN_TOKEN` | `shpat_xxxxxxx` | Le token de l'étape 1 |
| `SHOPIFY_LOCATION_ID` | `(vide pour l'instant)` | On le remplit en étape 3 |
| `SYNC_SECRET` | `touni-sync-2026` | Ou un mot de passe random, ce que vous voulez |
| `SHOPIFY_ORDER_WEBHOOK_SECRET` | `(vide pour l'instant)` | On le remplit après création du webhook |

Cliquez **Save** pour chaque. Puis **Redeploy** la dernière build (Vercel propose un bouton "Redeploy with latest env").

### Action 3 — Trouver votre Location ID + créer le webhook (~3 min)

**3a. Location ID**

Après le redeploy, ouvrez dans le navigateur :
```
https://touni-retour.vercel.app/api/list-shopify-locations?secret=touni-sync-2026
```

Vous verrez une réponse JSON avec vos locations. Copiez l'ID de votre location principale (celle où vous gérez votre stock).

Retournez dans Vercel → Environment Variables → modifiez `SHOPIFY_LOCATION_ID` avec cet ID → Save → Redeploy.

**3b. Webhook orders/create**

Dans Shopify Admin : Settings → **Notifications** (en bas, section "Webhooks") → **Create webhook**
- Event : `Order creation`
- Format : `JSON`
- URL : `https://touni-retour.vercel.app/api/shopify-order-webhook`
- API version : `2024-10` (ou la plus récente)
- Save

Shopify affiche un secret (commence par `hmac_...` ou similaire). Copiez-le, retournez dans Vercel et ajoutez-le à `SHOPIFY_ORDER_WEBHOOK_SECRET` → Save → Redeploy.

---

## 🚀 Premier lancement

### Sync initiale du cache produits (1 fois)

Ouvrez dans le navigateur :
```
https://touni-retour.vercel.app/api/sync-products-cache?secret=touni-sync-2026
```
Mais en **POST** (avec un outil comme Postman/Insomnia, ou via terminal :)

```bash
curl -X POST "https://touni-retour.vercel.app/api/sync-products-cache?secret=touni-sync-2026"
```

Vous devriez voir une réponse comme :
```json
{
  "success": true,
  "products_count": 145,
  "variants_count": 423,
  "upserted": 423,
  "out_of_stock": 89
}
```

Cela peuple `shopify_variants_cache` avec toutes vos variantes Shopify.

### Première sync des retours

Ouvrez https://touni-retour.vercel.app/ (Stock Retours), connectez-vous en admin.

Vous verrez le **bouton 🔄 Sync Shopify** dans le header en haut à droite.

Cliquez dessus → confirmation → ça vérifie vos 229 articles, pousse à Shopify ceux qui sont en rupture, et marque ceux pushés avec un badge.

Vous aurez un récap :
```
✅ Sync terminée
X combinaisons vérifiées
Y poussées à Shopify (rupture détectée)
Z ignorées (Shopify a déjà du stock)
W sans correspondance Shopify
```

### Vérifier les notifications

Une fois le webhook configuré, à chaque commande Shopify pour un produit que vous avez en stock retours, vous verrez :
- 🔔 avec un compteur rouge dans le header (dashboard + stock retours)
- Bandeau jaune en haut de Stock Retours : "X commandes Shopify pour des produits que vous avez en stock retours"
- Dropdown notifications avec détails (numéro commande, client, produit, taille, qty dispo)
- Boutons : Voir stock → ouvre la page stock | Lu → marque comme lue | Archiver

L'opératrice reste **maîtresse des statuts** (vendu / mystère / retour) — pas d'auto-déduction par le système.

---

## 🔧 Maintenance / opérations courantes

### Re-sync du cache Shopify (si nouveaux produits ajoutés)
```bash
curl -X POST "https://touni-retour.vercel.app/api/sync-products-cache?secret=touni-sync-2026"
```
À faire **1× par semaine** ou après ajout de nouveaux produits Shopify. (Le cache local sinon devient obsolète.)

### Resync retours manuel (ad hoc)
Cliquez le bouton **🔄 Sync Shopify** sur Stock Retours quand vous voulez.

### Dry-run (voir ce qui serait pushé sans pousser)
```bash
curl "https://touni-retour.vercel.app/api/sync-return-to-shopify?secret=touni-sync-2026"
# (GET = dry-run, POST = vrai push)
```

---

## 🐛 En cas de problème

### Le bouton Sync Shopify ne fait rien
- Vérifier `SHOPIFY_ADMIN_TOKEN` et `SHOPIFY_LOCATION_ID` dans Vercel
- Vérifier que le cache est peuplé : `SELECT count(*) FROM shopify_variants_cache;` dans Supabase

### "Aucune correspondance pour size=X color=Y"
- Le cache n'a peut-être pas la variante exacte (titre légèrement différent, normalisation taille…)
- Lancez `sync-products-cache` pour rafraîchir
- Vérifier le titre exact dans `products.json` vs ce qui est dans `stock.product`

### Webhook ne déclenche pas de notifications
- Vérifier `SHOPIFY_ORDER_WEBHOOK_SECRET` dans Vercel
- Tester avec Shopify : Webhooks page → "Send test notification" → checker les logs Vercel

### Token expiré (401)
- Les tokens custom apps Shopify **ne expirent pas** (contrairement aux tokens CLI 24h)
- Si 401, c'est probablement que l'app a été désinstallée. Réinstaller.

---

## 📊 Surveillance

Voir les logs Vercel des endpoints :
```
https://vercel.com/tahaaroff-pngs-projects/touni-retour/logs
```
Filtres utiles :
- `[sync-return]` — logs de sync retours
- `[sync-products-cache]` — logs de rafraîchissement cache
- `[order-webhook]` — logs des notifications de commandes

Tables Supabase à surveiller :
- `shopify_notifications` (status='unread' = non lues, archived = traitées)
- `shopify_variants_cache` (updated_at = dernière sync du cache)
- `stock` (shopify_pushed_at NOT NULL = ce qui a été pushé à Shopify)

---

## 💡 Évolutions possibles (pas implémentées)

- **Cron auto** pour `sync-products-cache` 1× par jour (Vercel Cron Jobs gratuit jusqu'à 1/jour, payant au-delà)
- **Auto-resync retours** quand on ajoute un nouveau retour (au lieu du bouton manuel) — il suffirait d'appeler `/api/sync-return-to-shopify` depuis `addItem()` dans index.html
- **Notification WhatsApp** au lieu de dashboard (nécessite Twilio ou WhatsApp Business API, ~5$/mois)
- **Webhooks Shopify additionnels** : `orders/cancelled` pour rétablir le stock, `orders/fulfilled` pour confirmer la sortie

Bonne nuit, à demain ! 🌙
