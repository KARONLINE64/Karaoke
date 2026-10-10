# Espaces KJ (KaroliveBox KJ) sur le serveur de demandes

Chaque KJ abonné à KaroliveBox KJ a son espace, désigné par un **code
permanent** : celui de son QR code,
`https://karonline64.github.io/Karaoke/?kj=CODE`. Le code n'est jamais
réattribué à un autre KJ, même après la fin de son abonnement.

La partie OpenKJ du KJ propriétaire (routes `/`, `/request`, `/status`, page
sans `?kj=`) ne change pas.

## Mise en ligne

1. Ajouter le secret **`KJ_ADMIN_TOKEN`** au Worker (une longue phrase
   aléatoire, 40 caractères ou plus) : tableau de bord Cloudflare → Workers →
   `cloudflare-request-server` → Settings → Variables and Secrets → Add →
   type *Secret*. Ou en ligne de commande : `npx wrangler secret put KJ_ADMIN_TOKEN`.
   Le même jeton sera donné au serveur karolive.com (il crée les espaces KJ).
2. Déployer comme d'habitude (`npx wrangler deploy`). Les tables `kjs`,
   `kj_requests` et `kj_catalog` sont créées automatiquement dans la base D1
   existante, à la première utilisation ; rien n'est modifié dans `requests`
   ni `meta`.

## Routes

| Qui | Route | Rôle |
|---|---|---|
| Page des clients | `GET /kj/CODE/info` | nom, logo, catalogue, en ligne ?, demandes ouvertes ? |
| | `GET /kj/CODE/catalog` | catalogue du KJ (artiste + titre, jamais de fichier) |
| | `GET /kj/CODE/logo` | logo du KJ |
| | `POST /kj/CODE/request` | demande d'un client |
| KaroliveBox KJ (clé du KJ) | `POST /kj/CODE` | commandes OpenKJ + `getProfile`, `setProfile`, `close` |
| | `PUT /kj/CODE/catalog` | publication du catalogue |
| | `PUT /kj/CODE/logo` | logo (PNG / JPEG / WebP, 300 Ko max) |
| karolive.com (`KJ_ADMIN_TOKEN`) | `POST /admin/kj` | création d'un KJ, abonnement actif / suspendu |

## Règles

- **Fermeture de KaroliveBox KJ** (`close`) : les demandes restantes sont
  effacées, la page passe hors ligne.
- **Option « hors soirée »** (réglage du KJ) : logiciel fermé, le catalogue
  reste consultable et les demandes sont gardées jusqu'à la prochaine
  ouverture, **48 h au plus**.
- **Abonnement suspendu** : page fermée, logiciel refusé ; le code et le QR
  restent ceux du KJ et refonctionnent dès la réactivation.
- Seule l'empreinte (SHA-256) de la clé d'un KJ est stockée.
- Le signe de vie du logiciel n'est écrit qu'une fois toutes les 15 s
  (quota d'écritures D1) ; le KJ est vu « en ligne » pendant 35 s.

## Test

```
npx wrangler dev --local --port 8787     # avec KJ_ADMIN_TOKEN et OPENKJ_API_KEY dans [vars]
python tests/kj_flow_test.py http://localhost:8787 <KJ_ADMIN_TOKEN> <OPENKJ_API_KEY>
```
