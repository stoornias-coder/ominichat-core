// Implémentation OpenRouter de l'interface provider (fournisseur de
// secours optionnel, gardé disponible mais pas actif par défaut).
// Doit exposer exactement : generate(messages, options) -> Promise<string>

const fetch = require('node-fetch');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

async function generate(messages, options = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY manquant dans .env');
  }

  const model = options.model || 'meta-llama/llama-3.1-8b-instruct:free';

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://localhost',
      'X-Title': 'telegram-ai-character-prototype',
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
    throw new Error(`OpenRouter HTTP ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('Réponse OpenRouter vide ou mal formée');
  }

  return content.trim();
}

module.exports = { generate };
