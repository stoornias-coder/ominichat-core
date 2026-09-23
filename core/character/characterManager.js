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
  listUserCharacters,
  createCharacter,
  updateCharacter,
  archiveCharacter,
  GENERAL_ASSISTANT,
};
