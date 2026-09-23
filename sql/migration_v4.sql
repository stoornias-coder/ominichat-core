-- ============================================================
-- Migration v4 — Cohérence des personnages en roleplay
-- Ajoute 3 colonnes nullable à "characters" pour distinguer
-- clairement le rôle du personnage, son comportement attendu, et
-- la situation de départ de la scène (faits non négociables).
-- Ne touche à aucune autre table. Aucune perte de données.
-- Les personnages existants restent valides : les 3 colonnes sont
-- nullable et le code applique un affichage/prompt dégradé propre
-- quand elles sont vides (voir promptBuilder.js).
-- À exécuter dans SQL Editor > New query > Run
-- ============================================================

alter table characters
  add column if not exists role text,
  add column if not exists behavior text,
  add column if not exists initial_situation text;

comment on column characters.role is
  'Rôle fonctionnel du personnage dans la scène (ex: "Chef mafieux et kidnappeur"). Optionnel.';
comment on column characters.behavior is
  'Contraintes de comportement concrètes (ex: "Il ne devient pas soudainement gentil sans raison"). Optionnel.';
comment on column characters.initial_situation is
  'Situation de départ de la scène, traitée comme un fait établi et non négociable par le prompt (ex: "Il vient de kidnapper l''utilisateur, retenu dans une cave"). Optionnel.';
