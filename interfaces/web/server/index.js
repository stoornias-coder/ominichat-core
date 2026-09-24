require('dotenv').config();

const express = require('express');
const cors = require('cors');
const logger = require('../../../core/utils/logger');
const authRoutes = require('./routes/auth');
const sessionRoutes = require('./routes/sessions');
const characterRoutes = require('./routes/characters');
const universeRoutes = require('./routes/universes');
const searchRoutes = require('./routes/search');
const telegramWebhookRoutes = require('./routes/telegramWebhook');

const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
];

function checkEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    logger.error(
      `Variables d'environnement manquantes pour interfaces/web : ${missing.join(', ')}. ` +
        'Copie .env.example vers .env et remplis les valeurs.'
    );
    process.exit(1);
  }
}

function buildApp() {
  const app = express();

  // Derrière le proxy de l'hébergeur (Render…), req.ip doit être l'IP du client réel
  // et non celle du proxy : nécessaire au limiteur de /api/search.
  // TRUST_PROXY_HOPS = nombre de proxys de confiance devant l'app (1 par défaut ; 0 = aucun).
  const trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS || '1', 10);
  app.set('trust proxy', Number.isFinite(trustProxyHops) ? Math.max(0, trustProxyHops) : 1);

  // Autorise uniquement les origines listées (front Capacitor/web à venir).
  // Vide par défaut = aucune origine cross-site autorisée tant que le
  // frontend n'est pas rebranché (voir consigne : ne pas y toucher pour
  // l'instant). Les appels sans en-tête Origin (ex: curl, apps mobiles
  // natives) passent toujours.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error('Origine non autorisée par CORS'));
    },
  }));

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRoutes);
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/characters', characterRoutes);
  app.use('/api/universes', universeRoutes);
  // Recherche web pour l'app OmniChat (protégée par la clé Tavily de l'appelant, pas par login).
  app.use('/api/search', searchRoutes);

  // Telegram (interface secondaire, optionnelle) : monté seulement si un
  // token ET un secret de chemin sont configurés. Le secret fait partie de
  // l'URL elle-même (ex: /telegram/webhook/<secret>) pour que seul
  // Telegram (qui connaît cette URL exacte, configurée via
  // scripts/setTelegramWebhook.js) puisse y poster des updates.
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_WEBHOOK_SECRET) {
    app.use(`/telegram/webhook/${process.env.TELEGRAM_WEBHOOK_SECRET}`, telegramWebhookRoutes);
    logger.info('Webhook Telegram monté.');
  } else {
    logger.info('TELEGRAM_BOT_TOKEN ou TELEGRAM_WEBHOOK_SECRET absent : webhook Telegram désactivé sur ce serveur.');
  }

  // 404 générique pour toute route API inconnue.
  app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));

  // Gestionnaire d'erreurs générique (ex: erreur CORS, JSON invalide).
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    logger.error('Erreur non gérée (web server)', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Erreur interne.' });
  });

  return app;
}

function main() {
  checkEnv();
  const app = buildApp();
  const port = parseInt(process.env.PORT || '3000', 10);
  app.listen(port, () => {
    logger.info(`Serveur Web démarré sur le port ${port}.`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { buildApp };
