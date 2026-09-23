// Implémentation Gemini de l'interface provider, via la couche de
// compatibilité OpenAI de Google (mêmes formats de requête/réponse que
// Groq/OpenRouter, donc code quasi identique).
// Doit exposer exactement : generate(messages, options) -> Promise<string>

const fetch = require('node-fetch');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

async function generate(messages, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY manquant dans .env');
  }

  // Vérifie les modèles à jour sur ai.google.dev/gemini-api/docs/models
  const model = options.model || 'gemini-2.0-flash';

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0.8,
      max_tokens: options.maxTokens ?? 600,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini HTTP ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('Réponse Gemini vide ou mal formée');
  }

  return content.trim();
}

module.exports = { generate };
