const db = require('../database/supabase');

const GLOBAL_LIMIT = parseInt(process.env.GLOBAL_MEMORY_LIMIT || '4', 10);
const SESSION_MEMORY_LIMIT = parseInt(process.env.SESSION_MEMORY_LIMIT || '4', 10);
const CHARACTER_MEMORY_LIMIT = parseInt(process.env.CHARACTER_MEMORY_LIMIT || '4', 10);

// Mémoires "ancrées" : des événements majeurs (ex: un enlèvement, une
// rupture, une révélation) qui ne doivent JAMAIS disparaître du contexte,
// même quand une recherche par mot-clé a déjà trouvé d'autres souvenirs
// pour ce message. Un petit nombre de slots leur est toujours réservé.
const ANCHOR_LIMIT = parseInt(process.env.ANCHOR_MEMORY_LIMIT || '3', 10);
const ANCHOR_MIN_IMPORTANCE = parseInt(process.env.ANCHOR_MIN_IMPORTANCE || '8', 10);
const ANCHOR_CATEGORIES = ['event', 'important'];

function mergeUnique(primary, secondary, limit) {
  const seen = new Set();
  const merged = [];
  for (const item of primary) {
    if (merged.length >= limit) break;
    if (seen.has(item.content)) continue;
    seen.add(item.content);
    merged.push(item);
  }
  for (const item of secondary) {
    if (merged.length >= limit) break;
    if (seen.has(item.content)) continue;
    seen.add(item.content);
    merged.push(item);
  }
  return merged;
}

/**
 * Récupère les souvenirs d'un scope (session ou character) en garantissant
 * que les événements majeurs ("ancres") sont toujours présents, puis
 * complète avec les résultats de la recherche par mot-clé habituelle.
 * Ne fait qu'un seul aller-retour DB de plus par scope (pas d'appel IA).
 */
async function getScopedMemoriesWithAnchors(userId, queryText, { scope, sessionId, characterId, limit }) {
  const [anchors, keywordMatches] = await Promise.all([
    db.getAnchorMemories(userId, {
      scope,
      sessionId,
      characterId,
      limit: Math.min(ANCHOR_LIMIT, limit),
      minImportance: ANCHOR_MIN_IMPORTANCE,
      categories: ANCHOR_CATEGORIES,
    }),
    db.searchMemoriesByScope(userId, queryText, { scope, sessionId, characterId, limit }),
  ]);

  let merged = mergeUnique(anchors, keywordMatches, limit);

  // Repli identique à l'ancien comportement : si ni ancre ni mot-clé n'ont
  // rien donné, on prend quand même les souvenirs les plus importants de ce
  // scope pour garder un minimum de continuité.
  if (merged.length === 0) {
    const topMemories = await db.getTopMemoriesByScope(userId, { scope, sessionId, characterId, limit });
    merged = mergeUnique(merged, topMemories, limit);
  }

  return merged;
}

/**
 * Sélectionne les souvenirs pertinents pour le message en cours, par scope.
 *
 * - global    : injecté UNIQUEMENT si un souvenir correspond par mot-clé au
 *               message (pas de rappel automatique systématique, pour ne pas
 *               polluer un RP avec des infos perso sans rapport).
 * - session   : mémoire de cette conversation. Les événements majeurs
 *               ("event"/"important", forte importance) sont TOUJOURS
 *               inclus ; le reste des slots vient de la recherche par
 *               mot-clé, avec repli sur les plus importants si rien ne
 *               matche.
 * - character : mémoire propre au personnage (relation, événements vécus
 *               avec lui) ; même logique que "session".
 */
async function getRelevantMemories(user, session, character, queryText) {
  const globalMatches = await db.searchMemoriesByScope(user.id, queryText, {
    scope: 'global',
    limit: GLOBAL_LIMIT,
  });

  const sessionMemories = await getScopedMemoriesWithAnchors(user.id, queryText, {
    scope: 'session',
    sessionId: session.id,
    limit: SESSION_MEMORY_LIMIT,
  });

  let characterMemories = [];
  if (character.id) {
    characterMemories = await getScopedMemoriesWithAnchors(user.id, queryText, {
      scope: 'character',
      characterId: character.id,
      limit: CHARACTER_MEMORY_LIMIT,
    });
  }

  return { global: globalMatches, session: sessionMemories, character: characterMemories };
}

async function saveExtractedMemory(user, session, character, item) {
  const scope = ['global', 'session', 'character'].includes(item.scope) ? item.scope : 'session';

  // Un souvenir "character" n'a de sens que si un personnage est actif.
  const finalScope = scope === 'character' && !character.id ? 'session' : scope;

  await db.saveMemory(user.id, {
    scope: finalScope,
    sessionId: session.id,
    characterId: character.id,
    category: item.category || 'fact',
    content: item.content,
    importance: Number(item.importance) || 5,
  });
}

module.exports = { getRelevantMemories, saveExtractedMemory };
