// Endpoint appelé directement par Telegram à chaque message/callback
// (mode webhook). Monté sur un chemin contenant un secret (voir
// interfaces/web/server/index.js) : Telegram ne signe pas ses requêtes,
// donc l'obscurité de l'URL est la seule protection contre de faux updates
// qui déclencheraient des appels IA non désirés.

const express = require('express');
const { getWebhookBot } = require('../telegramWebhookBot');

const router = express.Router();

router.post('/', (req, res) => {
  const bot = getWebhookBot();
  // processUpdate() réutilise EXACTEMENT les mêmes listeners ('message',
  // 'callback_query') que le mode polling -> même comportement utilisateur.
  bot.processUpdate(req.body);
  // Telegram exige une réponse rapide (< 60s) ; le traitement réel
  // (appel IA, etc.) continue en arrière-plan dans les listeners.
  res.sendStatus(200);
});

module.exports = router;
