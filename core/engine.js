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
 * @returns {Promise<{ reply: string, character: object, session: object }>}
 */
async function processMessage({ user, session, text, onBeforeGenerate }) {
  const character = await characterManager.resolveCharacterForSession(session);

  await db.saveMessage(session.id, 'user', text);

  const [recentMessages, memories] = await Promise.all([
    db.getRecentMessages(session.id, SHORT_TERM_LIMIT),
    memoryManager.getRelevantMemories(user, session, character, text),
  ]);

  // Recherche web : décision heuristique gratuite, exécution seulement si
  // nécessaire (branchée sur Tavily, voir core/search/webSearch.js).
  let webSearchResult = null;
  if (webSearch.needsWebSearch(text)) {
    webSearchResult = await webSearch.performWebSearch(text);
  }

  const systemPrompt = buildSystemPrompt({ character, memories, session, webSearchResult });

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

  return { reply, character, session };
}

module.exports = { processMessage };
