const express = require('express');
const db = require('../../../../core/database/supabase');
const universeManager = require('../../../../core/universe/universeManager');
const logger = require('../../../../core/utils/logger');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const EDITABLE_FIELDS = [
  'name', 'description', 'personality', 'backstory', 'initial_situation',
  'opening', 'rules', 'additional_instructions', 'avatar_url', 'is_public',
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

// GET /api/universes — univers actifs de l'utilisateur.
router.get('/', async (req, res) => {
  const universes = await universeManager.listUserUniverses(req.user);
  res.json({ universes });
});

// POST /api/universes { name, ... } — création.
router.post('/', async (req, res) => {
  const fields = pickEditableFields(req.body);
  if (!fields.name) {
    return res.status(400).json({ error: 'Le champ "name" est requis.' });
  }
  try {
    const universe = await universeManager.createUniverse(req.user, fields);
    res.status(201).json({ universe });
  } catch (err) {
    logger.error('Erreur création univers (web)', err);
    res.status(500).json({ error: "Impossible de créer l'univers." });
  }
});

// Vérifie que l'univers appartient bien à l'utilisateur courant avant
// toute lecture/écriture ciblée (db.getUniverse() ne filtre pas par user_id).
async function loadOwnedUniverse(req, res, next) {
  const universe = await db.getUniverse(req.params.id);
  if (!universe || universe.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Univers introuvable.' });
  }
  req.universe = universe;
  next();
}

// GET /api/universes/:id
router.get('/:id', loadOwnedUniverse, (req, res) => {
  res.json({ universe: req.universe });
});

// PATCH /api/universes/:id — mise à jour partielle (un ou plusieurs champs).
router.patch('/:id', loadOwnedUniverse, async (req, res) => {
  const fields = pickEditableFields(req.body);
  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'Aucun champ éditable fourni.' });
  }
  try {
    const universe = await universeManager.updateUniverse(req.universe.id, fields);
    res.json({ universe });
  } catch (err) {
    logger.error('Erreur mise à jour univers (web)', err);
    res.status(500).json({ error: "Impossible de mettre à jour l'univers." });
  }
});

// POST /api/universes/:id/archive
router.post('/:id/archive', loadOwnedUniverse, async (req, res) => {
  await universeManager.archiveUniverse(req.universe.id);
  res.json({ ok: true });
});

module.exports = router;
