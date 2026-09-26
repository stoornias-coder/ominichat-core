const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const logger = require('../utils/logger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  logger.error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant dans .env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  // Node.js < 22 n'a pas de WebSocket natif : on fournit "ws" pour que le
  // client Realtime de Supabase puisse s'initialiser (même non utilisé ici).
  realtime: { transport: ws },
});

// ============================================================
// users
// ============================================================

async function getOrCreateUser(telegramUser) {
  const { id: telegram_user_id, username, first_name } = telegramUser;

  const { data: existing, error: selectError } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_user_id', telegram_user_id)
    .maybeSingle();

  if (selectError) {
    logger.error('Erreur lecture user', selectError);
    throw selectError;
  }
  if (existing) return existing;

  const { data: created, error: insertError } = await supabase
    .from('users')
    .insert({ telegram_user_id, username, first_name })
    .select()
    .single();

  if (insertError) {
    logger.error('Erreur création user', insertError);
    throw insertError;
  }
  return created;
}

// Équivalent de getOrCreateUser(), mais pour l'identité Web (Supabase Auth)
// au lieu de l'identité Telegram. Additif : ne change rien au chemin
// Telegram existant. Voir sql/migration_v5.sql (colonne auth_user_id).
async function getOrCreateUserByAuthId(authUserId) {
  const { data: existing, error: selectError } = await supabase
    .from('users')
    .select('*')
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  if (selectError) {
    logger.error('Erreur lecture user (auth_user_id)', selectError);
    throw selectError;
  }
  if (existing) return existing;

  const { data: created, error: insertError } = await supabase
    .from('users')
    .insert({ auth_user_id: authUserId })
    .select()
    .single();

  if (insertError) {
    logger.error('Erreur création user (auth_user_id)', insertError);
    throw insertError;
  }
  return created;
}

async function setActiveSession(userId, sessionId) {
  const { error } = await supabase
    .from('users')
    .update({ active_session_id: sessionId })
    .eq('id', userId);

  if (error) logger.error('Erreur mise à jour session active', error);
}

// ============================================================
// characters
// ============================================================

async function listCharacters(userId) {
  const { data, error } = await supabase
    .from('characters')
    // fandom/character_type ajoutés (migration v7) : nécessaires à l'affichage
    // de la carte personnage dans la bibliothèque web (badge type + fandom),
    // sans requête supplémentaire par personnage. "opening" volontairement
    // exclu de la liste (pas nécessaire hors ouverture d'un RP, potentiellement
    // long) : récupéré via GET /api/characters/:id.
    .select('id, name, description, fandom, character_type')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('Erreur liste personnages', error);
    return [];
  }
  return data;
}

async function updateCharacter(characterId, fields) {
  const { data, error } = await supabase
    .from('characters')
    .update(fields)
    .eq('id', characterId)
    .select()
    .single();

  if (error) {
    logger.error('Erreur mise à jour personnage', error);
    throw error;
  }
  return data;
}

async function archiveCharacter(characterId) {
  const { error } = await supabase
    .from('characters')
    .update({ is_archived: true })
    .eq('id', characterId);

  if (error) {
    logger.error('Erreur archivage personnage', error);
    throw error;
  }
}

async function getCharacter(characterId) {
  if (!characterId) return null;
  const { data, error } = await supabase
    .from('characters')
    .select('*')
    .eq('id', characterId)
    .maybeSingle();

  if (error) {
    logger.error('Erreur lecture personnage', error);
    return null;
  }
  return data;
}

async function createCharacter(userId, fields) {
  const { data, error } = await supabase
    .from('characters')
    .insert({ user_id: userId, ...fields })
    .select()
    .single();

  if (error) {
    logger.error('Erreur création personnage', error);
    throw error;
  }
  return data;
}

// ============================================================
// universes
// ============================================================

async function listUniverses(userId) {
  const { data, error } = await supabase
    .from('universes')
    .select('id, name, description')
    .eq('user_id', userId)
    .eq('is_archived', false)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('Erreur liste univers', error);
    return [];
  }
  return data;
}

async function getUniverse(universeId) {
  if (!universeId) return null;
  const { data, error } = await supabase
    .from('universes')
    .select('*')
    .eq('id', universeId)
    .maybeSingle();

  if (error) {
    logger.error('Erreur lecture univers', error);
    return null;
  }
  return data;
}

async function createUniverse(userId, fields) {
  const { data, error } = await supabase
    .from('universes')
    .insert({ user_id: userId, ...fields })
    .select()
    .single();

  if (error) {
    logger.error('Erreur création univers', error);
    throw error;
  }
  return data;
}

async function updateUniverse(universeId, fields) {
  const { data, error } = await supabase
    .from('universes')
    .update(fields)
    .eq('id', universeId)
    .select()
    .single();

  if (error) {
    logger.error('Erreur mise à jour univers', error);
    throw error;
  }
  return data;
}

async function archiveUniverse(universeId) {
  const { error } = await supabase
    .from('universes')
    .update({ is_archived: true })
    .eq('id', universeId);

  if (error) {
    logger.error('Erreur archivage univers', error);
    throw error;
  }
}

// ============================================================
// sessions
// ============================================================

async function createSession(userId, { characterId = null, universeId = null, title } = {}) {
  const { data, error } = await supabase
    .from('sessions')
    .insert({
      user_id: userId,
      character_id: characterId,
      universe_id: universeId,
      title: title || (characterId || universeId ? 'RP' : 'Discussion générale'),
    })
    .select()
    .single();

  if (error) {
    logger.error('Erreur création session', error);
    throw error;
  }

  await setActiveSession(userId, data.id);
  return data;
}

async function listSessions(userId, limit = 20) {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, title, character_id, universe_id, updated_at, characters(name), universes(name)')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('Erreur liste sessions', error);
    return [];
  }
  return data;
}

// Pagination pour l'affichage Telegram ("Mes conversations").
// N'est PAS utilisée pour construire le contexte envoyé à l'IA.
async function listSessionsPage(userId, { limit = 5, offset = 0 } = {}) {
  const { data, error, count } = await supabase
    .from('sessions')
    .select('id, title, character_id, universe_id, updated_at, characters(name), universes(name)', { count: 'exact' })
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    logger.error('Erreur liste sessions (page)', error);
    return { sessions: [], total: 0 };
  }
  return { sessions: data, total: count || 0 };
}

async function getSessionWithCharacter(sessionId) {
  const { data, error } = await supabase
    .from('sessions')
    .select('*, characters(name), universes(name)')
    .eq('id', sessionId)
    .maybeSingle();

  if (error) {
    logger.error('Erreur lecture session (avec personnage/univers)', error);
    return null;
  }
  return data;
}

async function getLatestSessionForCharacter(userId, characterId) {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('character_id', characterId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error('Erreur recherche session existante pour personnage', error);
    return null;
  }
  return data;
}

async function getLatestSessionForUniverse(userId, universeId) {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('universe_id', universeId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error('Erreur recherche session existante pour univers', error);
    return null;
  }
  return data;
}

async function getSession(sessionId) {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();

  if (error) {
    logger.error('Erreur lecture session', error);
    return null;
  }
  return data;
}

async function getActiveSession(user) {
  if (!user.active_session_id) return null;
  return getSession(user.active_session_id);
}

async function touchSession(sessionId) {
  await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId);
}

// ============================================================
// messages
// ============================================================

async function saveMessage(sessionId, role, content) {
  const { error } = await supabase
    .from('messages')
    .insert({ session_id: sessionId, role, content });

  if (error) logger.error('Erreur sauvegarde message', error);
  touchSession(sessionId).catch(() => {});
}

async function getRecentMessages(sessionId, limit = 16) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('Erreur lecture messages', error);
    return [];
  }
  return data.reverse();
}

// ---- Historique consultable depuis Telegram (distinct du contexte IA) ----
// getRecentMessages (ci-dessus) reste la SEULE fonction utilisée pour
// construire les messages envoyés au modèle. Les deux fonctions suivantes
// servent uniquement à l'affichage paginé dans le bot.

async function getMessagesCount(sessionId) {
  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId);

  if (error) {
    logger.error('Erreur comptage messages', error);
    return 0;
  }
  return count || 0;
}

async function getMessagesPage(sessionId, { limit = 10, offset = 0 } = {}) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    logger.error('Erreur lecture page messages', error);
    return [];
  }
  return data.reverse(); // ordre chronologique pour l'affichage
}

// ============================================================
// memories (scope: global | session | character)
// ============================================================

async function saveMemory(userId, { scope, sessionId = null, characterId = null, category, content, importance = 5 }) {
  const row = {
    user_id: userId,
    scope,
    session_id: scope === 'session' ? sessionId : null,
    character_id: scope === 'character' ? characterId : null,
    category,
    content,
    importance: Math.min(10, Math.max(1, importance)),
  };

  const { error } = await supabase.from('memories').insert(row);
  if (error) logger.error('Erreur sauvegarde mémoire', error);
}

// Recherche par mots-clés, restreinte à un scope donné.
async function searchMemoriesByScope(userId, queryText, { scope, sessionId, characterId, limit }) {
  const keywords = extractKeywords(queryText);

  let query = supabase
    .from('memories')
    .select('category, content, importance, scope')
    .eq('user_id', userId)
    .eq('scope', scope);

  if (scope === 'session') query = query.eq('session_id', sessionId);
  if (scope === 'character') query = query.eq('character_id', characterId);

  if (keywords.length > 0) {
    const orFilter = keywords.map((k) => `content.ilike.%${k}%`).join(',');
    query = query.or(orFilter);
  }

  const { data, error } = await query
    .order('importance', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error(`Erreur recherche mémoires (scope=${scope})`, error);
    return [];
  }
  return data;
}

// Mémoires "ancrées" : événements majeurs (catégorie event/important, forte
// importance) qui doivent être rappelés systématiquement, indépendamment
// d'un éventuel match par mot-clé sur le message en cours. Utilisé pour ne
// jamais perdre un fait de scène critique (ex: un enlèvement, une rupture).
async function getAnchorMemories(userId, {
  scope,
  sessionId,
  characterId,
  limit,
  minImportance = 8,
  categories = ['event', 'important'],
}) {
  let query = supabase
    .from('memories')
    .select('category, content, importance, scope')
    .eq('user_id', userId)
    .eq('scope', scope)
    .in('category', categories)
    .gte('importance', minImportance);

  if (scope === 'session') query = query.eq('session_id', sessionId);
  if (scope === 'character') query = query.eq('character_id', characterId);

  const { data, error } = await query
    .order('importance', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error(`Erreur récupération mémoires ancrées (scope=${scope})`, error);
    return [];
  }
  return data;
}

async function getTopMemoriesByScope(userId, { scope, sessionId, characterId, limit }) {
  let query = supabase
    .from('memories')
    .select('category, content, importance, scope')
    .eq('user_id', userId)
    .eq('scope', scope);

  if (scope === 'session') query = query.eq('session_id', sessionId);
  if (scope === 'character') query = query.eq('character_id', characterId);

  const { data, error } = await query
    .order('importance', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error(`Erreur top mémoires (scope=${scope})`, error);
    return [];
  }
  return data;
}

function extractKeywords(text) {
  const STOPWORDS = new Set([
    'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'à', 'a',
    'que', 'qui', 'quoi', 'est', 'es', 'suis', 'tu', 'je', 'il', 'elle',
    'nous', 'vous', 'ils', 'elles', 'ce', 'ces', 'mon', 'ma', 'mes', 'ton',
    'ta', 'tes', 'son', 'sa', 'ses', 'pour', 'avec', 'sur', 'dans', 'te',
    'me', 'se', 'pas', 'plus', 'comment', 'souviens', 'souvient', 'as',
  ]);

  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 8);
}

module.exports = {
  supabase,
  getOrCreateUser,
  getOrCreateUserByAuthId,
  setActiveSession,
  listCharacters,
  getCharacter,
  createCharacter,
  updateCharacter,
  archiveCharacter,
  listUniverses,
  getUniverse,
  createUniverse,
  updateUniverse,
  archiveUniverse,
  createSession,
  listSessions,
  listSessionsPage,
  getSession,
  getSessionWithCharacter,
  getLatestSessionForCharacter,
  getLatestSessionForUniverse,
  getActiveSession,
  saveMessage,
  getRecentMessages,
  getMessagesCount,
  getMessagesPage,
  saveMemory,
  searchMemoriesByScope,
  getTopMemoriesByScope,
  getAnchorMemories,
};
