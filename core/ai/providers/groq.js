// Implémentation Groq de l'interface provider.
// Doit exposer exactement : generate(messages, options) -> Promise<string>

const fetch = require('node-fetch');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function generate(messages, options = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY manquant dans .env');
  }

  // Vérifie les modèles disponibles pour ton compte : console.groq.com/docs/models
  const model = options.model || 'openai/gpt-oss-120b';

  const response = await fetch(GROQ_URL, {
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
    throw new Error(`Groq HTTP ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('Réponse Groq vide ou mal formée');
  }

  return content.trim();
}

module.exports = { generate };
