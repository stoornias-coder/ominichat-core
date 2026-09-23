// Supprime le webhook Telegram configuré. Nécessaire avant de repasser en
// mode polling (dev local / Replit) : Telegram interdit polling et webhook
// simultanément sur le même bot.
//   npm run telegram:delete-webhook

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN requis (dans .env ou en variable d\'environnement).');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });

bot
  .deleteWebHook()
  .then(() => console.log('Webhook Telegram supprimé. Le mode polling (npm start) peut être utilisé.'))
  .catch((err) => {
    console.error('Échec de la suppression du webhook :', err.message);
    process.exit(1);
  });
