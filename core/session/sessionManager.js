const db = require('../database/supabase');

async function getOrCreateActiveSession(user) {
  let session = await db.getActiveSession(user);
  if (session) return session;

  // Premier contact : on crée une session générale par défaut.
  return db.createSession(user.id, { title: 'Discussion générale' });
}

async function startNewSession(user, { characterId = null, universeId = null, title } = {}) {
  return db.createSession(user.id, { characterId, universeId, title });
}

async function switchToSession(user, sessionId) {
  const session = await db.getSession(sessionId);
  if (!session || session.user_id !== user.id) {
    return null; // n'appartient pas à cet utilisateur, ou n'existe pas
  }
  await db.setActiveSession(user.id, sessionId);
  return session;
}

async function listUserSessions(user) {
  return db.listSessions(user.id);
}

// Pagination pour l'affichage Telegram ("Mes conversations").
async function listUserSessionsPage(user, page = 0, pageSize = 5) {
  const offset = page * pageSize;
  const { sessions, total } = await db.listSessionsPage(user.id, { limit: pageSize, offset });
  return { sessions, total, page, pageSize };
}

async function getSessionDetails(sessionId) {
  return db.getSessionWithCharacter(sessionId);
}

// Utilisé par le bouton "Parler avec X" : réactive la session la plus
// récente déjà liée à ce personnage, ou en crée une nouvelle sinon.
// Ne crée jamais de doublon si une conversation avec ce personnage existe déjà.
async function startOrResumeCharacterSession(user, characterId) {
  const existing = await db.getLatestSessionForCharacter(user.id, characterId);
  if (existing) {
    await db.setActiveSession(user.id, existing.id);
    return existing;
  }
  const character = await db.getCharacter(characterId);
  return db.createSession(user.id, { characterId, title: character ? character.name : 'RP' });
}

// Équivalent de startOrResumeCharacterSession(), pour un univers.
async function startOrResumeUniverseSession(user, universeId) {
  const existing = await db.getLatestSessionForUniverse(user.id, universeId);
  if (existing) {
    await db.setActiveSession(user.id, existing.id);
    return existing;
  }
  const universe = await db.getUniverse(universeId);
  return db.createSession(user.id, { universeId, title: universe ? universe.name : 'Univers' });
}

module.exports = {
  getOrCreateActiveSession,
  startNewSession,
  switchToSession,
  listUserSessions,
  listUserSessionsPage,
  getSessionDetails,
  startOrResumeCharacterSession,
  startOrResumeUniverseSession,
};
