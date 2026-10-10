# karolive-kj : serveur des espaces KJ (KaroliveBox KJ)

Chaque KJ abonné à KaroliveBox KJ a son espace, désigné par un **code
permanent** : celui de son QR code,
`https://karonline64.github.io/Karaoke/?kj=CODE`. Le code n'est jamais
réattribué à un autre KJ, même après la fin de son abonnement.

La partie OpenKJ du KJ propriétaire (routes `/`, `/request`, `/status`, page
sans `?kj=`) ne change pas.

Serveur **séparé** du serveur OpenKJ du KJ propriétaire
(`cloudflare-request-server`), qui n'est pas modifié. Même compte
Cloudflare, adresse : `https://karolive-kj.<compte>.workers.dev`.

## Mise en ligne (PowerShell, PC fixe ou PC 24/7)

Double-clic sur **`DEPLOYER.bat`** (ou
`powershell -NoProfile -ExecutionPolicy Bypass -File .\deployer.ps1`).
Le script fait tout, et peut être relancé à chaque mise à jour :

1. installe Node.js s'il manque (puis demande de relancer) et l'outil `wrangler` ;
2. ouvre la connexion au compte Cloudflare (bouton « Allow ») ;
3. crée la base de données `karolive-kj` (une seule fois) ;
4. met le serveur en ligne ;
5. crée le jeton d'administration `KJ_ADMIN_TOKEN` (une seule fois, gardé
   dans `KJ_ADMIN_TOKEN.txt`, **secret** : il servira au serveur karolive.com) ;
6. vérifie que tout répond et affiche l'adresse du serveur.

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
npx wrangler dev --local --port 8787     # avec KJ_ADMIN_TOKEN dans [vars]
python tests/kj_flow_test.py http://localhost:8787 <KJ_ADMIN_TOKEN>
```
