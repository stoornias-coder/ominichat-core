const db = require('../database/supabase');

async function listUserUniverses(user) {
  return db.listUniverses(user.id);
}

async function createUniverse(user, fields) {
  return db.createUniverse(user.id, fields);
}

async function updateUniverse(universeId, fields) {
  return db.updateUniverse(universeId, fields);
}

async function archiveUniverse(universeId) {
  return db.archiveUniverse(universeId);
}

// Adapte un univers (table "universes") au format attendu par
// promptBuilder.buildSystemPrompt() (le même format qu'un "character"),
// avec isUniverse: true pour que le prompt distingue "incarner UN
// personnage" de "être le narrateur d'un monde avec plusieurs personnages
// non-joueurs". character.id reste null : un univers n'a pas de mémoire
// de type "character" propre (memories.character_id référence la table
// characters) — la continuité d'un univers passe par la mémoire de scope
// "session", ce qui est cohérent puisqu'une session est dédiée à un seul
// univers à la fois.
async function resolveUniverseAsEntity(universeId) {
  const universe = await db.getUniverse(universeId);
  if (!universe) {
    const characterManager = require('../character/characterManager');
    return characterManager.GENERAL_ASSISTANT;
  }

  return {
    id: null,
    name: universe.name,
    age: null,
    description: universe.description,
    role: 'Maître du Jeu (narrateur) de cet univers. Tu incarnes tous les personnages non-joueurs qui y vivent, pas un seul personnage fixe.',
    personality: universe.personality,
    backstory: universe.backstory,
    initial_situation: universe.initial_situation || universe.opening,
    speaking_style: 'Narration immersive à la deuxième personne quand tu décris la scène ; dialogues directs quand un personnage non-joueur parle.',
    relationship_default: '',
    rules: universe.rules,
    additional_instructions: universe.additional_instructions,
    isUniverse: true,
  };
}

module.exports = {
  listUserUniverses,
  createUniverse,
  updateUniverse,
  archiveUniverse,
  resolveUniverseAsEntity,
};
