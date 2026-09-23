-- ============================================================
-- Migration v3 — CRUD personnages depuis Telegram
-- Ajoute la possibilité d'archiver un personnage sans le supprimer.
-- Ne touche à aucune autre table. Aucune perte de données.
-- À exécuter dans SQL Editor > New query > Run
-- ============================================================

alter table characters
  add column if not exists is_archived boolean not null default false;

create index if not exists idx_characters_user_active
  on characters (user_id, is_archived);
