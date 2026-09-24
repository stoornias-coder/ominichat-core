'use strict';
// Lancer : node --test "interfaces/**/*.test.js"
// Vrai moteur (core/search/webSearch.js) + vrai bloc de prompt ; Tavily simulé ; pas de réseau.

const test = require('node:test');
const assert = require('node:assert/strict');
const realWebSearch = require('../../../../core/search/webSearch');
const { buildWebSearchBlock } = require('../../../../core/ai/promptBuilder');
const { createSearchGuard } = require('../middleware/searchGuard');
const { createSearchHandler } = require('./searchHandler');

const KEY = 'tvly-ROUTETESTKEY1234567890';
const NOW = new Date('2026-09-24T09:00:00Z');

const mkRes = (status, json) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => JSON.stringify(json), json: async () => json,
  headers: { get: () => null },
});
const tavilyOk = (results) => ({ query: 'q', answer: null, images: [], results, response_time: 0.3 });
const GROQ_HIT = [
  { title: 'Supported Models - GroqCloud', url: 'https://console.groq.com/docs/models', content: 'Groq models available: llama, gpt-oss.', score: 0.8, published_date: 'Mon, 21 Sep 2026 08:00:00 GMT' },
  { title: 'Un vieux forum', url: 'https://www.reddit.com/r/groq/x', content: 'groq models list old', score: 0.6 },
];

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.status = (c) => { r.statusCode = c; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const fakeReq = ({ key = KEY, body = { text: 'Quels sont les modèles Groq disponibles ?' }, ip = '1.2.3.4' } = {}) => ({
  ip, body, get: (h) => (h.toLowerCase() === 'x-tavily-key' ? key : undefined),
});
const silent = { info() {}, error() {}, warn() {} };

// Le vrai moteur, avec Tavily simulé et horloge fixe.
function engineWith(fetchImpl, seen) {
  return {
    searchWeb: (text, o) => { if (seen) seen.push({ text, o }); return realWebSearch.searchWeb(text, { ...o, fetchImpl, now: NOW, logger: silent, config: { ...o.config, debug: false, retryBaseMs: 1 } }); },
  };
}
const build = (fetchImpl, { seen, guard, logger } = {}) =>
  createSearchHandler({ webSearch: engineWith(fetchImpl, seen), buildWebSearchBlock, guard: guard || createSearchGuard(), logger: logger || silent });

// ─────────── Cas nominal ───────────
test('requête valide : bloc prêt à insérer (sans titre H1), sources, requêtes, sans fuite de clé', async () => {
  const sent = [];
  const logs = [];
  const handler = build(async (u, init) => { sent.push({ u, init, body: JSON.parse(init.body) }); return mkRes(200, tavilyOk(GROQ_HIT)); }, { logger: { info: (...a) => logs.push(a), error: (...a) => logs.push(a), warn: (...a) => logs.push(a) } });
  const res = fakeRes();
  await handler(fakeReq(), res);

  assert.equal(res.statusCode, 200);
  const b = res.body;
  assert.equal(b.ok, true);
  assert.equal(b.sources[0].domain, 'console.groq.com');
  assert.equal(b.sources[0].sourceType, 'official');
  assert.match(b.text, /## \[S1\] Supported Models - GroqCloud/);
  assert.match(b.text, /RÈGLES D'USAGE DE CES SOURCES/);
  assert.ok(!/^# /m.test(b.text), 'aucun titre de niveau 1 (l\'app ajoute le sien)');
  assert.match(b.text, /^Recherche effectuée le 2026-09-24\./);
  assert.equal(b.queries[0].topic, 'general');
  // Tavily a reçu la clé de l'appelant, en en-tête
  assert.equal(sent[0].init.headers.Authorization, `Bearer ${KEY}`);
  // La clé ne sort jamais : ni dans la réponse, ni dans les logs
  assert.ok(!JSON.stringify(b).includes(KEY));
  assert.ok(!JSON.stringify(logs).includes(KEY));
});

test('la recherche est exécutée même sans mot déclencheur (l\'app a déjà décidé)', async () => {
  const seen = [];
  const handler = build(async () => mkRes(200, tavilyOk(GROQ_HIT)), { seen });
  const res = fakeRes();
  await handler(fakeReq({ body: { text: 'Raconte-moi une histoire de dragons' } }), res);
  assert.equal(seen[0].o.skipIntentCheck, true);
  assert.equal(res.body.triggered, true);
});

test('reformulation fournie par l\'app : utilisée pour une question vague', async () => {
  const bodies = [];
  const handler = build(async (u, init) => { bodies.push(JSON.parse(init.body)); return mkRes(200, tavilyOk(GROQ_HIT)); });
  await handler(fakeReq({ body: { text: 'un vieux film genre avec un chien lol', rewritten: 'old dog movie' } }), fakeRes());
  assert.equal(bodies[0].query, 'old dog movie');
});

test('question de suivi : contextHint transmis au moteur', async () => {
  const seen = [];
  const handler = build(async () => mkRes(200, tavilyOk(GROQ_HIT)), { seen });
  await handler(fakeReq({ body: { text: 'et le prix ?', contextHint: 'Parle-moi de Groq' } }), fakeRes());
  assert.equal(seen[0].o.contextHint, 'Parle-moi de Groq');
});

// ─────────── Validation ───────────
test('validation : clé absente, clé malformée, texte absent ou trop long → 400', async () => {
  const handler = build(async () => mkRes(200, tavilyOk([])));
  for (const [label, req] of [
    ['clé absente', fakeReq({ key: '' })],
    ['clé trop courte', fakeReq({ key: 'abc' })],
    ['clé avec espace', fakeReq({ key: 'tvly abcdefgh1234' })],
    ['texte absent', fakeReq({ body: {} })],
    ['texte vide', fakeReq({ body: { text: '   ' } })],
    ['texte non-string', fakeReq({ body: { text: 42 } })],
    ['texte trop long', fakeReq({ body: { text: 'a'.repeat(4001) } })],
  ]) {
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400, label);
  }
});

// ─────────── Erreurs Tavily : 200 + ok:false, à l'appelant de décider ───────────
test('Tavily en panne : 200 avec ok:false et code d\'erreur, jamais de 500', async () => {
  const handler = build(async () => mkRes(500, { detail: { error: 'boom' } }));
  const res = fakeRes();
  await handler(fakeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'server_error');
});

test('moteur qui plante : 500 générique, sans détail ni clé', async () => {
  const handler = createSearchHandler({
    webSearch: { searchWeb: async () => { throw new Error(`boom ${KEY}`); } },
    buildWebSearchBlock, guard: createSearchGuard(), logger: silent,
  });
  const res = fakeRes();
  await handler(fakeReq(), res);
  assert.equal(res.statusCode, 500);
  assert.ok(!JSON.stringify(res.body).includes(KEY));
});

// ─────────── Limiteur ───────────
test('limiteur : cadence par IP, Retry-After, autres IP non affectées', async () => {
  let t = 1_000_000;
  const guard = createSearchGuard({ perMinute: 3, now: () => t });
  const handler = build(async () => mkRes(200, tavilyOk(GROQ_HIT)), { guard });
  for (let i = 0; i < 3; i++) { const r = fakeRes(); await handler(fakeReq(), r); assert.equal(r.statusCode, 200); }
  const blocked = fakeRes(); await handler(fakeReq(), blocked);
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers['Retry-After']) >= 1);
  const other = fakeRes(); await handler(fakeReq({ ip: '9.9.9.9' }), other);
  assert.equal(other.statusCode, 200);
  t += 61_000; // la fenêtre expire
  const later = fakeRes(); await handler(fakeReq(), later);
  assert.equal(later.statusCode, 200);
});

test('limiteur : après 5 clés refusées, l\'IP est bloquée (anti test de clés volées)', async () => {
  let t = 5_000_000;
  const guard = createSearchGuard({ perMinute: 100, maxAuthFailures: 5, now: () => t });
  const handler = build(async () => mkRes(401, { detail: { error: 'Unauthorized: missing or invalid API key.' } }), { guard });
  for (let i = 0; i < 5; i++) {
    const r = fakeRes(); await handler(fakeReq({ key: `tvly-BAD-KEY-NUMBER-${i}-xxxxxx` }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.error.code, 'unauthorized');
  }
  const blocked = fakeRes(); await handler(fakeReq({ key: 'tvly-SIXTH-KEY-ATTEMPT-xxxxxx' }), blocked);
  assert.equal(blocked.statusCode, 429);
  const other = fakeRes(); await handler(fakeReq({ ip: '8.8.4.4' }), other);
  assert.notEqual(other.statusCode, 429, 'une autre IP n\'est pas bloquée');
  t += 16 * 60 * 1000; // fenêtre de 15 min écoulée
  const later = fakeRes(); await handler(fakeReq(), later);
  assert.notEqual(later.statusCode, 429);
});

test('limiteur : la table en mémoire reste bornée et se purge', () => {
  let t = 1;
  const guard = createSearchGuard({ perMinute: 5, now: () => t });
  for (let i = 0; i < 5100; i++) guard.check(`10.0.${Math.floor(i / 250)}.${i % 250}`);
  assert.ok(guard._size() > 5000);
  t += 120_000;
  guard.check('1.1.1.1'); // déclenche la purge des entrées expirées
  assert.ok(guard._size() < 10);
});
