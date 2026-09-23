const TelegramBot = require('node-telegram-bot-api');
const { handleIncomingMessage, handleCallbackQuery } = require('./handlers');
const logger = require('../../core/utils/logger');

// Crée une instance TelegramBot avec les handlers déjà branchés, SANS
// démarrer de transport (ni polling, ni webhook). Le choix du transport
// est fait par l'appelant :
//   - createBot()          -> polling, pour le dev local / Replit
//   - createBotInstance()  -> utilisé tel quel en mode webhook par
//                             interfaces/web/server (voir telegramWebhookBot.js)
function createBotInstance() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN manquant dans .env');
  }

  const bot = new TelegramBot(token, { polling: false });

  bot.on('message', (msg) => {
    if (msg.chat.type !== 'private') return; // conversations privées uniquement
    handleIncomingMessage(bot, msg);
  });

  bot.on('callback_query', (query) => {
    handleCallbackQuery(bot, query);
  });

  bot.on('polling_error', (err) => {
    logger.error('Erreur de polling Telegram', err.message);
  });

  bot.on('webhook_error', (err) => {
    logger.error('Erreur de webhook Telegram', err.message);
  });

  return bot;
}

// Vide la file d'attente Telegram avant de démarrer le polling.
// Sans ça, tout clic ou message reçu pendant que le bot était hors ligne
// (redémarrage, redéploiement...) est "rejoué" d'un coup au démarrage,
// ce qui donne l'impression que le bot déclenche des actions au hasard.
// Non utilisé en mode webhook (Telegram ne "rejoue" jamais un webhook
// raté de la même façon ; il retente avec un backoff propre).
async function discardPendingUpdates(bot) {
  try {
    const updates = await bot.getUpdates({ timeout: 0 });
    if (updates.length > 0) {
      const lastId = updates[updates.length - 1].update_id;
      await bot.getUpdates({ offset: lastId + 1, timeout: 0 });
      logger.info(`${updates.length} ancienne(s) mise(s) à jour Telegram ignorée(s) (backlog au démarrage).`);
    }
  } catch (err) {
    logger.warn("Impossible de vider la file Telegram avant démarrage", err.message);
  }
}

// Mode polling : comportement strictement identique à l'ancien createBot().
function createBot() {
  const bot = createBotInstance();

  discardPendingUpdates(bot)
    .then(() => bot.startPolling())
    .then(() => logger.info('Bot Telegram démarré (polling).'))
    .catch((err) => {
      logger.error('Erreur au démarrage du polling, on démarre quand même', err.message);
      bot.startPolling();
    });

  return bot;
}

module.exports = { createBot, createBotInstance };
