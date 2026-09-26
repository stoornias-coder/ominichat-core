# Préparation migration — ominichat-core → projet Supabase Omnichat

**Statut : préparation uniquement. Rien n'a été exécuté ni modifié.**
Fichier SQL associé : `sql/migration_omnichat_core.sql` (non exécuté).

---

## 1. Tables qui seront créées

| Table | Nom d'origine (ominichat-core) | Renommée ? | Pourquoi |
|---|---|---|---|
| `users` | `users` | Non | Aucune table `users` détectée côté frontend Omnichat (il utilise `profiles`) |
| `characters` | `characters` | Non | Aucune collision détectée |
| `universes` | `universes` | Non | Aucune collision détectée |
| `core_sessions` | `sessions` | **Oui** | Omnichat a déjà une table `sessions`, schéma inconnu, référencée une seule fois dans le code frontend (`deleteAccount()`) — trop risqué pour la réutiliser ou la recréer en `IF NOT EXISTS` |
| `core_messages` | `messages` | **Oui** | Omnichat a déjà une table `messages` (colonnes `conversation_id`, `user_id`, `role`, `content`, `model`) — schéma totalement différent et incompatible avec celui de Core (`session_id`, pas de `user_id`, `metadata jsonb`) |
| `memories` | `memories` | Non | Le frontend utilise `memory` (singulier) — nom différent, pas de collision |

---

## 2. Tables existantes ayant posé problème (collisions)

### `messages` (Omnichat) vs `messages` (Core)
- **Omnichat** : `conversation_id`, `user_id`, `role`, `content`, `model`, `created_at` — messages du chat général, liés à `conversations`.
- **Core** : `session_id`, `role`, `content`, `metadata jsonb`, `created_at` — messages liés à une session RP (`sessions`/`characters`/`universes`), pas de colonne `user_id` directe (l'utilisateur se déduit via `session_id → sessions.user_id`).
- Incompatibles : impossible de fusionner sans casser l'un des deux systèmes. → renommé `core_messages`.

### `sessions` (Omnichat) vs `sessions` (Core)
- **Omnichat** : une seule référence trouvée dans le code (`sb.from('sessions').delete().eq('user_id', currentUser.id)` dans `deleteAccount()`), aucune autre lecture/écriture repérée. Son schéma réel n'est pas visible depuis le code — elle pourrait être une table vide/orpheline (résidu d'une ancienne version du chat général, avant `conversations`), ou contenir des données actives non lues par ce fichier.
- **Décision prudente** : je ne suppose ni qu'elle est vide, ni qu'elle est compatible. → renommé `core_sessions`, sans y toucher.
- ⚠️ Point à vérifier manuellement avant toute exécution : ouvrir le Table Editor Supabase du projet Omnichat et regarder ce que contient réellement `sessions` (structure + nombre de lignes), pour savoir si c'est un résidu mort ou une table encore en usage ailleurs (backend externe, script, autre client que ce frontend).

### Tables sans collision confirmée, mais à vérifier quand même
`users`, `characters`, `universes`, `memories` n'apparaissent dans **aucun** appel `sb.from(...)` du frontend exploré (704 Ko de code JS inspecté). Cela signifie "non utilisées par ce fichier", pas forcément "n'existent pas dans le projet" — un test antérieur aurait pu créer l'une de ces tables sans que le frontend actuel s'en serve. Le script utilise `create table if not exists`, ce qui est sûr en soi (aucune donnée écrasée), mais si une de ces tables existe déjà avec un schéma différent, le backend Core lirait/écrirait des colonnes potentiellement absentes et échouerait au runtime — pas de perte de données, mais un dysfonctionnement à diagnostiquer. **Recommandation : vérifier ces 4 noms dans le Table Editor avant d'exécuter.**

---

## 3. Comment les utilisateurs OmniChat seront reliés au Core

C'est le point le plus important pour que `/api/characters` fonctionne sans double compte :

1. Le frontend continue de faire `sb.auth.signInWithPassword` / `signUp` contre le projet **Omnichat** (aucun changement).
2. Une fois `ominichat-core` basculé sur `SUPABASE_URL` = Omnichat (étape future, pas cette phase), le token envoyé en `Authorization: Bearer` sera validé par `db.supabase.auth.getUser(token)` **contre ce même projet** → succès garanti pour tout utilisateur déjà connecté côté frontend.
3. `requireAuth` (déjà existant, **inchangé**) appelle ensuite `getOrCreateUserByAuthId(authUser.id)` : cette fonction cherche une ligne `users.auth_user_id = <uid Omnichat>` ; si elle n'existe pas, elle la crée à la volée.
4. Résultat : **le premier appel** à une route protégée (ex: `/api/characters`) pour un utilisateur Omnichat existant crée automatiquement sa ligne `users` Core, avec le même `auth_user_id` que son compte Omnichat. Aucun nouveau compte Supabase Auth n'est créé — un seul système d'identité (`auth.users` du projet Omnichat) partagé par `profiles` (frontend) et `users` (Core).
5. **Aucune modification de code n'est nécessaire pour ce point** : la logique existe déjà dans `core/database/supabase.js`.

---

## 4. Ce qui reste dans "test telegram"

Intact et non touché par ce script :
- `users`, `characters`, `universes`, `sessions`, `messages`, `memories` du projet "test telegram", avec tout l'historique du bot Telegram (`telegram_user_id`).
- Les variables Render (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`) restent pointées vers "test telegram" tant que l'étape de bascule n'est pas décidée et exécutée séparément.
- Le bot Telegram continue de fonctionner exactement comme avant.

---

## 5. Ce qui n'est PAS migré dans cette phase (et pourquoi)

- **Aucune donnée** n'est copiée d'un projet à l'autre — ce script crée uniquement un schéma vide dans Omnichat.
- **`rp_data`** (Omnichat) n'est pas touché ni migré vers `characters` : les anciens personnages y restent, la fusion frontend actuelle (`mergeApiCharactersIntoRPChars`) continue de les afficher en fallback local, exactement comme aujourd'hui.
- **Telegram** (`test telegram`) n'est pas migré : ses données restent isolées, aucune passerelle n'est créée entre les deux projets à ce stade.
- **`conversations`, `messages`, `memory`, `profiles`, `user_settings`, `api_keys`** (Omnichat) ne sont touchés d'aucune façon — ni lus, ni modifiés, ni référencés par le nouveau schéma Core.

---

## 6. Ordre recommandé pour les étapes futures (non engagées ici)

1. **Vérification manuelle** (toi, dans le Table Editor Omnichat) : confirmer l'état réel de `sessions` et l'absence de `users`/`characters`/`universes`/`memories` préexistantes.
2. **Validation de ce script** par toi (contenu ci-dessus + fichier joint).
3. **Exécution du script** dans le SQL Editor du projet Omnichat (création du schéma Core vide — aucun impact utilisateur, aucune donnée déplacée).
4. **Test à blanc** : basculer temporairement un environnement de test (ou une seule variable Render en preview/staging si possible) vers Omnichat, et vérifier qu'un compte web existant peut bien appeler `/api/characters` sans erreur et sans doublon de compte.
5. **Décision sur `rp_data`** : migration progressive (à la connexion, par exemple) ou cohabitation prolongée — à discuter séparément, hors du périmètre technique de cette étape.
6. **Bascule effective des variables Render** (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`) vers Omnichat — seulement après validation de l'étape 4.
7. **Décision séparée sur Telegram** : migrer son historique vers Omnichat, le laisser sur "test telegram" indéfiniment, ou toute autre stratégie — hors périmètre de cette phase.

---

## 7. Garanties du script SQL fourni

- Aucun `DROP TABLE`, aucun `TRUNCATE`.
- Aucun `ALTER` sur une table existante du frontend Omnichat (`conversations`, `messages`, `memory`, `rp_data`, `profiles`, `user_settings`, `api_keys`, `sessions`).
- Toutes les créations en `IF NOT EXISTS` (sauf la fonction trigger `set_updated_at`, en `CREATE OR REPLACE` — à vérifier qu'aucune fonction de ce nom n'existe déjà avec un autre rôle).
- RLS activé sans policy sur les nouvelles tables Core → aucun accès via la clé `anon` déjà utilisée par le frontend, seul `service_role` (backend) y accède, comme dans le schéma d'origine de `ominichat-core`.
- **Non exécuté.** En attente de ta validation.
