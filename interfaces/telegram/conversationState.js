// État de conversation en mémoire, par chatId.
// Sert uniquement aux flux multi-messages qui ne concernent PAS l'IA
// (ex : création ou édition d'un personnage, champ par champ).
// Prototype : perdu si le process redémarre. À rendre persistant
// (ex: table Supabase "conversation_states") si besoin plus tard.

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes : sécurité anti-état fantôme

const states = new Map();

function setState(chatId, value) {
  states.set(chatId, { ...value, _createdAt: Date.now() });
}

function getState(chatId) {
  const state = states.get(chatId);
  if (!state) return null;
  if (Date.now() - state._createdAt > STATE_TTL_MS) {
    states.delete(chatId); // état trop vieux : on l'ignore et on l'efface
    return null;
  }
  return state;
}

function clearState(chatId) {
  states.delete(chatId);
}

module.exports = { setState, getState, clearState };
