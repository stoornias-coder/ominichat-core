// Instance TelegramBot unique côté serveur Web, en mode webhook (pas de
// polling). Créée à la demande, réutilisée pour tous les updates reçus.

const { createBotInstance } = require('../../telegram/bot');

let botInstance = null;

function getWebhookBot() {
  if (!botInstance) {
    botInstance = createBotInstance();
  }
  return botInstance;
}

module.exports = { getWebhookBot };
