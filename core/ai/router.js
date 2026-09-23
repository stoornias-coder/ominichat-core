// Point d'entrée UNIQUE pour tout le reste de l'application. Rien d'autre
// dans le code ne doit importer un provider directement.
//
//   Application → generateAIResponse() → provider choisi (env) → modèle
//
// Fournisseur et modèle pilotés uniquement par variables d'environnement :
//   AI_PROVIDER=groq          AI_MODEL=openai/gpt-oss-120b
//   AI_PROVIDER_FALLBACK=gemini   AI_MODEL_FALLBACK=gemini-2.0-flash

const logger = require('../utils/logger');

const providers = {
  groq: require('./providers/groq'),
  gemini: require('./providers/gemini'),
  openrouter: require('./providers/openrouter'),
};

function resolveProvider(name) {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Fournisseur IA inconnu ou non implémenté : "${name}"`);
  }
  return provider;
}

/**
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
 * @param {{ temperature?: number, maxTokens?: number }} options
 * @returns {Promise<string>} la réponse texte brute du modèle
 */
async function generateAIResponse(messages, options = {}) {
  const primaryName = process.env.AI_PROVIDER || 'groq';
  const primaryModel = process.env.AI_MODEL;

  const fallbackName = process.env.AI_PROVIDER_FALLBACK || null;
  const fallbackModel = process.env.AI_MODEL_FALLBACK || null;

  try {
    const provider = resolveProvider(primaryName);
    return await provider.generate(messages, { ...options, model: primaryModel });
  } catch (primaryError) {
    logger.error(`Échec du fournisseur principal "${primaryName}"`, primaryError.message);

    if (!fallbackName) throw primaryError;

    try {
      logger.warn(`Tentative avec le fournisseur de secours "${fallbackName}"`);
      const fallbackProvider = resolveProvider(fallbackName);
      return await fallbackProvider.generate(messages, { ...options, model: fallbackModel });
    } catch (fallbackError) {
      logger.error(`Échec du fournisseur de secours "${fallbackName}"`, fallbackError.message);
      throw fallbackError;
    }
  }
}

module.exports = { generateAIResponse };
