-- ============================================================
-- Schéma Supabase v2 — Moteur généraliste multi-personnages
-- Remplace complètement l'ancien schema.sql.
-- ⚠️ Ce script supprime les anciennes tables (character, messages
-- liés directement à user, memories sans scope). Les données de
-- test précédentes seront perdues.
-- À exécuter dans SQL Editor > New query > Run
-- ============================================================

create extension if not exists "uuid-ossp";

-- ---------- reset des anciennes tables (v1) ----------
drop table if exists memories cascade;
drop table if exists messages cascade;
drop table if exists character cascade;
-- "users" est conservée si elle existe déjà (structure identique en v2)

-- ---------- users ----------
create table if not exists users (
  id uuid primary key default uuid_generate_v4(),
  telegram_user_id bigint unique,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  username text,
  first_name text,
  active_session_id uuid, -- session actuellement sélectionnée (FK ajoutée plus bas)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_has_identity check (telegram_user_id is not null or auth_user_id is not null)
);

create index if not exists idx_users_auth_user
  on users (auth_user_id) where auth_user_id is not null;

-- ---------- characters ----------
-- Un personnage est une configuration réutilisable, pas un bot séparé.
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_characters_user on characters (user_id);

-- ---------- sessions ----------
-- Équivalent d'une "conversation" façon ChatGPT. Peut être générale
-- (character_id null) ou liée à un personnage précis.
create table if not exists sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users(id) on delete cascade,
  character_id uuid references characters(id) on delete set null,
  title text not null default 'Nouvelle conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sessions_user on sessions (user_id, updated_at desc);

alter table users
  add constraint fk_users_active_session
  foreign key (active_session_id) references sessions(id) on delete set null;

-- ---------- messages ----------
-- Rattachés à une session, pas directement à l'utilisateur : chaque
-- conversation garde son historique indépendant.
create table if not exists messages (
  id uuid primary key default uuid_generate_v4(),
  session_id uuid not null references sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_session_created
  on messages (session_id, created_at desc);

-- ---------- memories ----------
-- scope = 'global'    -> vrai pour l'utilisateur, toutes conversations
-- scope = 'session'   -> vrai seulement dans cette session précise
-- scope = 'character' -> vrai pour ce personnage, dans toutes les sessions où il apparaît
create table if not exists memories (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users(id) on delete cascade,
  scope text not null check (scope in ('global', 'session', 'character')),
  session_id uuid references sessions(id) on delete cascade,
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

-- ---------- trigger updated_at ----------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_users_updated_at on users;
create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();

drop trigger if exists trg_characters_updated_at on characters;
create trigger trg_characters_updated_at
  before update on characters
  for each row execute function set_updated_at();

drop trigger if exists trg_sessions_updated_at on sessions;
create trigger trg_sessions_updated_at
  before update on sessions
  for each row execute function set_updated_at();

drop trigger if exists trg_memories_updated_at on memories;
create trigger trg_memories_updated_at
  before update on memories
  for each row execute function set_updated_at();

-- ---------- Row Level Security ----------
-- Le backend utilise la clé service_role (bypass RLS) : aucun accès anonyme.
alter table users enable row level security;
alter table characters enable row level security;
alter table sessions enable row level security;
alter table messages enable row level security;
alter table memories enable row level security;
