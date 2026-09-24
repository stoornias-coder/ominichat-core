// Garde-fou de POST /api/search (recherche web fournie à l'app OmniChat).
//
// Cette route est protégée par la clé Tavily de l'appelant (en-tête X-Tavily-Key)
// et non par un login : sans contrôle, elle pourrait servir à tester en masse
// des clés Tavily volées (la réponse distingue clé valide / invalide). Deux limites,
// en mémoire (une seule instance suffit ici ; elles repartent à zéro au redéploiement) :
//   1. cadence           : au plus `perMinute` requêtes par minute et par adresse IP ;
//   2. clés refusées     : au plus `maxAuthFailures` refus "clé invalide" par
//      `failWindowMs` et par adresse IP, sinon l'adresse est bloquée jusqu'à la fin
//      de la fenêtre.
// Aucune donnée n'est conservée en dehors de compteurs horodatés (jamais de clé).

function createSearchGuard({
  perMinute = 20,
  maxAuthFailures = 5,
  failWindowMs = 15 * 60 * 1000,
  now = Date.now,
} = {}) {
  const WINDOW_MS = 60 * 1000;
  const MAX_TRACKED = 5000; // borne mémoire : au-delà, on purge les entrées expirées
  const table = new Map(); // ip -> { hits: number[], fails: number[] }

  function entry(ip) {
    let e = table.get(ip);
    if (!e) { e = { hits: [], fails: [] }; table.set(ip, e); }
    return e;
  }

  function prune(t) {
    for (const [ip, e] of table) {
      e.hits = e.hits.filter((x) => t - x < WINDOW_MS);
      e.fails = e.fails.filter((x) => t - x < failWindowMs);
      if (!e.hits.length && !e.fails.length) table.delete(ip);
    }
  }

  return {
    check(ip) {
      const t = now();
      if (table.size > MAX_TRACKED) prune(t);
      const e = entry(ip);
      e.hits = e.hits.filter((x) => t - x < WINDOW_MS);
      e.fails = e.fails.filter((x) => t - x < failWindowMs);

      if (e.fails.length >= maxAuthFailures) {
        const retryAfterSec = Math.max(1, Math.ceil((e.fails[0] + failWindowMs - t) / 1000));
        return { allowed: false, retryAfterSec, reason: 'too_many_invalid_keys' };
      }
      if (e.hits.length >= perMinute) {
        const retryAfterSec = Math.max(1, Math.ceil((e.hits[0] + WINDOW_MS - t) / 1000));
        return { allowed: false, retryAfterSec, reason: 'rate_limited' };
      }
      e.hits.push(t);
      return { allowed: true, retryAfterSec: 0, reason: null };
    },
    recordAuthFailure(ip) {
      entry(ip).fails.push(now());
    },
    _size: () => table.size,
  };
}

module.exports = { createSearchGuard };
