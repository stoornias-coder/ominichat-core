const db = require('../database/supabase');

// Utilisé quand une session n'a pas de personnage (mode "assistant général").
const GENERAL_ASSISTANT = {
  id: null,
  name: 'Assistant',
  age: null,
  description: "Un assistant général, direct et serviable.",
  personality: 'Clair, pragmatique, pas de blabla inutile.',
  backstory: '',
  speaking_style: 'Naturel, phrases claires, pas de jargon inutile.',
  relationship_default: 'Relation neutre, orientée aide.',
  rules: 'Répondre honnêtement ; dire clairement quand une information est incertaine ou inconnue.',
  additional_instructions: '',
};

async function resolveCharacterForSession(session) {
  if (!session.character_id) return GENERAL_ASSISTANT;
  const character = await db.getCharacter(session.character_id);
  return character || GENERAL_ASSISTANT;
}

// Comme resolveCharacterForSession, mais gère aussi le cas "univers" (voir
// core/universe/universeManager.js) : une session est liée SOIT à un
// personnage, SOIT à un univers, jamais les deux (contrainte DB, migration
// v6). Utilisé par engine.js à la place de resolveCharacterForSession pour
// que le moteur IA fonctionne pour les trois cas (assistant général,
// personnage, univers) sans dupliquer sa logique.
async function resolveEntityForSession(session) {
  if (session.universe_id) {
    const universeManager = require('../universe/universeManager');
    return universeManager.resolveUniverseAsEntity(session.universe_id);
  }
  return resolveCharacterForSession(session);
}

async function listUserCharacters(user) {
  return db.listCharacters(user.id);
}

async function createCharacter(user, fields) {
  return db.createCharacter(user.id, fields);
}

async function updateCharacter(characterId, fields) {
  return db.updateCharacter(characterId, fields);
}

async function archiveCharacter(characterId) {
  return db.archiveCharacter(characterId);
}

module.exports = {
  resolveCharacterForSession,
  resolveEntityForSession,
  listUserCharacters,
  createCharacter,
  updateCharacter,
  archiveCharacter,
  GENERAL_ASSISTANT,
};
