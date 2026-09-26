-- ============================================================
-- Migration préparatoire — Schéma "Core" (ominichat-core) dans le
-- projet Supabase OMNICHAT (rfonkhqxoqekucutesvs.supabase.co)
--
-- VERSION 3 — voir section 0 pour le détail des changements V2 → V3.
--
-- STATUT : NON EXÉCUTÉE. Préparation uniquement, en attente de
-- validation. Ne pas lancer dans le SQL Editor Supabase avant
-- revue et accord explicite.
--
-- Objectif : permettre à terme à "ominichat-core" (backend Render)
-- d'utiliser le projet Omnichat comme source de vérité, avec les
-- MÊMES utilisateurs (auth.users) que ceux déjà utilisés par le
-- frontend OmniChat, SANS TOUCHER aux tables existantes du frontend
-- (api_keys, characters, conversation_summary, conversations, memory,
-- messages, profiles, rp_data, universes, user_settings) ni au projet
-- Supabase "test telegram".
--
-- Repris de : ominichat-core/sql/schema.sql + migrations v3 à v7,
-- adapté pour coexister avec le schéma déjà présent dans Omnichat.
-- Ces fichiers historiques ("test telegram") ne sont pas modifiés
-- par ce script : V3 est un script Omnichat autonome.
--
-- GARANTIES DE CE SCRIPT :
--   - Aucun DROP TABLE, aucun TRUNCATE, aucune suppression de
--     données.
--   - Aucun DROP TRIGGER, aucun DROP CONSTRAINT.
--   - Aucune fonction existante écrasée (pas de CREATE OR REPLACE
--     sur un nom générique, "set_updated_at()" n'est jamais touchée).
--   - Aucune modification des tables historiques Omnichat, y compris
--     "characters" et "universes" (existantes, vides, RLS/policies/
--     triggers laissés strictement intacts — ce script ne les
--     référence nulle part).
--   - Aucune ALTER sur une table préexistante à structure inconnue :
--     pour CHAQUE table Core ("users", "core_characters",
--     "core_universes", "core_sessions", "core_messages", "memories"),
--     le script vérifie explicitement son absence avant de la créer.
--     Si une table Core existe déjà (même vide, même partiellement
--     migrée), la migration s'arrête (RAISE EXCEPTION, transaction
--     annulée) plutôt que de tenter une modification silencieuse.
--   - Toutes les créations d'index/trigger restent IF NOT EXISTS /
--     conditionnelles, par cohérence de style avec V2 (même si, la
--     table étant garantie fraîche, ce cas ne peut pas se produire
--     dans ce script).
--   - N'active RLS que sur les NOUVELLES tables Core, sans policy
--     (donc aucun accès via la clé anon déjà utilisée par le
--     frontend — seul service_role, utilisé par le backend, peut
--     lire/écrire).
--   - Script exécuté comme UNE SEULE transaction (begin/commit) :
--     en cas de conflit détecté, RIEN n'est appliqué, même les
--     étapes qui semblaient jusque-là sans risque.
-- ============================================================


-- ------------------------------------------------------------
-- 0. CHANGEMENTS V2 → V3
-- ------------------------------------------------------------
-- 1. "characters" et "universes" sont renommées en "core_characters"
--    et "core_universes". Raison : l'audit lecture seule du projet
--    Supabase Omnichat a révélé que ces deux tables existent DÉJÀ
--    dans Omnichat (RLS + policies + triggers actifs, 0 ligne,
--    schéma différent de celui attendu par Core : FK vers
--    auth.users, colonnes "type"/"instructions" au lieu de
--    "character_type"/"additional_instructions", 11 colonnes
--    manquantes pour characters, 8 pour universes). Non détectable
--    depuis le seul code Core, ce n'était pas visible en V2.
-- 2. Toutes les créations de table Core passent désormais par un
--    garde-fou explicite "abort si déjà existante" (comme "users"
--    en V2), et non plus par un simple "create table if not exists"
--    silencieux — y compris pour "core_characters", "core_universes",
--    "core_sessions", "core_messages" et "memories". Objectif :
--    ne jamais risquer d'ALTER implicite sur une table Core
--    partiellement créée par un essai précédent.
-- 3. Les FK internes de "core_sessions" et "memories" qui pointaient
--    vers "characters(id)"/"universes(id)" pointent maintenant vers
--    "core_characters(id)"/"core_universes(id)".
-- 4. RLS (section 9) activé sur "core_characters"/"core_universes"
--    au lieu de "characters"/"universes".
-- Tout le reste (fonction trigger dédiée, table "users", table
-- "core_sessions", table "core_messages", table "memories", absence
-- de policies) reprend exactement les décisions déjà validées en V2.
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 0bis. COLLISIONS DE NOMS DÉTECTÉES — DÉCISION FINALE
-- ------------------------------------------------------------
-- Le projet Omnichat possède déjà, côté frontend, quatre tables dont
-- le nom entrerait en conflit avec le schéma Core d'origine :
--
--   • "messages"    (Omnichat, 1 416 lignes, active) : chat général,
--     sans lien avec "sessions"/"characters" Core.
--   • "sessions"    (Omnichat) : référencée une seule fois dans le
--     frontend (deleteAccount()), sans schéma vérifiable.
--   • "characters"  (Omnichat, 0 ligne) : schéma différent, RLS +
--     policies + triggers actifs, FK vers auth.users.
--   • "universes"   (Omnichat, 0 ligne) : idem.
--
-- DÉCISION FINALE : les 4 tables Core correspondantes sont préfixées
-- "core_" :
--   sessions   → core_sessions
--   messages   → core_messages
--   characters → core_characters
--   universes  → core_universes
--
-- Les tables Omnichat "characters", "universes", "sessions" (si elle
-- existe) et "messages" restent intactes et ne sont TOUCHÉES NULLE
-- PART dans ce script (aucune lecture, aucune écriture, aucun ALTER).
--
-- "memories" et "users" n'ont aucune collision détectée dans le code
-- frontend exploré ni dans le schéma Omnichat actuel ; "users" reste
-- néanmoins vérifiée explicitement à l'exécution (voir section 2).
-- ------------------------------------------------------------


begin;


-- ------------------------------------------------------------
-- 1. Fonction trigger dédiée Core — jamais de CREATE OR REPLACE
-- ------------------------------------------------------------
-- Nom dédié ("core_set_updated_at", pas "set_updated_at") pour
-- exclure toute collision avec "set_updated_at()", déjà utilisée par
-- les triggers de "characters" et "universes" (tables Omnichat
-- existantes, confirmé par l'audit). Créée seulement si elle
-- n'existe pas déjà sous ce nom précis.
do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'core_set_updated_at' and n.nspname = 'public'
  ) then
    create function core_set_updated_at()
    returns trigger as $body$
    begin
      new.updated_at = now();
      return new;
    end;
    $body$ language plpgsql;
  end if;
end;
$$;


-- ------------------------------------------------------------
-- 2. users — identité Core (création CONDITIONNELLE, jamais d'ALTER
--    sur une table préexistante à structure inconnue)
-- ------------------------------------------------------------
-- Cette table ne remplace PAS "profiles" et ne stocke aucune donnée
-- de profil. Son seul rôle est de faire le pont entre l'UID Supabase
-- Auth (auth.users.id, déjà utilisé par le frontend pour
-- "profiles.id", "conversations.user_id", etc.) et un id Core
-- interne (users.id) utilisé par core_characters/core_universes/
-- core_sessions/memories.
--
-- Un utilisateur OmniChat existant aura simplement, au premier appel
-- à une route protégée par requireAuth, une ligne "users" Core créée
-- à la volée par getOrCreateUserByAuthId(authUser.id) — fonction déjà
-- présente dans core/database/supabase.js, aucun changement requis.
--
-- SI "users" EXISTE DÉJÀ (structure inconnue) : ce script NE LA
-- TOUCHE PAS. Il lève une exception explicite et arrête toute la
-- migration (rien n'est créé, grâce au begin/commit englobant).
do $$
begin
  if to_regclass('public.users') is not null then
    raise exception
      'CONFLIT: une table "users" existe déjà dans le schéma public du projet Omnichat, avec une structure non vérifiée par ce script. Migration arrêtée avant toute création/modification (transaction annulée). Vérifiez manuellement son contenu et sa structure (Table Editor > users) avant de relancer cette migration.';
  end if;

  create table users (
    id uuid primary key default gen_random_uuid(),
    telegram_user_id bigint unique,
    auth_user_id uuid unique references auth.users(id) on delete set null,
    username text,
    first_name text,
    active_session_id uuid, -- FK ajoutée en section 6, une fois core_sessions créée
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint users_has_identity check (telegram_user_id is not null or auth_user_id is not null)
  );

  create index idx_users_auth_user
    on users (auth_user_id) where auth_user_id is not null;

  -- Table garantie fraîchement créée ci-dessus dans ce même bloc :
  -- le trigger ne peut pas déjà exister, création directe sûre.
  create trigger trg_users_updated_at
    before update on users
    for each row execute function core_set_updated_at();
end;
$$;


-- ------------------------------------------------------------
-- 3. core_characters — anciennement "characters" (renommée : collision
--    avec la table Omnichat existante, RLS/policies/triggers actifs)
-- ------------------------------------------------------------
-- Schéma cumulé schema.sql + v3 (is_archived) + v4 (role/behavior/
-- initial_situation) + v5 (examples) + v7 (fandom/character_type/
-- opening), repris à l'identique de V2, uniquement renommé.
-- SI "core_characters" EXISTE DÉJÀ : abort explicite plutôt qu'un
-- "if not exists" silencieux (nouveau garde-fou V3, voir section 0).
do $$
begin
  if to_regclass('public.core_characters') is not null then
    raise exception
      'CONFLIT: une table "core_characters" existe déjà dans le schéma public du projet Omnichat, avec une structure non vérifiée par ce script. Migration arrêtée (transaction annulée). Vérifiez manuellement son contenu et sa structure avant de relancer cette migration.';
  end if;

  create table core_characters (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    name text not null,
    avatar_url text,
    age text,
    description text,
    role text,
    behavior text,
    personality text,
    backstory text,
    initial_situation text,
    examples text,
    speaking_style text,
    relationship_default text,
    rules text,
    additional_instructions text,
    is_public boolean not null default false,
    is_archived boolean not null default false,
    fandom text,
    character_type text,
    opening text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint core_characters_character_type_check
      check (character_type is null or character_type in ('original', 'fanfic'))
  );

  comment on column core_characters.fandom is
    'Œuvre/univers de référence si le personnage est un fan fiction (ex: "Harry Potter"). Optionnel, libre.';
  comment on column core_characters.character_type is
    'Type de personnage : "original" ou "fanfic". Nullable.';
  comment on column core_characters.opening is
    'Message d''ouverture affiché au lancement d''un RP. Distinct de "initial_situation" : jamais injecté dans le prompt système.';
  comment on column core_characters.role is
    'Rôle fonctionnel du personnage dans la scène. Optionnel.';
  comment on column core_characters.behavior is
    'Contraintes de comportement concrètes. Optionnel.';
  comment on column core_characters.initial_situation is
    'Situation de départ de la scène, traitée comme un fait établi et non négociable par le prompt.';

  create index idx_core_characters_user on core_characters (user_id);
  create index idx_core_characters_user_active on core_characters (user_id, is_archived);

  -- Table garantie fraîchement créée ci-dessus : trigger direct sûr.
  create trigger trg_core_characters_updated_at
    before update on core_characters
    for each row execute function core_set_updated_at();
end;
$$;


-- ------------------------------------------------------------
-- 4. core_universes — anciennement "universes" (renommée : même
--    raison que core_characters)
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.core_universes') is not null then
    raise exception
      'CONFLIT: une table "core_universes" existe déjà dans le schéma public du projet Omnichat, avec une structure non vérifiée par ce script. Migration arrêtée (transaction annulée). Vérifiez manuellement son contenu et sa structure avant de relancer cette migration.';
  end if;

  create table core_universes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    name text not null,
    avatar_url text,
    description text,
    personality text,
    backstory text,
    initial_situation text,
    opening text,
    rules text,
    additional_instructions text,
    is_public boolean not null default false,
    is_archived boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create index idx_core_universes_user on core_universes (user_id);
  create index idx_core_universes_user_active on core_universes (user_id, is_archived);

  create trigger trg_core_universes_updated_at
    before update on core_universes
    for each row execute function core_set_updated_at();
end;
$$;


-- ------------------------------------------------------------
-- 5. core_sessions — anciennement "sessions" (renommée : collision,
--    décision inchangée depuis V2)
-- ------------------------------------------------------------
-- Équivalent d'une conversation RP côté Core : liée SOIT à un
-- personnage, SOIT à un univers, jamais les deux (contrainte v6
-- conservée). FK vers core_characters/core_universes (et non plus
-- characters/universes) — seul changement de fond vs V2.
do $$
begin
  if to_regclass('public.core_sessions') is not null then
    raise exception
      'CONFLIT: une table "core_sessions" existe déjà dans le schéma public du projet Omnichat, avec une structure non vérifiée par ce script. Migration arrêtée (transaction annulée). Vérifiez manuellement son contenu et sa structure avant de relancer cette migration.';
  end if;

  create table core_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    character_id uuid references core_characters(id) on delete set null,
    universe_id uuid references core_universes(id) on delete set null,
    title text not null default 'Nouvelle conversation',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint core_sessions_character_or_universe
      check (character_id is null or universe_id is null)
  );

  create index idx_core_sessions_user on core_sessions (user_id, updated_at desc);
  create index idx_core_sessions_universe on core_sessions (universe_id) where universe_id is not null;

  create trigger trg_core_sessions_updated_at
    before update on core_sessions
    for each row execute function core_set_updated_at();
end;
$$;


-- ------------------------------------------------------------
-- 6. FK différée : users.active_session_id → core_sessions(id)
-- ------------------------------------------------------------
-- Non agressif : "users" a été créée par CE script (section 2) dans
-- CETTE même transaction — si on est arrivé jusqu'ici, la table est
-- garantie fraîche et cette contrainte ne peut pas déjà exister.
alter table users
  add constraint fk_users_active_session
  foreign key (active_session_id) references core_sessions(id) on delete set null;


-- ------------------------------------------------------------
-- 7. core_messages — anciennement "messages" (renommée : collision
--    avec la table Omnichat active à 1 416 lignes, décision inchangée
--    depuis V2)
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.core_messages') is not null then
    raise exception
      'CONFLIT: une table "core_messages" existe déjà dans le schéma public du projet Omnichat, avec une structure non vérifiée par ce script. Migration arrêtée (transaction annulée). Vérifiez manuellement son contenu et sa structure avant de relancer cette migration.';
  end if;

  create table core_messages (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references core_sessions(id) on delete cascade,
    role text not null check (role in ('user', 'assistant')),
    content text not null,
    metadata jsonb,
    created_at timestamptz not null default now()
  );

  create index idx_core_messages_session_created
    on core_messages (session_id, created_at desc);
end;
$$;


-- ------------------------------------------------------------
-- 8. memories — mémoire Core (pas de collision avec "memory" Omnichat)
-- ------------------------------------------------------------
-- scope = 'global'    -> vrai pour l'utilisateur, toutes conversations
-- scope = 'session'   -> vrai seulement dans cette session précise
-- scope = 'character' -> vrai pour ce personnage, dans toutes les sessions
-- FK character_id vers core_characters (et non plus characters) —
-- seul changement de fond vs V2.
do $$
begin
  if to_regclass('public.memories') is not null then
    raise exception
      'CONFLIT: une table "memories" existe déjà dans le schéma public du projet Omnichat, avec une structure non vérifiée par ce script. Migration arrêtée (transaction annulée). Vérifiez manuellement son contenu et sa structure avant de relancer cette migration.';
  end if;

  create table memories (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    scope text not null check (scope in ('global', 'session', 'character')),
    session_id uuid references core_sessions(id) on delete cascade,
    character_id uuid references core_characters(id) on delete cascade,
    category text not null check (
      category in ('fact', 'preference', 'relationship', 'event', 'personal', 'important')
    ),
    content text not null,
    importance smallint not null default 5 check (importance between 1 and 10),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint scope_consistency check (
      (scope = 'global' and session_id is null and character_id is null) or
      (scope = 'session' and session_id is not null) or
      (scope = 'character' and character_id is not null)
    )
  );

  create index idx_memories_user_scope
    on memories (user_id, scope, importance desc, created_at desc);
  create index idx_memories_session
    on memories (session_id) where session_id is not null;
  create index idx_memories_character
    on memories (character_id) where character_id is not null;
  create index idx_memories_content_trgm
    on memories using gin (to_tsvector('french', content));

  create trigger trg_memories_updated_at
    before update on memories
    for each row execute function core_set_updated_at();
end;
$$;


-- ------------------------------------------------------------
-- 9. Row Level Security — nouvelles tables Core uniquement
-- ------------------------------------------------------------
-- Aucune policy définie : le backend ominichat-core utilise la clé
-- service_role (bypass RLS systématique). En l'absence de policy,
-- RLS activé = accès refusé par défaut pour les rôles anon/
-- authenticated, donc AUCUNE exposition nouvelle via la clé anon
-- déjà utilisée par le frontend.
--
-- Les tables Omnichat "characters" et "universes" (existantes, RLS +
-- policies déjà en place, auth.uid() = user_id) ne sont PAS listées
-- ici : elles ne sont ni créées ni modifiées par ce script.
alter table users enable row level security;
alter table core_characters enable row level security;
alter table core_universes enable row level security;
alter table core_sessions enable row level security;
alter table core_messages enable row level security;
alter table memories enable row level security;


commit;

-- ============================================================
-- FIN — script non exécuté, en attente de validation.
-- ============================================================
