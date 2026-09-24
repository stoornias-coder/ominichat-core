// POST /api/search — recherche web pour l'app OmniChat (frontend).
// Voir searchHandler.js pour le contrat. Pas de login : la route est protégée
// par la clé Tavily de l'appelant + un limiteur (middleware/searchGuard.js).

const express = require('express');
const webSearch = require('../../../../core/search/webSearch');
const { buildWebSearchBlock } = require('../../../../core/ai/promptBuilder');
const logger = require('../../../../core/utils/logger');
const { createSearchGuard } = require('../middleware/searchGuard');
const { createSearchHandler } = require('./searchHandler');

function envInt(name, def, min, max) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

const guard = createSearchGuard({
  perMinute: envInt('SEARCH_RATE_LIMIT_PER_MIN', 20, 1, 600),
  maxAuthFailures: envInt('SEARCH_MAX_INVALID_KEYS', 5, 1, 100),
});

const router = express.Router();
router.post('/', createSearchHandler({ webSearch, buildWebSearchBlock, guard, logger }));

module.exports = router;
