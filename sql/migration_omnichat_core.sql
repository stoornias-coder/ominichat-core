-- ============================================================
-- Migration préparatoire — Schéma "Core" (ominichat-core) dans le
-- projet Supabase OMNICHAT (rfonkhqxoqekucutesvs.supabase.co)
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
--   - Aucune ALTER sur une table existante du frontend Omnichat.
--   - Toutes les créations sont IF NOT EXISTS.
--   - N'active RLS que sur les NOUVELLES tables Core, sans policy
--     (donc aucun accès via la clé anon déjà utilisée par le
--     frontend — seul service_role, utilisé par le backend, peut
--     lire/écrire, exactement comme le prévoyait le schéma
--     d'origine de ominichat-core).
-- ============================================================


-- ------------------------------------------------------------
-- 0. COLLISIONS DE NOMS DÉTECTÉES — DÉCISION
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
--     compatible : par prudence, traitée comme une collision réelle
--     à ne pas réutiliser ni recréer avec IF NOT EXISTS (qui serait
--     silencieusement ignoré si la table existe déjà avec un tout
--     autre schéma — le backend Core planterait alors en silence
--     sur des colonnes manquantes).
--
-- DÉCISION : les deux tables Core correspondantes sont créées sous
-- un nom distinct, préfixé "core_" :
--   sessions  → core_sessions
--   messages  → core_messages
--
-- Les autres tables Core ("users", "characters", "universes",
-- "memories") n'ont AUCUNE table de même nom détectée dans le code
-- frontend exploré (le frontend utilise "profiles", pas "users" ;
-- "memory" au singulier, pas "memories"). Elles sont donc créées
-- sous leur nom d'origine.
--
-- ⚠️ À vérifier avant exécution (impossible à confirmer depuis le
-- code seul) : ouvrir le Table Editor du projet Omnichat et
-- confirmer qu'aucune table "users", "characters", "universes",
-- "memories" n'existe déjà avec un schéma différent (résidu de test
-- par exemple). Si l'une d'elles existe, l'exécution de ce script
-- s'arrêtera au premier import de contrainte incompatible plutôt
-- que d'écraser quoi que ce soit — mais autant le savoir avant.
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 1. Extension requise (uuid_generate_v4)
-- ------------------------------------------------------------
create extension if not exists "uuid-ossp";


-- ------------------------------------------------------------
-- 2. Fonction trigger partagée (updated_at auto)
-- ------------------------------------------------------------
-- "create or replace" : si une fonction du même nom existe déjà
-- avec un comportement différent dans Omnichat, ceci l'écraserait.
-- Vérification recommandée avant exécution : aucune fonction
-- "set_updated_at" ne devrait déjà exister dans ce projet (à
-- confirmer côté Database > Functions).
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;


-- ------------------------------------------------------------
-- 3. users — identité Core
-- ------------------------------------------------------------
-- Compatibilité avec les comptes OmniChat existants (point 3 de la
-- demande) : cette table ne remplace PAS "profiles" et ne stocke
-- aucune donnée de profil. Son seul rôle est de faire le pont entre
-- l'UID Supabase Auth (auth.users.id, déjà utilisé par le frontend
-- pour "profiles.id", "conversations.user_id", etc.) et un id Core
-- interne (users.id) utilisé par characters/universes/core_sessions/
-- memories.
--
-- Comme le projet cible est désormais Omnichat, "auth.users(id)" ci-
-- dessous EST le même schéma auth que celui où le frontend crée déjà
-- ses comptes (sb.auth.signUp côté Omnichat). Aucune duplication de
-- compte : un utilisateur OmniChat existant aura simplement, la
-- première fois qu'il appelle une route protégée par requireAuth
-- (ex: /api/characters), une ligne "users" Core créée à la volée par
-- getOrCreateUserByAuthId(authUser.id) — fonction déjà présente dans
-- core/database/supabase.js, AUCUN changement de code nécessaire
-- pour ce point.
--
-- "telegram_user_id" est conservé nullable dans ce schéma (fidèle à
-- schema.sql d'origine) mais restera NULL pour toute ligne créée via
-- Omnichat : Telegram n'est pas migré dans cette phase (point 6).
create table if not exists users (
  id uuid primary key default uuid_generate_v4(),
  telegram_user_id bigint unique,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  username text,
  first_name text,
  active_session_id uuid, -- FK ajoutée plus bas, une fois core_sessions créée
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_has_identity check (telegram_user_id is not null or auth_user_id is not null)
);

create index if not exists idx_users_auth_user
  on users (auth_user_id) where auth_user_id is not null;

drop trigger if exists trg_users_updated_at on users;
create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();


-- ------------------------------------------------------------
-- 4. characters — bibliothèque de personnages (v7 complet)
-- ------------------------------------------------------------
-- Schéma cumulé schema.sql + v3 (is_archived) + v4 (role/behavior/
-- initial_situation) + v5 (examples) + v7 (fandom/character_type/
-- opening). Aucun champ existant supprimé (demande explicite).
create table if not exists characters (
  id uuid primary key default uuid_generate_v4(),
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

drop trigger if exists trg_characters_updated_at on characters;
create trigger trg_characters_updated_at
  before update on characters
  for each row execute function set_updated_at();


-- ------------------------------------------------------------
-- 5. universes — mode "Maître du Jeu" (v6)
-- ------------------------------------------------------------
create table if not exists universes (
  id uuid primary key default uuid_generate_v4(),
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

drop trigger if exists trg_universes_updated_at on universes;
create trigger trg_universes_updated_at
  before update on universes
  for each row execute function set_updated_at();


-- ------------------------------------------------------------
-- 6. core_sessions — anciennement "sessions" (renommée : collision)
-- ------------------------------------------------------------
-- Équivalent d'une conversation RP côté Core : liée SOIT à un
-- personnage, SOIT à un univers, jamais les deux (contrainte v6
-- conservée).
create table if not exists core_sessions (
  id uuid primary key default uuid_generate_v4(),
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

drop trigger if exists trg_core_sessions_updated_at on core_sessions;
create trigger trg_core_sessions_updated_at
  before update on core_sessions
  for each row execute function set_updated_at();

-- FK différée : active_session_id sur "users" pointe vers core_sessions.
alter table users
  drop constraint if exists fk_users_active_session;

alter table users
  add constraint fk_users_active_session
  foreign key (active_session_id) references core_sessions(id) on delete set null;


-- ------------------------------------------------------------
-- 7. core_messages — anciennement "messages" (renommée : collision)
-- ------------------------------------------------------------
create table if not exists core_messages (
  id uuid primary key default uuid_generate_v4(),
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
  id uuid primary key default uuid_generate_v4(),
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

drop trigger if exists trg_memories_updated_at on memories;
create trigger trg_memories_updated_at
  before update on memories
  for each row execute function set_updated_at();


-- ------------------------------------------------------------
-- 9. Row Level Security — nouvelles tables Core uniquement
-- ------------------------------------------------------------
-- Aucune policy définie : le backend ominichat-core utilise la clé
-- service_role (bypass RLS systématique). En l'absence de policy,
-- RLS activé = accès refusé par défaut pour les rôles anon/
-- authenticated, donc AUCUNE exposition nouvelle via la clé anon
-- déjà utilisée par le frontend. Comportement identique à celui
-- prévu dans schema.sql d'origine.
alter table users enable row level security;
alter table characters enable row level security;
alter table universes enable row level security;
alter table core_sessions enable row level security;
alter table core_messages enable row level security;
alter table memories enable row level security;

-- ============================================================
-- FIN — script non exécuté, en attente de validation.
-- ============================================================
