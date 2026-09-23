-- ============================================================
-- Migration v6 — Univers (mode "Maître du Jeu")
-- Ajoute une table "universes", distincte de "characters" : un
-- univers représente un monde/scénario narré par l'IA (qui peut
-- incarner plusieurs personnages non-joueurs), pas un personnage
-- unique. Purement additif : aucune colonne existante modifiée ou
-- supprimée, aucun changement de comportement pour les sessions
-- liées à un personnage ou sans personnage/univers.
-- À exécuter dans SQL Editor > New query > Run
-- ============================================================

-- ---------- universes ----------
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

alter table universes enable row level security;

-- ---------- sessions : rattachement optionnel à un univers ----------
-- Une session est liée SOIT à un personnage, SOIT à un univers, jamais
-- les deux (comme rpActiveId / rpActiveUniId côté frontend, qui sont
-- déjà mutuellement exclusifs).
alter table sessions
  add column if not exists universe_id uuid references universes(id) on delete set null;

create index if not exists idx_sessions_universe on sessions (universe_id) where universe_id is not null;

alter table sessions
  drop constraint if exists sessions_character_or_universe;

alter table sessions
  add constraint sessions_character_or_universe
  check (character_id is null or universe_id is null);
