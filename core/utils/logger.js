// Logger minimal. N'affiche jamais de clés API ou de secrets.

const SENSITIVE_KEYS = ['token', 'key', 'secret', 'authorization'];

function scrub(value) {
  if (typeof value !== 'string') return value;
  // Masque toute chaîne qui ressemble à une clé API longue.
  return value.replace(/[A-Za-z0-9_\-]{24,}/g, '[REDACTED]');
}

function safeArgs(args) {
  return args.map((a) => {
    if (a instanceof Error) return `${a.name}: ${scrub(a.message)}`;
    if (typeof a === 'object' && a !== null) {
      try {
        const clone = JSON.parse(JSON.stringify(a));
        for (const k of Object.keys(clone)) {
          if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s))) {
            clone[k] = '[REDACTED]';
          }
        }
        return clone;
      } catch {
        return a;
      }
    }
    return scrub(a);
  });
}

const logger = {
  info: (...args) => console.log('[INFO]', ...safeArgs(args)),
  warn: (...args) => console.warn('[WARN]', ...safeArgs(args)),
  error: (...args) => console.error('[ERROR]', ...safeArgs(args)),
  debug: (...args) => {
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[DEBUG]', ...safeArgs(args));
    }
  },
};

module.exports = logger;
