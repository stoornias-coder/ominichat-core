-- ============================================================
-- Migration v7 — Bibliothèque Personnages (web)
-- Ajoute 3 colonnes nullable à "characters" pour la nouvelle
-- bibliothèque Personnages web : fandom, type de personnage, et
-- message d'ouverture affiché au lancement d'un RP.
-- Purement additif : aucune colonne existante modifiée ou
-- supprimée, aucun changement de comportement pour les
-- personnages existants ni pour le bot Telegram (qui n'insère/ne
-- lit aucune des colonnes ajoutées ici).
--
-- IMPORTANT : "opening" est distinct de "initial_situation"
-- (ajouté en v4). "initial_situation" est injecté dans le prompt
-- système (voir promptBuilder.js, bloc "SITUATION DE DÉPART").
-- "opening" n'est PAS injecté dans le prompt : c'est uniquement le
-- message affiché au lancement du RP côté frontend
-- (voir applyRPChar() dans index.html). Ne pas fusionner ces deux
-- champs dans le code applicatif.
-- À exécuter dans SQL Editor > New query > Run
-- ============================================================

alter table characters
  add column if not exists fandom text,
  add column if not exists character_type text,
  add column if not exists opening text;

alter table characters
  drop constraint if exists characters_character_type_check;

alter table characters
  add constraint characters_character_type_check
  check (character_type is null or character_type in ('original', 'fanfic'));

comment on column characters.fandom is
  'Œuvre/univers de référence si le personnage est un fan fiction (ex: "Harry Potter"). Optionnel, libre.';
comment on column characters.character_type is
  'Type de personnage tel que choisi dans la bibliothèque web : "original" ou "fanfic". Nullable (personnages créés avant cette migration, ou créés hors web).';
comment on column characters.opening is
  'Message d''ouverture affiché au lancement d''un RP avec ce personnage. Distinct de "initial_situation" : jamais injecté dans le prompt système, purement un message de chat initial côté frontend.';
