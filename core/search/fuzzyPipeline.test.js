'use strict';
// Lancer : node --test core/search/fuzzyPipeline.test.js
// ÉTAPE A — pipeline d'identification floue : le candidat confirmé par assessFuzzyResults()
// doit survivre à processResults(). 100 % hors-ligne (Tavily simulé), aucune clé réelle.

const test = require('node:test');
const assert = require('node:assert/strict');
const ws = require('./webSearch.js');
const I = ws._internal;

const NOW = new Date('2026-09-23T12:00:00Z');
const CFG = { minScore: 0.1, maxTotalResults: 8 };
const MSG = "Il y a un film coréen où Robin est le patron du personnage féminin, il parlait toujours anglais, années 2000, mais j'ai oublié le titre.";
const CONFIRMING = 'Korean movie from 2006. Robin is the male lead character, the boss of the female lead, and speaks English at work.';
const GENERIC = (n) => `A long article about korean movies, boss characters, english subtitles and many unrelated details, number ${n}.`;

const ctxOf = () => I.detectFuzzyIdentification(MSG, null, null);
const plan3 = [{ id: 1, original: 'q1' }, { id: '1f2', original: 'q2' }, { id: '1f3', original: 'q3' }];

function mk(o) {
  return {
    id: null, title: o.title, url: o.url || `https://${o.domain}/${encodeURIComponent(o.title)}`, domain: o.domain,
    content: o.content, rawContent: null, score: o.score ?? 0.5, publishedAt: null, ageDays: null, freshness: 'unknown',
    favicon: null, sourceType: ws.classifySource(o.domain), preferred: false, authoritative: false,
    queryIds: o.queryIds || [1], suspicious: !!o.suspicious,
  };
}
// Miroir de la règle de production : le candidat n'est épinglé que si l'identification est CONFIRMÉE (verdict.ok === true).
const fuzzyOpts = (verdict, fc) => ({ pinned: verdict && verdict.ok ? verdict.candidate : null, isIncompatible: (r) => I.fuzzyResultIsIncompatible(r, fc) });
// Domaine non « communautaire » : une source isolée de fiabilité > 0 peut confirmer seule (voir soleWeakSource).
const STRONG_DOMAIN = 'asianwiki.com';

// ─────────────── 1. Détection du contexte (Robin) ───────────────

test('Robin : film coréen, personnage Robin, patron, anglais, années 2000', () => {
  const fc = ctxOf();
  assert.ok(fc, 'identification floue détectée');
  assert.equal(fc.geoLabel, 'korean');
  assert.ok(fc.names.includes('Robin'));
  assert.ok(fc.role.some((r) => r.label === 'boss'));
  assert.ok(fc.language.some((l) => l.label === 'English'));
  assert.ok(fc.format.some((f) => f.label === 'film'));
  assert.equal(fc.time.label, '2000s');
});

// ─────────────── 2. Année explicitement incompatible ───────────────

test('année : un candidat explicitement 2025 pour "années 2000" est rejeté et ne peut pas être résultat principal', () => {
  const fc = ctxOf();
  const y25 = mk({ domain: 'en.wikipedia.org', title: 'Korean Film 2025 - Cast', content: 'Korean film released in 2025. Robin is the boss character and speaks English with the female lead.', score: 0.9 });
  const good = mk({ domain: STRONG_DOMAIN, title: 'Seducing Mr. Perfect thread', content: CONFIRMING, score: 0.4, queryIds: ['1f2'] });
  assert.equal(I.assessFuzzyResults([y25], fc).candidate, null, '2025 seul : aucun candidat');
  assert.equal(I.fuzzyResultIsIncompatible(y25, fc), true);
  assert.equal(I.fuzzyResultIsIncompatible(good, fc), false);

  const verdict = I.assessFuzzyResults([y25, good], fc);
  assert.equal(verdict.candidate, good);
  assert.equal(verdict.ok, true);
  const plan = [{ id: 1, original: 'q1' }, { id: '1f2', original: 'q2' }];
  const out = I.processResults([{ item: plan[0], results: [y25] }, { item: plan[1], results: [good] }], plan, CFG, fuzzyOpts(verdict, fc));
  assert.equal(out.kept[0].title, good.title, 'le candidat compatible est S1');
  assert.notEqual(out.kept[0].title, y25.title);
});

test('année : sans candidat, un résultat incompatible passe après les compatibles (jamais S1 tant qu\'un autre existe)', () => {
  const fc = ctxOf();
  const y25 = mk({ domain: 'en.wikipedia.org', title: 'Korean Film 2025 - Cast', content: 'Korean film released in 2025 with a boss character and many unrelated details of all kinds.', score: 0.9 });
  const neutral = mk({ domain: 'reddit.com', title: 'Korean film thread', content: 'Korean film discussion, boss characters, 2006 release and many unrelated details of all kinds.', score: 0.5 });
  const plan = [{ id: 1, original: 'q1' }];
  const out = I.processResults([{ item: plan[0], results: [y25, neutral] }], plan, CFG, fuzzyOpts(null, fc));
  assert.equal(out.kept[0].title, neutral.title);
  assert.equal(out.kept[1].title, y25.title, 'non supprimé (fail-open), seulement relégué');
});

// ─────────────── 3. Géographie explicitement contredite ───────────────

test('géo : "Not a Korean film" est incompatible avec geo=korean (resultMatchesClues + assess)', () => {
  const fc = ctxOf();
  const notK = mk({ domain: 'mydramalist.com', title: 'Some Film - Cast', content: 'Robin is the boss character in this film. Not a Korean film: it is a Japanese production, released in 2004, in which Robin speaks English.' });
  assert.equal(I.resultContradictsGeo(notK, fc), true);
  assert.equal(I.resultMatchesClues(notK, fc), false);
  const v = I.assessFuzzyResults([notK], fc);
  assert.equal(v.candidate, null);
  assert.equal(v.onTopic, 0);
});

test('géo : détection générique (autres pays/adjectifs, FR/EN), sans mot en dur', () => {
  const ctxFor = (msg) => I.detectFuzzyIdentification(msg, null, null);
  const jp = ctxFor("Il y a un film japonais où Kenji est le patron, j'ai oublié le titre.");
  const fr = ctxFor("Il y a un film français où Pierre est le patron, j'ai oublié le titre.");
  const T = (ctx, content) => I.resultContradictsGeo(mk({ domain: 'example.org', title: 'Fiche', content }), ctx);
  assert.equal(jp.geoLabel, 'japanese');
  assert.equal(T(jp, "Kenji is the boss. This is not a Japanese drama, it is a Korean production from 2003."), true);
  assert.equal(T(fr, "Pierre est le patron. Ce n'est pas un film français mais une coproduction belge de 2003."), true);
  // Non-régressions : pas de faux positif
  assert.equal(T(jp, "Kenji is the boss. A Japanese film, not a drama, released in 2003."), false, 'la négation porte sur le format');
  assert.equal(T(jp, "Kenji is the boss. Not only Japanese audiences loved this film from 2003."), false, '"not only" n\'est pas une négation');
  assert.equal(T(jp, "Kenji is the boss. Not a Japanese remake: this Japanese original dates from 2003."), false, 'une mention positive subsiste');
});

// ─────────────── 4. Même URL, plusieurs extraits ───────────────

test('extrait : pour une même URL, l\'extrait qui a confirmé le candidat est conservé', () => {
  const fc = ctxOf();
  const url = 'https://mydramalist.com/seducing-mr-perfect';
  const informative = mk({ domain: 'mydramalist.com', url, title: 'Seducing Mr. Perfect - Cast', score: 0.45, queryIds: ['1f2'], content: CONFIRMING });
  const poor = mk({ domain: 'mydramalist.com', url, title: 'Seducing Mr. Perfect - Cast', score: 0.9, queryIds: [1], content: 'Seducing Mr. Perfect (2006). Directed by a well known director, produced by a large studio, runtime 110 minutes.' });
  const verdict = I.assessFuzzyResults([poor, informative], fc);
  assert.equal(verdict.candidate, informative);
  assert.equal(verdict.ok, true);
  const plan = [{ id: 1, original: 'q1' }, { id: '1f2', original: 'q2' }];
  const out = I.processResults([{ item: plan[0], results: [poor] }, { item: plan[1], results: [informative] }], plan, CFG, fuzzyOpts(verdict, fc));
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].content, CONFIRMING);
  assert.deepEqual([...out.kept[0].queryIds].sort(), ['1f2', 1].sort(), 'les queryIds des deux extraits sont fusionnés');
});

// ─────────────── 5. domain_cap / over_limit ───────────────

test('domain_cap : un candidat confirmé ne disparaît pas, et le plafond reste appliqué aux autres', () => {
  const fc = ctxOf();
  const cand = mk({ domain: 'mydramalist.com', title: 'Seducing Mr. Perfect - Cast', score: 0.4, queryIds: ['1f2'], content: CONFIRMING });
  const fillers = [1, 2, 3, 4].map((i) => mk({ domain: 'mydramalist.com', title: `Other Korean Film ${i} - Cast`, score: 0.9 - i * 0.01, queryIds: [1], content: `Korean movie ${i} with a cast list, a synopsis and reviews from many users. Robin is mentioned as a character name in the cast.` }));
  const verdict = I.assessFuzzyResults([...fillers, cand], fc);
  assert.equal(verdict.candidate, cand);
  assert.equal(verdict.ok, true);
  const plan = [{ id: 1, original: 'q1' }, { id: '1f2', original: 'q2' }];
  const perQuery = [{ item: plan[0], results: fillers }, { item: plan[1], results: [cand] }];
  const out = I.processResults(perQuery, plan, CFG, fuzzyOpts(verdict, fc));
  assert.ok(out.kept.some((r) => r.title === cand.title), 'candidat conservé');
  assert.equal(out.kept.filter((r) => r.domain === 'mydramalist.com').length, 3, 'plafond par domaine toujours à 3');
  assert.ok(out.rejected.some((r) => r.reason === 'domain_cap'));
});

test('over_limit : un candidat confirmé ne disparaît pas, le plafond total reste appliqué', () => {
  const fc = ctxOf();
  const batch = (qid, pfx) => Array.from({ length: 5 }, (_, i) => mk({ domain: `${pfx}${i}.example`, title: `${pfx} korean movie ${i}`, score: 0.8 - i * 0.02, queryIds: [qid], content: GENERIC(i) }));
  const wiki = (qid, i) => mk({ domain: 'en.wikipedia.org', title: `Wikipedia list ${qid}-${i}`, score: 0.6, queryIds: [qid], content: 'Wikipedia list of films, including korean movies, with english titles and boss characters somewhere.' });
  const cand = mk({ domain: STRONG_DOMAIN, title: 'Seducing Mr. Perfect thread', score: 0.4, queryIds: ['1f2'], content: CONFIRMING });
  const q1 = [...batch(1, 'a'), wiki(1, 1)];
  const q2 = [wiki('1f2', 1), wiki('1f2', 2), wiki('1f2', 3), cand];
  const q3 = batch('1f3', 'c');
  const verdict = I.assessFuzzyResults([...q1, ...q2, ...q3], fc);
  assert.equal(verdict.candidate, cand);
  assert.equal(verdict.ok, true);
  const perQuery = [{ item: plan3[0], results: q1 }, { item: plan3[1], results: q2 }, { item: plan3[2], results: q3 }];
  const out = I.processResults(perQuery, plan3, CFG, fuzzyOpts(verdict, fc));
  assert.equal(out.kept.length, 8, 'plafond total inchangé');
  assert.equal(out.kept[0].title, cand.title, 'candidat confirmé en tête');
  assert.ok(out.rejected.some((r) => r.reason === 'over_limit'));
});

test('sécurité : un candidat suspect (injection) reste rejeté même épinglé', () => {
  const fc = ctxOf();
  const cand = mk({ domain: 'reddit.com', title: 'Seducing Mr. Perfect thread', content: CONFIRMING, suspicious: true });
  const plan = [{ id: 1, original: 'q1' }];
  const out = I.processResults([{ item: plan[0], results: [cand] }], plan, CFG, { pinned: cand, isIncompatible: (r) => I.fuzzyResultIsIncompatible(r, fc) });
  assert.equal(out.kept.length, 0);
  assert.ok(out.rejected.some((r) => r.reason === 'suspicious_content'));
});

// ─────────────── 5bis. Candidat incertain (ok === false) : jamais épinglé ───────────────

test('candidat incertain (ok:false) : non épinglé, non promu en S1, mais pas supprimé sans raison', () => {
  const fc = ctxOf();
  // Source communautaire isolée : assessFuzzyResults() retourne un candidat mais ok === false (soleWeakSource).
  const weak = mk({ domain: 'reddit.com', title: 'Seducing Mr. Perfect thread', score: 0.4, queryIds: [1], content: CONFIRMING });
  const strongerRank = mk({ domain: 'en.wikipedia.org', title: 'Wikipedia list of films', score: 0.8, queryIds: [1], content: 'Wikipedia list of films, including korean movies, with english titles and boss characters somewhere.' });
  const verdict = I.assessFuzzyResults([weak, strongerRank], fc);
  assert.equal(verdict.candidate, weak, 'un candidat existe');
  assert.equal(verdict.ok, false, 'mais il n\'est pas confirmé');
  const opts = fuzzyOpts(verdict, fc);
  assert.equal(opts.pinned, null, 'la règle de production ne l\'épingle pas');
  const plan = [{ id: 1, original: 'q1' }];
  const out = I.processResults([{ item: plan[0], results: [weak, strongerRank] }], plan, CFG, opts);
  assert.notEqual(out.kept[0].title, weak.title, 'pas artificiellement placé en S1 (rang de source normal)');
  assert.ok(out.kept.some((r) => r.title === weak.title), 'reste dans les résultats quand la place le permet');
});

test('bout en bout : candidat incertain (ok:false) => extendFuzzyIdentification ne l\'épingle pas et searchWeb ne le promeut pas en S1', async () => {
  const wiki = (i) => ({ domain: 'en.wikipedia.org', title: `Wikipedia list ${i}`, score: 0.6, content: 'Wikipedia list of films, including korean movies, with english titles and boss characters somewhere.' });
  const weak = { domain: 'reddit.com', title: 'Seducing Mr. Perfect thread', score: 0.4, content: CONFIRMING };
  let call = 0;
  const fetchImpl = async () => { call++; return mkRes(200, { results: (call === 1 ? [wiki(call), weak] : [wiki(call)]).map(asRaw) }); };
  const r = await ws.searchWeb(MSG, { fetchImpl, now: NOW, logger: silent, skipIntentCheck: true, config: baseCfg });
  assert.equal(r.meta.fuzzy.confirmed, false);
  assert.equal(r.meta.fuzzy.candidateTitle, weak.title, 'candidat connu mais incertain');
  assert.notEqual(r.results[0].title, weak.title, 'pas de promotion artificielle en S1');
  assert.ok(r.results.every((x) => x.corroboration === 'unverifiable'), 'statut d\'incertitude conservé sur tous les résultats');
});

test('extendFuzzyIdentification : candidate exposé seulement si ok === true', async () => {
  const fc = ctxOf();
  const good = mk({ domain: STRONG_DOMAIN, title: 'Seducing Mr. Perfect thread', queryIds: [1], content: CONFIRMING });
  const weak = mk({ domain: 'reddit.com', title: 'Seducing Mr. Perfect thread', queryIds: [1], content: CONFIRMING });
  const runOf = (r) => ({ item: { id: 1, original: 'q1', query: 'q1' }, info: { status: 'ok', attempts: 1 }, results: [r], answer: null });
  const args = (r) => ({ message: MSG, fuzzyCtx: fc, plan: [{ id: 1, original: 'q1', query: 'q1', officialDomains: [], entities: [] }], runs: [runOf(r)], cfg: { apiKey: 'x' }, log: { debug() {}, warn() {} }, ctx: {} });
  const a = await I.extendFuzzyIdentification(args(good));
  assert.equal(a.candidate, good, 'ok:true => candidat transmis');
  const b = await I.extendFuzzyIdentification({ ...args(weak), runs: [{ ...runOf(weak), info: { status: 'ok', attempts: 3 } }] }); // budget épuisé : pas d'appel réseau
  assert.equal(b.candidate, null, 'ok:false => aucun candidat épinglable');
  assert.equal(b.meta.finalOk, false);
});

// ─────────────── 6. Recherches normales non-fuzzy inchangées ───────────────

test('non-fuzzy : processResults sans options == options vides, et les plafonds restent appliqués', () => {
  const same = Array.from({ length: 5 }, (_, i) => mk({ domain: 'blog.example', title: `Article ${i}`, score: 0.9 - i * 0.05, content: `Contenu de l'article numéro ${i} avec suffisamment de texte pour passer les filtres.` }));
  const others = Array.from({ length: 8 }, (_, i) => mk({ domain: `s${i}.example`, title: `Autre ${i}`, score: 0.5 - i * 0.02, content: `Un autre contenu numéro ${i} avec suffisamment de texte pour passer les filtres.` }));
  const plan = [{ id: 1, original: 'article contenu texte' }];
  const clone = (arr) => arr.map((r) => ({ ...r, queryIds: [...r.queryIds] }));
  const a = I.processResults([{ item: plan[0], results: clone([...same, ...others]) }], plan, CFG);
  const b = I.processResults([{ item: plan[0], results: clone([...same, ...others]) }], plan, CFG, {});
  const c = I.processResults([{ item: plan[0], results: clone([...same, ...others]) }], plan, CFG, undefined);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  assert.equal(a.kept.length, 8);
  assert.ok(a.rejected.some((r) => r.reason === 'domain_cap'));
  assert.ok(a.rejected.some((r) => r.reason === 'over_limit'));
});

// ─────────────── 7. Bout en bout (searchWeb avec Tavily simulé) ───────────────

const mkRes = (status, json) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json), headers: { get: () => null } });
const silent = { log() {}, warn() {}, error() {} };
const baseCfg = { apiKey: 'tvly-FAKE1234567890', debug: false, retryBaseMs: 1 };
const asRaw = (r) => ({ title: r.title, url: r.url || `https://${r.domain}/${encodeURIComponent(r.title)}`, content: r.content, score: r.score });

test('bout en bout : le candidat confirmé survit à processResults et le contrat meta.fuzzy est inchangé', async () => {
  const gen = (pfx) => Array.from({ length: 5 }, (_, i) => ({ domain: `${pfx}${i}.example`, title: `${pfx} korean movie ${i}`, score: 0.8 - i * 0.02, content: GENERIC(i) + ' film' }));
  const wiki = (i) => ({ domain: 'en.wikipedia.org', title: `Wikipedia list ${i}`, score: 0.6, content: 'Wikipedia list of films, including korean movies, with english titles and boss characters somewhere.' });
  const cand = { domain: STRONG_DOMAIN, title: 'Seducing Mr. Perfect thread', score: 0.4, content: CONFIRMING };
  const batches = [gen('a'), [wiki(1), wiki(2), wiki(3), cand], gen('c')];
  let call = 0;
  const fetchImpl = async () => mkRes(200, { results: batches[Math.min(call++, 2)].map(asRaw) });
  const r = await ws.searchWeb(MSG, { fetchImpl, now: NOW, logger: silent, skipIntentCheck: true, config: baseCfg });
  assert.equal(r.results.length, 8);
  assert.equal(r.results[0].title, cand.title, 'candidat confirmé en S1');
  assert.equal(r.results[0].id, 'S1');
  assert.equal(r.meta.fuzzy.confirmed, true);
  assert.deepEqual(Object.keys(r.meta.fuzzy).sort(), ['attempts', 'candidateTitle', 'confirmed', 'onTopic', 'triggered']);
  assert.ok(!('candidate' in r.meta.fuzzy) && !('candidate' in r.meta));
});

test('bout en bout : même URL sur deux requêtes, l\'extrait confirmant est celui restitué', async () => {
  const url = 'https://mydramalist.com/seducing-mr-perfect';
  const poor = { title: 'Seducing Mr. Perfect - Cast', url, score: 0.9, content: 'Seducing Mr. Perfect (2006). Directed by a well known director, produced by a large studio, runtime 110 minutes.' };
  const informative = { title: 'Seducing Mr. Perfect - Cast', url, score: 0.45, content: CONFIRMING };
  const noise = Array.from({ length: 4 }, (_, i) => ({ title: `Noise ${i}`, url: `https://n${i}.example/x`, score: 0.5, content: GENERIC(i) }));
  const batches = [[poor, ...noise], [informative, ...noise.map((n) => ({ ...n, url: n.url + '2' }))]];
  let call = 0;
  const fetchImpl = async () => mkRes(200, { results: batches[Math.min(call++, 1)] });
  const r = await ws.searchWeb(MSG, { fetchImpl, now: NOW, logger: silent, skipIntentCheck: true, config: baseCfg });
  const hit = r.results.find((x) => x.url === url);
  assert.ok(hit, 'URL conservée');
  assert.ok(hit.content.includes('Robin is the male lead'), 'extrait confirmant conservé');
});

test('bout en bout : une Q2 du queryRewriter identique à Q1 (réécrite) est reconnue redondante', async () => {
  const sent = [];
  const triedSeen = [];
  const fetchImpl = async (u, init) => {
    sent.push(JSON.parse(init.body).query);
    return mkRes(200, { results: [{ title: 'Unrelated', url: `https://example.org/${sent.length}`, content: 'Nothing here about the topic at all, generic filler text of some length.', score: 0.5 }] });
  };
  const queryRewriter = async (text, meta) => { if (meta && meta.tried) triedSeen.push(meta.tried.slice()); return 'korean film Robin boss English 2000s'; };
  await ws.searchWeb(MSG, { fetchImpl, now: NOW, logger: silent, skipIntentCheck: true, queryRewriter, config: baseCfg });
  assert.equal(sent[0], 'korean film Robin boss English 2000s', 'Q1 = requête réécrite réellement exécutée');
  assert.notEqual(sent[1], sent[0], 'Q2 ne répète pas Q1');
  assert.ok(triedSeen.length && triedSeen[0].includes(sent[0]), '"tried" contient la requête Q1 réellement exécutée');
});

test('bout en bout : recherche normale non-fuzzy = une seule requête, meta.fuzzy.triggered=false', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return mkRes(200, { results: [{ title: 'Bitcoin price today', url: 'https://www.reuters.com/markets/bitcoin', content: 'Bitcoin trades near a new level today according to market data and analysts.', score: 0.8 }] }); };
  const r = await ws.searchWeb('Cherche sur internet le prix du bitcoin', { fetchImpl, now: NOW, logger: silent, config: baseCfg });
  assert.equal(n, 1);
  assert.deepEqual(r.meta.fuzzy, { triggered: false });
  assert.equal(r.results.length, 1);
});
