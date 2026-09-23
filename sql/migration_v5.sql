-- ============================================================
-- Migration v5 — Fondations Core multi-interface (Telegram + Web)
-- Purement additive : aucune colonne existante modifiée ou
-- supprimée, aucun changement de comportement attendu côté bot
-- Telegram (il n'insère/ne lit aucune des colonnes ajoutées ici).
-- À exécuter dans SQL Editor > New query > Run
-- ============================================================

-- ---------- users : identité indépendante de l'interface ----------
-- Un même "utilisateur Core" peut exister via Telegram, via
-- Supabase Auth (Web), ou les deux à terme. telegram_user_id reste
-- nullable comme avant ; auth_user_id est nouveau et nullable.
alter table users
  add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;

alter table users
  drop constraint if exists users_has_identity;

alter table users
  add constraint users_has_identity
  check (telegram_user_id is not null or auth_user_id is not null);

create index if not exists idx_users_auth_user
  on users (auth_user_id) where auth_user_id is not null;

-- ---------- characters : champ récupéré de l'ancien OmniChat ----------
-- Dialogues d'exemple ({{char}}/{{user}}) : aide au style, optionnel,
-- exploité par le futur éditeur de personnage Web. N'apparaît dans
-- le prompt que s'il est renseigné (même logique que role/behavior/
-- initial_situation en v4).
alter table characters
  add column if not exists examples text;

-- ---------- messages : réservé pour pièces jointes futures ----------
-- Non exploité tant qu'aucune fonctionnalité (image, audio) n'en a
-- besoin. Nullable, ignoré par le code actuel.
alter table messages
  add column if not exists metadata jsonb;
