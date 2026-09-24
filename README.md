# Moteur IA généraliste sur Telegram — v2

Un seul bot Telegram, un seul moteur IA, plusieurs personnages/configurations
possibles. Sessions multiples (façon ChatGPT), mémoire à 3 niveaux
(globale / session / personnage), fournisseur IA interchangeable par
variable d'environnement.

## 1. Arborescence

Depuis la migration "Core multi-interface" (v5), le code est séparé en deux
parties : `core/` (logique métier, indépendante de toute interface) et
`interfaces/` (Telegram, Web) qui l'utilisent toutes les deux.

```
telegram-ai-character/
├── .env.example
├── package.json
├── README.md
├── sql/
│   └── schema.sql, migration_v3/v4/v5.sql
├── core/                          ← logique métier, 0 dépendance à Telegram ou HTTP
│   ├── engine.js                  ← processMessage() : point d'entrée UNIQUE, 1 message = 1 appel IA
│   ├── session/sessionManager.js  ← créer/lister/activer une conversation
│   ├── character/characterManager.js
│   ├── memory/memoryManager.js    ← sélection pertinente : global / session / character
│   ├── search/webSearch.js        ← détection par règles + recherche Tavily structurée (sources, dates, fiabilité)
│   ├── ai/
│   │   ├── router.js              ← generateAIResponse() — point d'entrée UNIQUE vers un provider
│   │   ├── promptBuilder.js       ← construit le prompt + extrait la mémoire
│   │   └── providers/{groq,gemini,openrouter}.js
│   ├── database/supabase.js
│   └── utils/logger.js
└── interfaces/
    ├── telegram/                  ← comportement inchangé, délègue à core/engine.js
    │   ├── index.js               ← point d'entrée (ex src/index.js)
    │   ├── bot.js                 ← connexion Telegram (polling)
    │   ├── handlers.js            ← orchestration message/callback, appelle core/engine.js
    │   ├── commands.js            ← /new, /sessions, /characters, callbacks boutons
    │   ├── keyboards.js           ← claviers inline (menus)
    │   └── conversationState.js
    └── web/
        └── server/                ← API HTTP (Express), auth Supabase par JWT
            ├── index.js           ← bootstrap Express (npm run start:web)
            ├── supabaseAuthClient.js
            ├── middleware/auth.js ← vérifie le Bearer token, résout l'utilisateur Core
            └── routes/{auth,sessions,characters}.js
```

Un même `core/` sert donc aux deux interfaces : aucune logique de session,
mémoire, personnage ou appel IA n'est dupliquée entre Telegram et Web.

## 2. Installation

Prérequis : **Node.js 22+** (le projet est prévu pour, `package.json` le déclare via `engines`).

```bash
cd telegram-ai-character
npm install
cp .env.example .env
# puis remplir .env (voir sections 3 à 5)
```

Sur Replit : si Node 20 est proposé par défaut, le code reste compatible
(le client Supabase utilise le package `ws` en repli), mais privilégie Node
22 si l'environnement le permet.

## 3. Telegram

1. **@BotFather** → `/newbot` → récupère le token.
2. Colle-le dans `.env` → `TELEGRAM_BOT_TOKEN=...`.

## 4. Supabase

1. Nouveau projet sur [supabase.com](https://supabase.com) (plan Free).
2. **SQL Editor → New query** → colle tout `sql/schema.sql` → **Run**.
   ⚠️ Ce script supprime d'anciennes tables v1 si elles existent.
3. **Project Settings → API** :
   - **Project URL** (parfois affiché "API URL") → `SUPABASE_URL=`
   - clé **`service_role`** (pas `anon`) → `SUPABASE_SERVICE_ROLE_KEY=`

## 5. Fournisseurs IA

**Groq (principal)**
1. Compte gratuit sur [console.groq.com](https://console.groq.com) → API Keys.
2. `.env` : `GROQ_API_KEY=gsk_...`
3. Modèle : `AI_MODEL=openai/gpt-oss-120b` (vérifie les noms à jour sur console.groq.com/docs/models — Groq change parfois ses noms de modèles).

**Gemini (secours, si Groq tombe en panne/quota dépassé)**
1. Clé gratuite sur [aistudio.google.com](https://aistudio.google.com) (Google AI Studio) → Get API Key.
2. `.env` : `GEMINI_API_KEY=...`
3. Modèle : `AI_MODEL_FALLBACK=gemini-2.0-flash` (vérifie les noms à jour sur ai.google.dev/gemini-api/docs/models).

Le fournisseur et le modèle ne sont JAMAIS codés en dur : tout passe par
`.env`. Pour changer, une seule ligne à modifier, jamais le code.

## 6. Lancement

```bash
npm start            # ou npm run start:telegram — bot Telegram (polling), comportement inchangé
npm run start:web    # serveur HTTP (API pour une future interface Web/app)
```
Les deux peuvent tourner en parallèle (deux process séparés) : ils partagent
le même `core/` et la même base Supabase, mais n'ont aucune dépendance
l'un envers l'autre.

## 7. Utilisation dans Telegram

- `/start` → menu principal (boutons)
- `/new` → nouvelle conversation : discussion générale ou avec un personnage existant
- `/sessions` → liste tes conversations, permet d'y revenir (bascule active)
- `/characters` → liste tes personnages

**Créer un personnage** (pas encore de formulaire Telegram dans ce prototype) :
directement dans Supabase → **Table Editor → characters** → **Insert row**.
Champs : `user_id` (l'UUID de ta ligne dans `users`), `name`, `age`,
`description`, `personality`, `backstory`, `speaking_style`,
`relationship_default`, `rules`, `additional_instructions`.

## 8. Comment fonctionne la mémoire

Trois portées (`scope`), stockées dans la même table `memories` :

- **`global`** : vrai sur toi, dans n'importe quelle conversation. Injectée
  **seulement si pertinente** par rapport au message en cours — jamais
  systématiquement (pour ne pas polluer un RP avec des infos perso hors sujet).
- **`session`** : propre à CETTE conversation précise.
- **`character`** : propre à CE personnage (relation, événements vécus avec
  lui), réutilisable si tu reparles à ce même personnage dans une autre session.

**Extraction économique** : contrairement à une v1 naïve, il n'y a **pas**
d'appel IA séparé pour décider quoi mémoriser. Le modèle ajoute, à la fin de
sa propre réponse, un bloc technique invisible pour l'utilisateur
(`###MEMORY###` + JSON) que le backend découpe avant affichage. Résultat :
**1 message utilisateur = 1 seul appel IA**, quota préservé.

## 9. Recherche Internet

Séparée du modèle (`core/search/webSearch.js`). Le backend décide s'il faut
chercher, le modèle ne « prétend » jamais avoir Internet.

**Fonctionnement**
- **Détection par règles** (`needsWebSearch()` / `resolveWebIntent()`), gratuite,
  sans appel API : recherche forcée, jamais (salutations, messages personnels),
  identité / œuvres / entités connues, déclencheurs automatiques (actualité,
  prix, versions…). Extensible : `registerRule()`.
- **Requête optimisée** : nettoyage du message, découpage des questions
  multiples en sous-recherches (3 max), `topic` / `time_range` selon le sujet.
- **Sources officielles** : catalogue « sujet → domaines officiels »
  (`registerOfficialSource()`), transmis à Tavily via `include_domains` en mode
  `prefer`. Résultats dédoublonnés, filtrés puis classés :
  officiel > institutionnel > média reconnu > référence > autre > forum.
- **Retour structuré** (`searchWeb()`) : `results` (titre, URL, domaine, date de
  publication, fraîcheur, type de source, extrait), `sources` (version allégée
  pour une interface), `queries`, `rejected`, `meta`. Ne lève jamais d'exception.
- `core/engine.js` renvoie en plus `sources` et `webSearch` (résumé technique)
  dans le résultat de `processMessage()` ; les champs existants sont inchangés.
- `core/ai/promptBuilder.js` injecte un bloc « RÉSULTATS DE RECHERCHE WEB » avec
  une section par source et des règles d'usage : ne pas mélanger web et
  connaissances internes, signaler les dates et les contradictions, pouvoir
  répondre « je n'ai pas trouvé de source fiable ». Les extraits sont traités
  comme des données (jamais comme des instructions).
- Sans clé, ou en cas d'échec / timeout, la réponse du personnage part quand même.

**Variables `.env`** (toutes optionnelles sauf la clé)

| Variable | Défaut | Rôle |
|---|---|---|
| `TAVILY_API_KEY` | — | Clé Tavily (https://tavily.com, free tier). Sans clé : pas de recherche. |
| `WEB_SEARCH_MODE` | `auto` | `off` = recherche désactivée ; `web` = toujours chercher. |
| `WEB_SEARCH_ENGINE` | `v2` | `legacy` = ancien moteur (`webSearch.legacy.js`), retour arrière immédiat. |
| `WEB_SEARCH_DEBUG` | `1` hors production | Logs détaillés (déclenchement, requêtes, domaines, rejets, durée). Jamais de clé. |
| `TAVILY_MAX_RESULTS` | `5` | Résultats par requête (1–20). |
| `TAVILY_SEARCH_DEPTH` | `basic` | `basic`, `advanced` (2 crédits), `fast`, `ultra-fast`. |
| `TAVILY_TOPIC` | `auto` | `auto` (choisi selon la question), `general`, `news`, `finance`. |
| `TAVILY_INCLUDE_RAW_CONTENT` | `false` | `false`, `markdown` ou `text`. |
| `TAVILY_INCLUDE_ANSWER` | `false` | Résumé généré par Tavily (sans source) : désactivé par défaut. |
| `TAVILY_TIMEOUT_MS` | `8000` | Timeout par requête. |
| `WEB_SEARCH_MAX_SUBQUERIES` | `3` | Sous-recherches max par message (1 crédit Tavily chacune en `basic`). |
| `WEB_SEARCH_MAX_TOTAL` | `8` | Sources conservées au total. |
| `WEB_PROMPT_MAX_CHARS` / `WEB_PROMPT_EXCERPT_CHARS` | `4500` / `600` | Budget du bloc web dans le prompt (protège les quotas de tokens). |

### Recherche pour l'app OmniChat (`POST /api/search`)

L'app OmniChat (frontend) garde son propre chat, mais délègue sa recherche
« normale » à ce backend (le chemin RP spécialisé de l'app reste local).

- Requête : `POST /api/search` avec `{ text, rewritten?, contextHint? }` et
  l'en-tête **`X-Tavily-Key`** (la clé Tavily de l'utilisateur, jamais journalisée).
- Réponse : `{ ok, text, sources, results, queries, meta, error }`. `text` est un
  bloc prêt à insérer dans un prompt, sans titre de niveau 1.
- **Pas de login** : la route est protégée par la clé de l'appelant et un limiteur
  (`middleware/searchGuard.js`) : 20 requêtes / minute / IP, et blocage 15 min après
  5 clés refusées par Tavily (anti test de clés volées).
- Si le backend est injoignable, endormi (offre gratuite Render) ou refuse la
  requête, l'app retombe sur son ancien moteur local : rien ne casse.

| Variable | Défaut | Rôle |
|---|---|---|
| `ALLOWED_ORIGINS` | vide | Doit contenir l'origine de l'app, ex. `https://stoornias-coder.github.io` (sans chemin). Sans ça, le navigateur bloque l'appel (CORS) et l'app utilise son repli. |
| `SEARCH_RATE_LIMIT_PER_MIN` | `20` | Requêtes par minute et par IP. |
| `SEARCH_MAX_INVALID_KEYS` | `5` | Clés refusées par Tavily avant blocage (15 min). |
| `TRUST_PROXY_HOPS` | `1` | Proxys de confiance devant l'app, pour lire l'IP réelle du client. |

Tests hors-ligne (Tavily simulé, aucune clé requise) :
`node --test "core/**/*.test.js" "interfaces/**/*.test.js"`.

## 10. Interface Web (`interfaces/web/server`)

API HTTP (Express) réutilisant exactement le même `core/` que Telegram —
aucune logique dupliquée. Authentification par Supabase Auth (email/mot de
passe), token JWT en `Authorization: Bearer <access_token>` sur toutes les
routes protégées.

| Route | Méthode | Description |
|---|---|---|
| `/health` | GET | ping, sans auth |
| `/api/auth/signup` | POST | `{ email, password }` → crée le compte + la ligne Core `users` |
| `/api/auth/login` | POST | `{ email, password }` → `{ user, session }` (access/refresh token) |
| `/api/auth/refresh` | POST | `{ refresh_token }` → nouvelle session |
| `/api/auth/me` | GET | utilisateur Core courant (auth requise) |
| `/api/sessions` | GET / POST | lister / créer une conversation |
| `/api/sessions/active` | GET | session active (comme Telegram) |
| `/api/sessions/:id` | GET | détail d'une conversation |
| `/api/sessions/:id/activate` | POST | bascule la session active |
| `/api/sessions/:id/messages` | GET | historique paginé |
| `/api/sessions/:id/messages` | POST | `{ text }` → exécute `core/engine.js`, renvoie `{ reply, character }` |
| `/api/characters` | GET / POST | lister / créer un personnage |
| `/api/characters/:id` | GET / PATCH | consulter / modifier un personnage |
| `/api/characters/:id/archive` | POST | archiver |

Variables `.env` nécessaires en plus de celles de Telegram :
`SUPABASE_ANON_KEY` (clé publique, pour signup/login uniquement — les
lectures/écritures de données continuent de passer par
`SUPABASE_SERVICE_ROLE_KEY`, comme côté Telegram), `PORT`,
`ALLOWED_ORIGINS` (CORS ; laisser vide tant que le frontend n'est pas
rebranché — voir section 12).

Le frontend `OmniChat` (Capacitor) n'est **pas encore reconnecté** à ce
serveur : c'est volontaire, prévu pour une étape ultérieure, une fois la
régression Telegram validée.

## 11. Déploiement en production (GitHub + Google Cloud Run)

Architecture cible : **GitHub** (code source) → **Cloud Run** (Core, conteneur
Docker, `interfaces/web/server`) → **Supabase** (données/auth). Telegram
passe en **mode webhook** en production (plus de polling), pointé sur ce
même serveur — un seul service à héberger, pas deux.

**A. Pousser le code sur GitHub**
```bash
git init
git add .
git commit -m "Migration Core/interfaces + webhook Telegram"
git branch -M main
git remote add origin https://github.com/<toi>/<ton-repo>.git
git push -u origin main
```
`.gitignore` exclut déjà `node_modules/` et `.env` (tes secrets ne partent jamais sur GitHub).

**B. Déployer sur Cloud Run**
Prérequis : compte Google Cloud (carte bancaire demandée à la vérification,
mais le quota "Always Free" de Cloud Run — 2M requêtes/mois — ne facture
rien tant que tu restes dedans), `gcloud` CLI installé, projet GCP créé.

```bash
gcloud run deploy omnichat-core \
  --source . \
  --region europe-west1 \
  --allow-unauthenticated \
  --set-env-vars NODE_ENV=production
```
`--source .` construit l'image à partir du `Dockerfile` du repo (pas besoin
de builder toi-même). Une URL publique du type
`https://omnichat-core-xxxxx.run.app` t'est donnée à la fin.

**C. Configurer les secrets**
Dans la console Cloud Run (ton service → *Edit & deploy new revision* →
*Variables & Secrets*), ajoute toutes les variables de `.env.example`
(les mêmes que celles déjà dans ton `.env` de dev, plus `TELEGRAM_WEBHOOK_SECRET`
— une valeur aléatoire longue, ex: `openssl rand -hex 24`). Ne mets jamais
ces valeurs dans le code ou dans GitHub.

**D. Activer le webhook Telegram**
Une fois déployé, en local (ou n'importe où avec `.env` rempli) :
```bash
PUBLIC_URL=https://omnichat-core-xxxxx.run.app npm run telegram:set-webhook
```
Telegram enverra désormais chaque message directement à ton service Cloud
Run. Pour repasser en polling (debug local), lance d'abord
`npm run telegram:delete-webhook`.

**E. Redéploiements suivants**
Soit tu relances `gcloud run deploy` à chaque changement, soit tu connectes
le repo GitHub à Cloud Run (Cloud Build trigger) pour un déploiement
automatique à chaque `git push` — configurable depuis la console Cloud Run
(*Continuously deploy from a repository*).

**Portabilité** : le `Dockerfile` est standard, sans rien de spécifique à
Cloud Run. Le jour où tu veux migrer (Railway, Fly, un VPS...), c'est le
même conteneur, aucune réécriture de `core/` ou `interfaces/`.

## 12. Ce qui est gratuit — et les limites à connaître

| Service | Gratuit ? | Limite / risque |
|---|---|---|
| Telegram Bot API | Oui, toujours | Aucune limite significative pour un usage perso |
| Supabase (Free) | Oui | Projet mis en pause après 7 jours d'inactivité, quotas d'API et de stockage |
| Groq | Oui | Rate limits par modèle, noms de modèles changent parfois (vérifier console.groq.com/docs/models) |
| Gemini (secours) | Oui | Quota gratuit quotidien limité selon le modèle (voir ai.google.dev) |
| Recherche web (Tavily) | Oui (free tier) | Quota mensuel limité selon le plan (voir tavily.com) |
| Cloud Run | Oui ("Always Free") | 2M requêtes/mois, très large pour un usage perso ; scale-to-zero (1-2s de réveil après inactivité) |

## 13. Ce qui n'est pas encore fait (volontairement, pour rester prototype)

- Pas de formulaire Telegram pour créer un personnage (passage par Supabase Table Editor).
- Pas de mémoire vectorielle (recherche par mots-clés uniquement) — migrable vers `pgvector` plus tard si besoin de plus de précision.
- Le frontend `OmniChat` n'est pas encore rebranché à `interfaces/web/server` (étape suivante de la migration).
- Pas encore de endpoint de réinitialisation de mot de passe côté Web (Supabase Auth le permet, non exposé ici pour l'instant).
- Pas encore de déploiement automatique GitHub → Cloud Run (à configurer manuellement une fois, voir section 11.E).

## 14. Checklist de régression Telegram (après la migration Core/interfaces)

À vérifier manuellement après un `npm start` avec un vrai token/compte de test :

- [ ] `/start` affiche le menu principal
- [ ] Un message texte normal déclenche l'indicateur "en train d'écrire…" puis une réponse (1 seul appel IA — vérifier les logs du provider)
- [ ] `/new` → "Discussion générale" crée bien une nouvelle session active
- [ ] `/new` → choix d'un personnage démarre une session liée à ce personnage, avec le bon prompt système
- [ ] `/sessions` liste, pagine, et "Reprendre cette conversation" réactive la bonne session
- [ ] `/characters` → créer un personnage (flux guidé champ par champ), le modifier, l'archiver
- [ ] Une information donnée dans un message est bien mémorisée puis rappelée dans un message suivant (scope session/character/global selon le cas)
- [ ] Un message qui demande une info d'actualité ou technique (ex: "météo à Paris aujourd'hui", "quels modèles Groq sont disponibles ?") déclenche un appel Tavily si `TAVILY_API_KEY` est renseignée (avec `WEB_SEARCH_DEBUG=1`, les logs montrent la requête, les domaines retenus/rejetés), et la réponse reste correcte même sans clé
- [ ] Couper le provider IA principal (mauvaise clé) déclenche bien le fallback vers `AI_PROVIDER_FALLBACK`
- [ ] Un message vide, ou une erreur interne provoquée volontairement, renvoie le message de fallback `"Attends, j'ai eu un petit bug 😅..."` sans crasher le process
