// Logique de POST /api/search, sans dépendance à Express (testable seule).
// Le câblage HTTP est dans routes/search.js.
//
// Contrat :
//   Requête  : POST { text, rewritten?, contextHint?, searchRole?, subject? }  + en-tête X-Tavily-Key
//              searchRole : seule valeur acceptée "canon" (sinon ignoré) ; subject : titre d'œuvre (nettoyé, borné)
//   Réponse  : 200 { ok, triggered, error, text, sources, results, queries, rejectedCount, meta }
//              400 (requête invalide) | 429 (limite atteinte) | 500 (bug inattendu)
//   `text` est un bloc prêt à insérer dans un prompt, SANS titre de niveau 1
//   (l'appelant ajoute le sien). Une recherche qui échoue côté Tavily répond
//   quand même 200 avec ok:false : c'est à l'appelant de décider du repli.
//
// La clé Tavily n'est jamais journalisée ni renvoyée.

const MAX_TEXT_CHARS = 4000;
const MAX_HINT_CHARS = 1000;
const MAX_REWRITTEN_CHARS = 400;
const MAX_SUBJECT_CHARS = 120;
const KEY_RX = /^[\x21-\x7E]{8,200}$/; // ASCII imprimable, sans espace

function createSearchHandler({ webSearch, buildWebSearchBlock, guard, logger }) {
  return async function handleSearch(req, res) {
    const ip = req.ip || 'unknown';

    const verdict = guard.check(ip);
    if (!verdict.allowed) {
      res.set('Retry-After', String(verdict.retryAfterSec));
      return res.status(429).json({ error: 'Trop de requêtes de recherche. Réessaie dans un instant.', retryAfterSec: verdict.retryAfterSec });
    }

    const apiKey = String(req.get('x-tavily-key') || '').trim();
    if (!KEY_RX.test(apiKey)) {
      return res.status(400).json({ error: 'Clé Tavily manquante ou invalide (en-tête X-Tavily-Key).' });
    }

    const body = req.body || {};
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return res.status(400).json({ error: 'Le champ "text" est requis.' });
    }
    if (body.text.length > MAX_TEXT_CHARS) {
      return res.status(400).json({ error: `Le champ "text" est trop long (max ${MAX_TEXT_CHARS} caractères).` });
    }

    const contextHint = typeof body.contextHint === 'string' && body.contextHint.trim()
      ? body.contextHint.slice(0, MAX_HINT_CHARS)
      : undefined;
    // Reformulation déjà faite par l'app (ex. requête anglaise courte) : utilisée
    // telle quelle si le moteur juge la question vague.
    const rewritten = typeof body.rewritten === 'string' ? body.rewritten.trim() : '';
    const queryRewriter = rewritten && rewritten.length <= MAX_REWRITTEN_CHARS
      ? async () => rewritten
      : undefined;

    // searchRole : limité à "canon" pour cette étape (toute autre valeur est ignorée, pas d'erreur).
    const searchRole = body.searchRole === 'canon' ? 'canon' : undefined;
    // subject : texte court, sans caractères de contrôle, espaces normalisés, borné.
    const subjectRaw = typeof body.subject === 'string'
      ? body.subject.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SUBJECT_CHARS).trim()
      : '';
    const subject = subjectRaw || undefined;

    try {
      const result = await webSearch.searchWeb(body.text.trim(), {
        // L'app décide déjà elle-même s'il faut chercher : on exécute.
        skipIntentCheck: true,
        contextHint,
        queryRewriter,
        searchRole,
        subject,
        config: { apiKey },
      });

      if (result.error && result.error.code === 'unauthorized') guard.recordAuthFailure(ip);

      const payload = {
        ok: result.ok,
        triggered: result.triggered,
        error: result.error ? { code: result.error.code, message: result.error.message } : null,
        text: result.triggered ? buildWebSearchBlock(result, { withHeader: false }).trim() : '',
        sources: result.sources,
        results: result.results.map((r) => ({
          id: r.id, title: r.title, url: r.url, domain: r.domain, content: r.content,
          publishedAt: r.publishedAt, freshness: r.freshness, sourceType: r.sourceType, score: r.score,
        })),
        queries: result.queries.map((q) => ({
          id: q.id, query: q.query, topic: q.topic, timeRange: q.timeRange, status: q.status,
          resultCount: q.resultCount, durationMs: q.durationMs, degraded: q.degraded,
          fallbackUnrestricted: q.fallbackUnrestricted, error: q.error ? q.error.code : null,
        })),
        rejectedCount: result.rejected.length,
        meta: result.meta,
      };

      logger.info('Recherche web (app)', {
        ok: payload.ok,
        kept: payload.sources.length,
        errorCode: payload.error ? payload.error.code : null,
        durationMs: result.meta ? result.meta.totalMs : null,
      });
      return res.json(payload);
    } catch (err) {
      logger.error('Erreur inattendue /api/search', err.message);
      return res.status(500).json({ error: 'Erreur interne pendant la recherche.' });
    }
  };
}

module.exports = { createSearchHandler, MAX_TEXT_CHARS };
