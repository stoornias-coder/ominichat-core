const express = require('express');
const db = require('../../../../core/database/supabase');
const characterManager = require('../../../../core/character/characterManager');
const logger = require('../../../../core/utils/logger');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const EDITABLE_FIELDS = [
  'name', 'age', 'description', 'role', 'personality', 'behavior',
  'backstory', 'speaking_style', 'relationship_default', 'initial_situation',
  'rules', 'additional_instructions', 'examples', 'avatar_url', 'is_public',
  // Ajoutés en migration v7 pour la bibliothèque Personnages (web).
  // "opening" est distinct de "initial_situation" (voir migration_v7.sql) :
  // il n'est PAS lu par promptBuilder.js, seulement par le frontend au
  // lancement d'un RP.
  'fandom', 'character_type', 'opening',
];

function pickEditableFields(body) {
  const fields = {};
  for (const key of EDITABLE_FIELDS) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) {
      fields[key] = body[key];
    }
  }
  return fields;
}

// GET /api/characters — personnages actifs de l'utilisateur.
router.get('/', async (req, res) => {
  const characters = await characterManager.listUserCharacters(req.user);
  res.json({ characters });
});

// POST /api/characters { name, ... } — création.
router.post('/', async (req, res) => {
  const fields = pickEditableFields(req.body);
  if (!fields.name) {
    return res.status(400).json({ error: 'Le champ "name" est requis.' });
  }
  try {
    const character = await characterManager.createCharacter(req.user, fields);
    res.status(201).json({ character });
  } catch (err) {
    logger.error('Erreur création personnage (web)', err);
    res.status(500).json({ error: 'Impossible de créer le personnage.' });
  }
});

// Vérifie que le personnage appartient bien à l'utilisateur courant avant
// toute lecture/écriture ciblée (getCharacter() ne filtre pas par user_id).
async function loadOwnedCharacter(req, res, next) {
  const character = await db.getCharacter(req.params.id);
  if (!character || character.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Personnage introuvable.' });
  }
  req.character = character;
  next();
}

// GET /api/characters/:id
router.get('/:id', loadOwnedCharacter, (req, res) => {
  res.json({ character: req.character });
});

// PATCH /api/characters/:id — mise à jour partielle (un ou plusieurs champs).
router.patch('/:id', loadOwnedCharacter, async (req, res) => {
  const fields = pickEditableFields(req.body);
  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'Aucun champ éditable fourni.' });
  }
  try {
    const character = await characterManager.updateCharacter(req.character.id, fields);
    res.json({ character });
  } catch (err) {
    logger.error('Erreur mise à jour personnage (web)', err);
    res.status(500).json({ error: 'Impossible de mettre à jour le personnage.' });
  }
});

// POST /api/characters/:id/archive
router.post('/:id/archive', loadOwnedCharacter, async (req, res) => {
  await characterManager.archiveCharacter(req.character.id);
  res.json({ ok: true });
});

module.exports = router;
