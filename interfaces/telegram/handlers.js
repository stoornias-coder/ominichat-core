const db = require('../../core/database/supabase');
const sessionManager = require('../../core/session/sessionManager');
const logger = require('../../core/utils/logger');
const engine = require('../../core/engine');
const commands = require('./commands');
const conversationState = require('./conversationState');

const FALLBACK_REPLY = "Attends, j'ai eu un petit bug 😅 Réessaie dans quelques secondes.";

async function handleIncomingMessage(bot, msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  try {
    const user = await db.getOrCreateUser(msg.from);

    // ---------- réponse à un flux en cours (création/édition personnage) ----------
    // Ne passe jamais par l'IA : uniquement Supabase, via commands.js.
    // Une commande slash annule toujours un formulaire en cours (l'utilisateur
    // change clairement d'intention) plutôt que de laisser un état trainer.
    if (text.startsWith('/')) {
      conversationState.clearState(chatId);
    } else {
      const state = conversationState.getState(chatId);
      if (state?.type === 'create_character') {
        return commands.handleCharacterCreateInput(bot, chatId, user, text, state);
      }
      if (state?.type === 'edit_character') {
        return commands.handleCharacterEditInput(bot, chatId, user, text, state);
      }
    }

    // ---------- commandes slash ----------
    if (text === '/start') return commands.handleStart(bot, chatId, user);
    if (text === '/new') return commands.handleNewCommand(bot, chatId, user);
    if (text === '/sessions') return commands.handleSessionsCommand(bot, chatId, user);
    if (text === '/characters') return commands.handleCharactersCommand(bot, chatId, user);

    // ---------- message normal : délégué au Core (1 seul appel IA) ----------
    const session = await sessionManager.getOrCreateActiveSession(user);

    const { reply } = await engine.processMessage({
      user,
      session,
      text,
      onBeforeGenerate: () => bot.sendChatAction(chatId, 'typing').catch(() => {}),
    });

    await bot.sendMessage(chatId, reply);
  } catch (err) {
    logger.error('Erreur lors du traitement du message', err);
    try {
      await bot.sendMessage(chatId, FALLBACK_REPLY);
    } catch (sendErr) {
      logger.error("Impossible d'envoyer le message de fallback", sendErr);
    }
  }
}

async function handleCallbackQuery(bot, query) {
  try {
    const user = await db.getOrCreateUser(query.from);
    await commands.handleCallbackQuery(bot, query, user);
  } catch (err) {
    logger.error('Erreur lors du traitement du callback', err);
  }
}

module.exports = { handleIncomingMessage, handleCallbackQuery };
