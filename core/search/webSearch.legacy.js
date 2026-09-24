// Capacité de recherche Internet, volontairement séparée du modèle IA
// (voir architecture : Backend décide, pas le modèle qui "prétend" avoir
// Internet). Découpée en 2 étapes :
//   1. needsWebSearch()   -> heuristique gratuite, sans appel API, pour
//                            décider si CE message a besoin d'une recherche.
//   2. performWebSearch() -> exécute la recherche via Tavily (free tier).
//
// Comportement en cas d'échec ou de clé absente : ne bloque JAMAIS la
// réponse. On retourne simplement `null`, et le modèle reçoit la même
// consigne qu'avant ("dis-le honnêtement plutôt que d'inventer").

const fetch = require('node-fetch');
const logger = require('../utils/logger');

const SEARCH_TRIGGER_KEYWORDS = [
  'aujourd\'hui', 'actualité', 'actualites', 'dernière version', 'derniere version',
  'en ce moment', 'récemment', 'recemment', 'prix de', 'combien coûte', 'combien coute',
  'disponible', 'sorti en', 'météo', 'meteo', 'cours de', 'résultat', 'resultat',
  'qui est le président', 'qui est le premier ministre', 'cette semaine', 'ce mois',
  'nouvelles de', 'update', 'dernières nouvelles', 'dernieres nouvelles',
];

function needsWebSearch(userText) {
  const normalized = (userText || '').toLowerCase();
  return SEARCH_TRIGGER_KEYWORDS.some((kw) => normalized.includes(kw));
}

const TAVILY_URL = 'https://api.tavily.com/search';
const TAVILY_TIMEOUT_MS = parseInt(process.env.TAVILY_TIMEOUT_MS || '8000', 10);
const TAVILY_MAX_RESULTS = parseInt(process.env.TAVILY_MAX_RESULTS || '4', 10);

// Formate la réponse Tavily en un bloc texte compact, injectable tel quel
// dans le prompt système (voir core/ai/promptBuilder.js -> searchBlock).
function formatTavilyResult(data) {
  const parts = [];

  if (data.answer) {
    parts.push(`Résumé : ${data.answer}`);
  }

  const results = Array.isArray(data.results) ? data.results.slice(0, TAVILY_MAX_RESULTS) : [];
  for (const r of results) {
    if (r?.title && r?.content) {
      const snippet = r.content.length > 300 ? `${r.content.slice(0, 300)}…` : r.content;
      parts.push(`- ${r.title} : ${snippet}`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

async function performWebSearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    logger.warn('TAVILY_API_KEY manquant : recherche web ignorée pour ce message.');
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS);

  try {
    const response = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: TAVILY_MAX_RESULTS,
        include_answer: true,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Tavily HTTP ${response.status}: ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    return formatTavilyResult(data);
  } catch (err) {
    // Une recherche web ratée ne doit jamais faire échouer la réponse du
    // personnage : on log et on continue sans résultats (comportement
    // identique à l'ancien stub qui renvoyait toujours null).
    logger.error('Erreur recherche web (Tavily)', err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { needsWebSearch, performWebSearch };
