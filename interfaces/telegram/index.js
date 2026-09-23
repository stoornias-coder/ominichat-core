require('dotenv').config();

const { createBot } = require('./bot');
const logger = require('../../core/utils/logger');

const PROVIDER_KEY_ENV = {
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

function requiredEnv() {
  const base = ['TELEGRAM_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const provider = process.env.AI_PROVIDER || 'groq';
  const providerKey = PROVIDER_KEY_ENV[provider];
  return providerKey ? [...base, providerKey] : base;
}

function checkEnv() {
  const missing = requiredEnv().filter((key) => !process.env[key]);
  if (missing.length > 0) {
    logger.error(
      `Variables d'environnement manquantes : ${missing.join(', ')}. ` +
        'Copie .env.example vers .env et remplis les valeurs.'
    );
    process.exit(1);
  }
}

function main() {
  checkEnv();
  createBot();
}

main();
