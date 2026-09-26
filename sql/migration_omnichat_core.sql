-- ============================================================
-- Migration préparatoire — Schéma "Core" (ominichat-core) dans le
-- projet Supabase OMNICHAT (rfonkhqxoqekucutesvs.supabase.co)
--
-- VERSION 2 — corrections ciblées demandées après relecture de la V1.
-- Voir section 0 pour le détail des changements V1 → V2.
--
-- STATUT : NON EXÉCUTÉE. Préparation uniquement, en attente de
-- validation. Ne pas lancer dans le SQL Editor Supabase avant
-- revue et accord explicite.
--
-- Objectif : permettre à terme à "ominichat-core" (backend Render)
-- d'utiliser le projet Omnichat comme source de vérité, avec les
-- MÊMES utilisateurs (auth.users) que ceux déjà utilisés par le
-- frontend OmniChat, sans toucher aux tables existantes du frontend
-- (conversations, messages, memory, rp_data, profiles,
-- user_settings, api_keys) ni au projet Supabase "test telegram".
--
-- Repris de : ominichat-core/sql/schema.sql + migrations v3 à v7,
-- adapté pour coexister avec le schéma déjà présent dans Omnichat.
--
-- GARANTIES DE CE SCRIPT :
--   - Aucun DROP TABLE, aucun TRUNCATE, aucune suppression de
--     données.
--   - Aucun DROP TRIGGER, aucun DROP CONSTRAINT.
--   - Aucune fonction existante écrasée (pas de CREATE OR REPLACE
--     sur un nom générique).
--   - Aucune ALTER sur une table "users" préexistante à structure
--     inconnue : le script s'arrête proprement (RAISE EXCEPTION,
--     tout est annulé) si "users" existe déjà.
--   - Aucune ALTER sur une table existante du frontend Omnichat.
--   - Toutes les créations de table/index sont IF NOT EXISTS.
--   - N'active RLS que sur les NOUVELLES tables Core, sans policy
--     (donc aucun accès via la clé anon déjà utilisée par le
--     frontend — seul service_role, utilisé par le backend, peut
--     lire/écrire, exactement comme le prévoyait le schéma
--     d'origine de ominichat-core).
--   - Script exécuté comme UNE SEULE transaction (begin/commit) :
--     en cas de conflit détecté, RIEN n'est appliqué, même les
--     étapes qui semblaient jusque-là sans risque.
-- ============================================================


-- ------------------------------------------------------------
-- 0. CHANGEMENTS V1 → V2 (corrections demandées)
-- ------------------------------------------------------------
-- 1. Fonction trigger renommée "set_updated_at" → "core_set_updated_at",
--    et créée uniquement si elle n'existe pas déjà (plus de
--    CREATE OR REPLACE : aucun risque d'écraser une fonction
--    Omnichat existante du même nom).
-- 2. Plus aucun DROP TRIGGER : chaque trigger est créé via un bloc
--    DO conditionnel (vérifie pg_trigger avant de créer), donc
--    idempotent sans jamais supprimer un trigger existant.
-- 3. "users" : le bloc ALTER (drop constraint + add constraint)
--    trop agressif a été supprimé. La création de "users" est
--    désormais conditionnelle : si la table n'existe pas, elle est
--    créée avec sa structure complète (FK active_session_id ajoutée
--    ensuite, sur la table que CE script vient lui-même de créer) ;
--    si elle existe déjà, le script lève une exception explicite et
--    s'arrête — toute la transaction est annulée, aucune table
--    n'est créée, aucune donnée n'est touchée.
-- 4. Extension "uuid-ossp" retirée : gen_random_uuid() est intégré
--    nativement à PostgreSQL depuis la version 13 (aucune extension
--    requise), et tous les projets Supabase actuels tournent sur une
--    version ≥ 13. Remplace donc uuid_generate_v4() partout — solution
--    plus standard, sans dépendance supplémentaire. Voir section 5
--    du rapport pour le point de vérification associé.
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 0bis. COLLISIONS DE NOMS DÉTECTÉES — DÉCISION (inchangé depuis V1)
-- ------------------------------------------------------------
-- Le projet Omnichat possède déjà, côté frontend, deux tables dont
-- le nom entrerait en conflit avec le schéma Core d'origine :
--
--   • "messages"  (Omnichat) : conversation_id, user_id, role,
--     content, model, created_at — chat général, sans lien avec
--     "sessions"/"characters" Core.
--   • "sessions"  (Omnichat) : référencée UNE seule fois dans le
--     code frontend (deleteAccount(), simple .delete() par
--     user_id), sans schéma visible côté code. Impossible de
--     garantir qu'elle est vide, inutilisée, ou de structure
--     compatible.
--
-- DÉCISION (inchangée) : tables Core renommées avec préfixe "core_" :
--   sessions  → core_sessions
--   messages  → core_messages
--
-- "characters" et "universes" et "memories" n'ont AUCUNE table de
-- même nom détectée dans le code frontend exploré. "users" est
-- traité différemment en V2 (voir section 3) : vérifié explicitement
-- à l'exécution plutôt que simplement supposé absent.
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- Toute la migration s'exécute comme une seule transaction : si un
-- conflit est détecté (ex: "users" déjà présente), RAISE EXCEPTION
-- annule tout ce qui a été fait dans ce script jusque-là.
-- ------------------------------------------------------------
begin;


-- ------------------------------------------------------------
-- 1. Fonction trigger dédiée Core — jamais de CREATE OR REPLACE
-- ------------------------------------------------------------
-- Nom dédié ("core_set_updated_at", pas "set_updated_at") pour
-- exclure toute collision avec une fonction Omnichat existante.
-- Créée seulement si elle n'existe pas déjà sous ce nom précis —
-- si par extraordinaire "core_set_updated_at" existait déjà, ce
-- script la laisse intacte (pas d'écrasement, pas d'erreur non plus :
-- elle est simplement réutilisée telle quelle).
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
-- Compatibilité avec les comptes OmniChat existants : cette table ne
-- remplace PAS "profiles" et ne stocke aucune donnée de profil. Son
-- seul rôle est de faire le pont entre l'UID Supabase Auth
-- (auth.users.id, déjà utilisé par le frontend pour "profiles.id",
-- "conversations.user_id", etc.) et un id Core interne (users.id)
-- utilisé par characters/universes/core_sessions/memories.
--
-- Comme le projet cible est désormais Omnichat, "auth.users(id)" ci-
-- dessous EST le même schéma auth que celui où le frontend crée déjà
-- ses comptes (sb.auth.signUp côté Omnichat). Un utilisateur
-- OmniChat existant aura simplement, au premier appel à une route
-- protégée par requireAuth, une ligne "users" Core créée à la volée
-- par getOrCreateUserByAuthId(authUser.id) — fonction déjà présente
-- dans core/database/supabase.js, aucun changement de code requis.
--
-- SI "users" EXISTE DÉJÀ (structure inconnue, résidu éventuel d'un
-- test antérieur) : ce script NE LA TOUCHE PAS. Il lève une
-- exception explicite et arrête toute la migration (rien n'est créé,
-- grâce au begin/commit englobant) plutôt que de risquer une ALTER
-- silencieuse sur une table dont on ne connaît pas le contenu réel.
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
-- 3. characters — bibliothèque de personnages (v7 complet)
-- ------------------------------------------------------------
-- Schéma cumulé schema.sql + v3 (is_archived) + v4 (role/behavior/
-- initial_situation) + v5 (examples) + v7 (fandom/character_type/
-- opening). Aucun champ existant supprimé.
create table if not exists characters (
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
  constraint characters_character_type_check
    check (character_type is null or character_type in ('original', 'fanfic'))
);

comment on column characters.fandom is
  'Œuvre/univers de référence si le personnage est un fan fiction (ex: "Harry Potter"). Optionnel, libre.';
comment on column characters.character_type is
  'Type de personnage : "original" ou "fanfic". Nullable.';
comment on column characters.opening is
  'Message d''ouverture affiché au lancement d''un RP. Distinct de "initial_situation" : jamais injecté dans le prompt système.';
comment on column characters.role is
  'Rôle fonctionnel du personnage dans la scène. Optionnel.';
comment on column characters.behavior is
  'Contraintes de comportement concrètes. Optionnel.';
comment on column characters.initial_situation is
  'Situation de départ de la scène, traitée comme un fait établi et non négociable par le prompt.';

create index if not exists idx_characters_user on characters (user_id);
create index if not exists idx_characters_user_active on characters (user_id, is_archived);

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_characters_updated_at' and tgrelid = 'characters'::regclass
  ) then
    create trigger trg_characters_updated_at
      before update on characters
      for each row execute function core_set_updated_at();
  end if;
end;
$$;


-- ------------------------------------------------------------
-- 4. universes — mode "Maître du Jeu" (v6)
-- ------------------------------------------------------------
create table if not exists universes (
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

create index if not exists idx_universes_user on universes (user_id);
create index if not exists idx_universes_user_active on universes (user_id, is_archived);

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_universes_updated_at' and tgrelid = 'universes'::regclass
  ) then
    create trigger trg_universes_updated_at
      before update on universes
      for each row execute function core_set_updated_at();
  end if;
end;
$$;


-- ------------------------------------------------------------
-- 5. core_sessions — anciennement "sessions" (renommée : collision)
-- ------------------------------------------------------------
-- Équivalent d'une conversation RP côté Core : liée SOIT à un
-- personnage, SOIT à un univers, jamais les deux (contrainte v6
-- conservée).
create table if not exists core_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  character_id uuid references characters(id) on delete set null,
  universe_id uuid references universes(id) on delete set null,
  title text not null default 'Nouvelle conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint core_sessions_character_or_universe
    check (character_id is null or universe_id is null)
);

create index if not exists idx_core_sessions_user on core_sessions (user_id, updated_at desc);
create index if not exists idx_core_sessions_universe on core_sessions (universe_id) where universe_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_core_sessions_updated_at' and tgrelid = 'core_sessions'::regclass
  ) then
    create trigger trg_core_sessions_updated_at
      before update on core_sessions
      for each row execute function core_set_updated_at();
  end if;
end;
$$;


-- ------------------------------------------------------------
-- 6. FK différée : users.active_session_id → core_sessions(id)
-- ------------------------------------------------------------
-- Non agressif : "users" a été créée par CE script (section 2) dans
-- CETTE même transaction — si on est arrivé jusqu'ici, la table est
-- garantie fraîche et cette contrainte ne peut pas déjà exister.
-- Pas de DROP CONSTRAINT IF EXISTS nécessaire.
alter table users
  add constraint fk_users_active_session
  foreign key (active_session_id) references core_sessions(id) on delete set null;


-- ------------------------------------------------------------
-- 7. core_messages — anciennement "messages" (renommée : collision)
-- ------------------------------------------------------------
create table if not exists core_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references core_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_core_messages_session_created
  on core_messages (session_id, created_at desc);


-- ------------------------------------------------------------
-- 8. memories — mémoire Core (pas de collision avec "memory" Omnichat)
-- ------------------------------------------------------------
-- scope = 'global'    -> vrai pour l'utilisateur, toutes conversations
-- scope = 'session'   -> vrai seulement dans cette session précise
-- scope = 'character' -> vrai pour ce personnage, dans toutes les sessions
create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  scope text not null check (scope in ('global', 'session', 'character')),
  session_id uuid references core_sessions(id) on delete cascade,
  character_id uuid references characters(id) on delete cascade,
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

create index if not exists idx_memories_user_scope
  on memories (user_id, scope, importance desc, created_at desc);
create index if not exists idx_memories_session
  on memories (session_id) where session_id is not null;
create index if not exists idx_memories_character
  on memories (character_id) where character_id is not null;
create index if not exists idx_memories_content_trgm
  on memories using gin (to_tsvector('french', content));

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_memories_updated_at' and tgrelid = 'memories'::regclass
  ) then
    create trigger trg_memories_updated_at
      before update on memories
      for each row execute function core_set_updated_at();
  end if;
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
alter table users enable row level security;
alter table characters enable row level security;
alter table universes enable row level security;
alter table core_sessions enable row level security;
alter table core_messages enable row level security;
alter table memories enable row level security;


commit;

-- ============================================================
-- FIN — script non exécuté, en attente de validation.
-- ============================================================
