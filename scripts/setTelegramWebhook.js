// Enregistre le webhook Telegram sur l'URL publique du serveur déployé.
// À exécuter UNE FOIS après chaque déploiement (ou changement d'URL) :
//   PUBLIC_URL=https://xxx.run.app npm run telegram:set-webhook
// (ou renseigne PUBLIC_URL dans ton .env avant de lancer la commande).

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const publicUrl = process.env.PUBLIC_URL;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!token || !publicUrl || !secret) {
  console.error(
    'TELEGRAM_BOT_TOKEN, PUBLIC_URL et TELEGRAM_WEBHOOK_SECRET sont requis (dans .env ou en variables d\'environnement).'
  );
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });
const webhookUrl = `${publicUrl.replace(/\/$/, '')}/telegram/webhook/${secret}`;

bot
  .setWebHook(webhookUrl)
  .then(() => {
    console.log('Webhook Telegram configuré sur :', webhookUrl);
  })
  .catch((err) => {
    console.error('Échec de la configuration du webhook :', err.message);
    process.exit(1);
  });
