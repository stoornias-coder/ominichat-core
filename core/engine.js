// Moteur Core : point d'entrée UNIQUE pour traiter un message utilisateur,
// indépendant de l'interface (Telegram, Web, ...).
//
// Ce module ne fait AUCUN appel propre à une interface (pas de
// bot.sendMessage, pas de req/res HTTP) : il prend un texte utilisateur en
// entrée et renvoie la réponse générée, en s'occupant de tout le reste
// (mémoire, recherche web, sauvegarde des messages).
//
// Extrait de l'ancien src/telegram/handlers.js sans changement de
// comportement : c'est exactement la même séquence d'appels, juste
// détachée de tout ce qui est spécifique à Telegram (indicateur de
// saisie, envoi du message, gestion des commandes/formulaires).

const db = require('./database/supabase');
const characterManager = require('./character/characterManager');
const memoryManager = require('./memory/memoryManager');
const webSearch = require('./search/webSearch');
const { generateAIResponse } = require('./ai/router');
const { buildSystemPrompt, splitReplyAndMemories } = require('./ai/promptBuilder');
const logger = require('./utils/logger');

const SHORT_TERM_LIMIT = parseInt(process.env.SHORT_TERM_HISTORY_LIMIT || '16', 10);

// Message utilisateur PRÉCÉDENT (le courant vient d'être sauvegardé, donc il est
// le dernier de la liste) : sert de contexte aux questions de suivi trop vagues
// ("et lui ?"). Voir core/search/webSearch.js -> options.contextHint.
function previousUserMessage(recentMessages) {
  const userMessages = (recentMessages || []).filter((m) => m.role === 'user');
  return userMessages.length >= 2 ? userMessages[userMessages.length - 2].content : null;
}

/**
 * Recherche web pour CE message. Ne lève jamais : une recherche ratée ne doit
 * jamais empêcher le personnage de répondre.
 *
 * WEB_SEARCH_ENGINE=legacy réactive l'ancien moteur (core/search/webSearch.legacy.js,
 * copie inchangée de l'ancien webSearch.js) : retour arrière sans toucher au code.
 * WEB_SEARCH_MODE=off désactive complètement la recherche (moteur v2).
 *
 * @returns {Promise<{ promptInput: (object|string|null), sources: object[], meta: object }>}
 *   promptInput : passé tel quel à buildSystemPrompt({ webSearchResult }).
 *   sources     : métadonnées allégées, prêtes à être affichées par une interface.
 */
async function runWebSearch(text, recentMessages) {
  const useLegacy = String(process.env.WEB_SEARCH_ENGINE || '').trim().toLowerCase() === 'legacy';
  const idle = { promptInput: null, sources: [], meta: { engine: useLegacy ? 'legacy' : 'v2', triggered: false, ok: false } };

  try {
    if (useLegacy) {
      const legacy = require('./search/webSearch.legacy');
      if (!legacy.needsWebSearch(text)) return idle;
      const block = await legacy.performWebSearch(text);
      return { promptInput: block, sources: [], meta: { engine: 'legacy', triggered: true, ok: block !== null } };
    }

    const result = await webSearch.searchWeb(text, { contextHint: previousUserMessage(recentMessages) });
    // Clé absente = problème de configuration, pas une recherche "tentée" :
    // on garde le comportement historique (aucun bloc dans le prompt).
    const injectable = result.triggered && !(result.error && result.error.code === 'no_api_key');
    return {
      promptInput: injectable ? result : null,
      sources: result.sources || [],
      meta: {
        engine: 'v2',
        triggered: result.triggered,
        ok: result.ok,
        intent: result.intent ? result.intent.intent : null,
        retrieved: result.meta ? result.meta.retrieved : 0,
        kept: result.meta ? result.meta.kept : 0,
        durationMs: result.meta ? result.meta.totalMs : 0,
        errorCode: result.error ? result.error.code : null,
      },
    };
  } catch (err) {
    logger.warn('Recherche web ignorée (erreur inattendue)', err.message);
    return idle;
  }
}

/**
 * Traite UN message utilisateur dans UNE session : c'est le seul chemin de
 * code qui appelle le modèle IA (1 message utilisateur = 1 appel IA).
 *
 * @param {{ user: object, session: object, text: string, onBeforeGenerate?: Function }} params
 *   onBeforeGenerate : hook optionnel, appelé juste avant l'appel IA (même
 *   emplacement que l'ancien `bot.sendChatAction(...)` dans handlers.js).
 *   Permet à une interface de déclencher un effet (ex : indicateur de
 *   saisie Telegram) sans que ce module ait la moindre connaissance d'une
 *   interface particulière.
 * @returns {Promise<{ reply: string, character: object, session: object,
 *   sources: object[], webSearch: object }>}
 *   sources   : sources web utilisées pour cette réponse (vide si aucune recherche).
 *   webSearch : résumé technique de la recherche (moteur, déclenchée ?, durée, code d'erreur).
 */
async function processMessage({ user, session, text, onBeforeGenerate }) {
  const character = await characterManager.resolveCharacterForSession(session);

  await db.saveMessage(session.id, 'user', text);

  const [recentMessages, memories] = await Promise.all([
    db.getRecentMessages(session.id, SHORT_TERM_LIMIT),
    memoryManager.getRelevantMemories(user, session, character, text),
  ]);

  // Recherche web : décision par règles (gratuite, sans appel API), exécution
  // seulement si nécessaire (Tavily, voir core/search/webSearch.js).
  const search = await runWebSearch(text, recentMessages);

  const systemPrompt = buildSystemPrompt({ character, memories, session, webSearchResult: search.promptInput });

  const messagesForModel = [
    { role: 'system', content: systemPrompt },
    ...recentMessages.map((m) => ({ role: m.role, content: m.content })),
  ];

  if (typeof onBeforeGenerate === 'function') {
    try {
      onBeforeGenerate();
    } catch {
      // un hook d'interface qui échoue ne doit jamais bloquer la réponse
    }
  }

  const raw = await generateAIResponse(messagesForModel, { temperature: 0.85, maxTokens: 600 });
  const { reply, memories: extracted } = splitReplyAndMemories(raw);

  await db.saveMessage(session.id, 'assistant', reply);

  // Sauvegarde des souvenirs extraits (déjà obtenus dans le MÊME appel IA
  // que la réponse : aucun appel supplémentaire). Non bloquant : une
  // erreur de sauvegarde mémoire ne doit jamais faire échouer la réponse.
  for (const item of extracted) {
    if (item && item.content) {
      memoryManager.saveExtractedMemory(user, session, character, item).catch((err) =>
        logger.warn('Sauvegarde mémoire échouée (ignorée)', err.message)
      );
    }
  }

  // `sources` et `webSearch` sont additifs : les appelants existants (Telegram,
  // Web) ne lisent que reply/character et ne sont donc pas affectés.
  return { reply, character, session, sources: search.sources, webSearch: search.meta };
}

module.exports = { processMessage };
