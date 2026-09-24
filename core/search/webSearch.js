'use strict';
/**
 * core/search/webSearch.js — v2
 *
 * Pipeline : message → intention (needsWebSearch / resolveWebIntent)
 *          → plan de requêtes (buildSearchPlan)
 *          → appels Tavily en parallèle (retry, dégradation, timeout)
 *          → normalisation, filtrage, classement par fiabilité de source
 *          → { results, sources, ... } structuré (searchWeb)
 *
 * Garanties :
 *  - searchWeb() ne lève JAMAIS d'exception : en cas d'échec, ok=false + error.
 *  - Aucune clé/token n'est jamais loggé (redaction systématique).
 *  - Extensible : registerRule(), registerOfficialSource(), options.queryRewriter.
 *
 * Doc Tavily vérifiée : https://docs.tavily.com/documentation/api-reference/endpoint/search
 * Variables d'environnement : voir loadConfig().
 */

const projectLogger = require('../utils/logger');

const TAVILY_URL = 'https://api.tavily.com/search';
const MAX_QUERY_CHARS = 380; // Tavily recommande < 400 caractères
const MAX_RAW_CHARS = 4000;
const MAX_PER_DOMAIN = 3;

// ───────────────────────────── 1. Configuration ─────────────────────────────

function envInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}
function envFloat(v, def, min, max) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}
function envBool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function envEnum(v, allowed, def) {
  const s = String(v ?? '').trim().toLowerCase();
  return allowed.includes(s) ? s : def;
}
function envRaw(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'markdown' || s === 'true') return 'markdown';
  if (s === 'text') return 'text';
  return false;
}

/**
 * Lue à chaque recherche (le .env peut être chargé tardivement).
 * Toute valeur invalide retombe silencieusement sur la valeur par défaut.
 */
function loadConfig(env = process.env) {
  return {
    apiKey: String(env.TAVILY_API_KEY || '').trim(),
    // — paramètres Tavily (noms vérifiés dans la doc) —
    maxResults: envInt(env.TAVILY_MAX_RESULTS, 5, 1, 20),
    searchDepth: envEnum(env.TAVILY_SEARCH_DEPTH, ['basic', 'advanced', 'fast', 'ultra-fast'], 'basic'),
    topic: envEnum(env.TAVILY_TOPIC, ['auto', 'general', 'news', 'finance'], 'auto'),
    includeRawContent: envRaw(env.TAVILY_INCLUDE_RAW_CONTENT), // false | 'markdown' | 'text'
    includeAnswer: envBool(env.TAVILY_INCLUDE_ANSWER, false),
    chunksPerSource: envInt(env.TAVILY_CHUNKS_PER_SOURCE, 3, 1, 3),
    includeDomainsMode: envEnum(env.TAVILY_INCLUDE_DOMAINS_MODE, ['prefer', 'restrict'], 'prefer'),
    timeoutMs: envInt(env.TAVILY_TIMEOUT_MS, 8000, 2000, 60000),
    // — comportement du module —
    mode: envEnum(env.WEB_SEARCH_MODE, ['auto', 'off', 'web'], 'auto'), // 'off' = interrupteur général
    maxSubqueries: envInt(env.WEB_SEARCH_MAX_SUBQUERIES, 3, 1, 5),
    maxTotalResults: envInt(env.WEB_SEARCH_MAX_TOTAL, 8, 1, 20),
    maxContentChars: envInt(env.WEB_SEARCH_MAX_CONTENT_CHARS, 1200, 200, 8000),
    minScore: envFloat(env.WEB_SEARCH_MIN_SCORE, 0.1, 0, 1),
    appendYear: envBool(env.WEB_SEARCH_APPEND_YEAR, true),
    debug: envBool(env.WEB_SEARCH_DEBUG, env.NODE_ENV !== 'production'),
    retryBaseMs: 600,
  };
}

// ───────────────────────────── 2. Logs sûrs ─────────────────────────────────

const SECRET_KEY_RX = /(api[_-]?key|token|authorization|secret|password|bearer|cookie)/i;
const SECRET_VALUE_RXS = [
  /tvly-[A-Za-z0-9_-]{6,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:gsk_|sk-|xox[abp]-)[A-Za-z0-9_-]{8,}/g,
];

function redact(value, depth = 0) {
  if (typeof value === 'string') {
    let s = value;
    for (const rx of SECRET_VALUE_RXS) s = s.replace(rx, '[REDACTED]');
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  }
  if (Array.isArray(value)) return depth > 3 ? '[…]' : value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY_RX.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

function makeLogger(cfg, sink) {
  // Par défaut : le logger du projet (core/utils/logger.js, qui masque déjà les longues clés).
  const out = sink || {
    log: (...a) => projectLogger.info(...a),
    warn: (...a) => projectLogger.warn(...a),
    error: (...a) => projectLogger.error(...a),
  };
  const fmt = (event, data) => ['[WEB-SEARCH]', event, data === undefined ? '' : JSON.stringify(redact(data))];
  return {
    debug: (event, data) => { if (cfg.debug) out.log(...fmt(event, data)); },
    warn: (event, data) => out.warn(...fmt(event, data)),
    error: (event, data) => out.error(...fmt(event, data)),
  };
}

// ───────────────────────────── 3. Utilitaires texte ─────────────────────────

const stripAccents = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const norm = (s) => stripAccents(s).toLowerCase();
const CONTROL_RX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028-\u202E\u2060-\u2064\uFEFF]/g;

function cleanText(s, keepNewlines = false) {
  let t = String(s ?? '').replace(CONTROL_RX, ' ');
  t = keepNewlines ? t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : t.replace(/\s+/g, ' ');
  return t.trim();
}

function truncate(s, max, ellipsis = true) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const i = cut.lastIndexOf(' ');
  return (i > max * 0.6 ? cut.slice(0, i) : cut).trim() + (ellipsis ? '…' : '');
}

const STOPWORDS = new Set(('le la les un une des de du et ou mais donc or ni car que qui quoi dont ou est sont a ont ai as avez avons es suis ' +
  'c ce cet cette ces mon ma mes ton ta tes son sa ses notre votre leur leurs je tu il elle on nous vous ils elles me te se lui y en au aux ' +
  'pour par sur sous dans avec sans plus moins tres trop peu aussi comme si ne pas non oui quel quels quelle quelles quand comment combien ' +
  'pourquoi dis moi toi ca cela ceci faire fait dit peux peut veux veut sais sait cherche the and for what is are of to in on with how ' +
  'about tell').split(/\s+/));

function keywords(text) {
  return norm(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// ───────────────────────────── 4. Catalogue de sources ──────────────────────

/**
 * Catalogue "sujet → domaines officiels". Extensible via registerOfficialSource().
 * category: 'official' (défaut) | 'reference' (base de données de référence, ex. fiction)
 */
const OFFICIAL_SOURCES = [
  { id: 'groq', label: 'Groq', patterns: [/\bgroq(?:cloud)?\b/i], domains: ['console.groq.com', 'groq.com'] },
  { id: 'xai', label: 'xAI Grok', patterns: [/\bgrok\b/i, /\bxai\b/i], domains: ['x.ai', 'docs.x.ai'] },
  { id: 'openai', label: 'OpenAI', patterns: [/\b(?:openai|chatgpt|gpt-?\d[\w.-]*|dall-?e|sora)\b/i], domains: ['openai.com', 'platform.openai.com', 'help.openai.com'] },
  { id: 'anthropic', label: 'Anthropic Claude', patterns: [/\banthropic\b/i, /\bclaude\s+(?:code|opus|sonnet|haiku|api|ai|\d)/i], domains: ['anthropic.com', 'docs.claude.com', 'support.claude.com', 'claude.com'] },
  { id: 'google-ai', label: 'Google Gemini', patterns: [/\b(?:gemini|gemma|vertex\s+ai)\b/i], domains: ['ai.google.dev', 'deepmind.google', 'cloud.google.com', 'blog.google'] },
  { id: 'mistral', label: 'Mistral AI', patterns: [/\bmistral\s+(?:ai|api|large|small|medium|nemo)\b/i, /\b(?:mixtral|codestral)\b/i], domains: ['mistral.ai', 'docs.mistral.ai'] },
  { id: 'meta-llama', label: 'Meta Llama', patterns: [/\bllama\s*-?\s*\d/i, /\bmeta\s+llama\b/i], domains: ['llama.com', 'ai.meta.com'] },
  { id: 'supabase', label: 'Supabase', patterns: [/\bsupabase\b/i], domains: ['supabase.com'] },
  { id: 'tavily', label: 'Tavily', patterns: [/\btavily\b/i], domains: ['docs.tavily.com', 'tavily.com'] },
  { id: 'vercel', label: 'Vercel', patterns: [/\bvercel\b/i], domains: ['vercel.com'] },
  { id: 'cloudflare', label: 'Cloudflare', patterns: [/\bcloudflare\b/i], domains: ['developers.cloudflare.com', 'cloudflare.com'] },
  { id: 'github', label: 'GitHub', patterns: [/\bgithub\b/i], domains: ['docs.github.com', 'github.blog'] },
  { id: 'telegram-bot', label: 'Telegram Bot API', patterns: [/\btelegram\b[^.!?]{0,40}\b(?:bot|api)\b/i, /\bbot\s+api\b/i], domains: ['core.telegram.org', 'telegram.org'] },
  { id: 'nodejs', label: 'Node.js', patterns: [/\bnode\.?js\b/i], domains: ['nodejs.org'] },
  { id: 'python', label: 'Python', patterns: [/\bpython\b/i], domains: ['docs.python.org', 'python.org'] },
  { id: 'react', label: 'React', patterns: [/\breact(?:\.js)?\b(?=[^.!?]{0,40}\b(?:hook|composant|component|version|api|doc))/i], domains: ['react.dev'] },
  { id: 'fr-law', label: 'droit français', patterns: [/\b(?:loi|d[eé]cret|code\s+(?:civil|p[eé]nal|du\s+travail|de\s+la\s+route)|journal\s+officiel|jurisprudence)\b/i], domains: ['legifrance.gouv.fr', 'service-public.fr', 'vie-publique.fr'] },
  { id: 'fr-admin', label: 'démarches administratives', patterns: [/\b(?:carte\s+d['’]identit[eé]|passeport|permis\s+de\s+conduire|carte\s+grise|d[eé]claration\s+de\s+revenus|imp[oô]ts?)\b/i], domains: ['service-public.fr', 'impots.gouv.fr', 'ants.gouv.fr'] },
  { id: 'fr-weather', label: 'météo', patterns: [/\bm[eé]t[eé]o\b/i], domains: ['meteofrance.com'] },
  { id: 'health', label: 'santé', patterns: [/\b(?:m[eé]dicaments?|posologie|vaccins?)\b/i], domains: ['ansm.sante.fr', 'sante.gouv.fr', 'ameli.fr', 'who.int'] },
  // Fiction (bases de référence, pas "officielles")
  { id: 'kdrama', label: 'drama', category: 'reference', patterns: [/\b(?:k|j|c)-?drama\b/i, /\bdorama\b/i, /\bdrama\s+(?:cor[eé]en|japonais|chinois)\b/i], domains: ['mydramalist.com', 'asianwiki.com'] },
  { id: 'anime', label: 'anime', category: 'reference', patterns: [/\b(?:anime|manga|manhwa|light\s+novel)\b/i], domains: ['myanimelist.net', 'anilist.co'] },
  { id: 'film-serie', label: 'film série', category: 'reference', patterns: [/\b(?:film|s[eé]rie\s+tv|s[eé]rie)\b[^.!?]{0,60}\b(?:acteurs?|casting|saison|[eé]pisode|r[eé]alisateur|sortie)\b/i], domains: ['imdb.com', 'themoviedb.org', 'allocine.fr'] },
];

const INSTITUTIONAL_RXS = [
  /\.gouv\.fr$/, /\.gov(\.[a-z]{2})?$/, /\.edu(\.[a-z]{2})?$/, /\.ac\.[a-z]{2}$/,
  /(^|\.)europa\.eu$/, /(^|\.)who\.int$/, /(^|\.)un\.org$/, /(^|\.)insee\.fr$/, /(^|\.)cnrs\.fr$/, /(^|\.)inserm\.fr$/,
];
const TRUSTED_MEDIA = [
  'lemonde.fr', 'lefigaro.fr', 'liberation.fr', 'francetvinfo.fr', 'franceinfo.fr', 'lesechos.fr', 'la-croix.com', 'ouest-france.fr',
  'rfi.fr', 'france24.com', 'bfmtv.com', 'leparisien.fr', 'courrierinternational.com', 'lequipe.fr', 'numerama.com',
  'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'theguardian.com', 'washingtonpost.com', 'wsj.com', 'ft.com',
  'bloomberg.com', 'npr.org', 'aljazeera.com', 'dw.com', 'techcrunch.com', 'theverge.com', 'arstechnica.com', 'wired.com',
  'engadget.com', 'nature.com', 'science.org', 'espn.com',
];
const REFERENCE_DOMAINS = ['wikipedia.org', 'wikidata.org', 'britannica.com', 'developer.mozilla.org'];
const COMMUNITY_DOMAINS = [
  'reddit.com', 'quora.com', 'medium.com', 'stackoverflow.com', 'stackexchange.com', 'facebook.com', 'x.com', 'twitter.com',
  'tiktok.com', 'instagram.com', 'pinterest.com', 'youtube.com', 'youtu.be',
];
const SOURCE_RANK = { official: 0, institutional: 1, media: 2, reference: 3, other: 4, community: 5 };

// Au sein même des domaines "officiels", certains sous-domaines sont la doc/API
// technique (à jour, faisant autorité) plutôt que la vitrine marketing générale
// (souvent moins précise ou plus lente à être mise à jour). Ces domaines sont
// classés avant les autres domaines officiels du même fournisseur, à score égal.
const PREFERRED_OFFICIAL_DOMAINS = ['console.groq.com', 'docs.mistral.ai', 'platform.openai.com', 'docs.claude.com', 'ai.google.dev'];

const domainMatches = (host, domain) => host === domain || host.endsWith('.' + domain);

function classifySource(domain) {
  for (const e of OFFICIAL_SOURCES) {
    if (e.domains.some((d) => domainMatches(domain, d))) return e.category === 'reference' ? 'reference' : 'official';
  }
  if (INSTITUTIONAL_RXS.some((rx) => rx.test(domain))) return 'institutional';
  if (TRUSTED_MEDIA.some((d) => domainMatches(domain, d))) return 'media';
  if (REFERENCE_DOMAINS.some((d) => domainMatches(domain, d))) return 'reference';
  if (COMMUNITY_DOMAINS.some((d) => domainMatches(domain, d))) return 'community';
  return 'other';
}

function registerOfficialSource(entry) {
  if (!entry || typeof entry.id !== 'string' || !Array.isArray(entry.patterns) || !Array.isArray(entry.domains) || !entry.domains.length) {
    throw new Error('registerOfficialSource: { id, label?, patterns: RegExp[], domains: string[] } requis');
  }
  const clean = { category: 'official', label: entry.id, ...entry, domains: entry.domains.map((d) => String(d).toLowerCase()) };
  const i = OFFICIAL_SOURCES.findIndex((e) => e.id === entry.id);
  if (i >= 0) OFFICIAL_SOURCES[i] = clean; else OFFICIAL_SOURCES.push(clean);
}

function detectEntities(text) {
  return OFFICIAL_SOURCES.filter((e) => e.patterns.some((rx) => rx.test(text)));
}

// ───────────────────────────── 5. Détection d'intention ─────────────────────
//
// Règles déclaratives : { id, kind, test }. Ajoutez/éditez avec registerRule().
// Priorité de résolution : forced > never > lookup > soft_never > auto > none
//   forced     : recherche explicitement demandée
//   never      : jamais de recherche (salutation, message minuscule, auto-référence…)
//   lookup     : identité / œuvres / entités → toujours chercher (anti-hallucination)
//   soft_never : message personnel — cède seulement devant un "lookup"
//   auto       : déclencheurs temporels / actualité / prix / versions…

const KINDS = ['forced', 'never', 'lookup', 'soft_never', 'auto'];
const INTENT_RULES = [];

function registerRule(rule) {
  if (!rule || typeof rule.id !== 'string' || !KINDS.includes(rule.kind)) {
    throw new Error(`registerRule: { id: string, kind: ${KINDS.join('|')}, test: RegExp|function } requis`);
  }
  const test = rule.test instanceof RegExp
    ? (t) => rule.test.test(t)
    : typeof rule.test === 'function' ? rule.test : null;
  if (!test) throw new Error('registerRule: "test" doit être une RegExp ou une fonction (text, ctx) → boolean');
  const entry = { id: rule.id, kind: rule.kind, test };
  const i = INTENT_RULES.findIndex((r) => r.id === rule.id);
  if (i >= 0) INTENT_RULES[i] = entry; else INTENT_RULES.push(entry);
}
const R = (id, kind, test) => registerRule({ id, kind, test });

const MENTIONS_WORK = /\b(rp|roleplay|jeu\s+de\s+r[oô]le|drama|s[eé]rie|anime|manga|film|dorama|k.?drama|j.?drama|c.?drama|webtoon|manhwa)\b/i;
const AP = "['’]";

// — forced —
R('explicit_web_request', 'forced', new RegExp(`\\b(cherche|recherche|trouve|v[eé]rifie|regarde|check)\\b[^.!?]{0,30}\\b(sur\\s+(?:le\\s+)?(?:web|internet|net|google)|en\\s+ligne)\\b`, 'i'));
R('explicit_search_noun', 'forced', /\b(fais|fait|lance|effectue|refais)\s+(?:moi\s+)?(?:une\s+)?recherche\b/i);
R('asks_sources', 'forced', /\b(donne|cite|indique)[-\s]moi\s+(?:tes\s+|les\s+)?sources\b/i);

// — never —
R('too_short', 'never', (t) => t.length < 8);
R('greeting_only', 'never', (t) => /^(bonjour|salut|hey|hi|hello|coucou|bonsoir|merci|ok|d.accord)\b/i.test(t) && t.length < 30);
R('how_are_you', 'never', /^(comment\s+(?:tu\s+vas|vas-tu|allez-vous|vous\s+allez|[cç]a\s+va)|[cç]a\s+va)\b/i);
R('about_the_bot', 'never', new RegExp(`^(qui\\s+es-?tu|t${AP}?appelles|qu${AP}est-ce\\s+que\\s+tu\\s+es|c${AP}est\\s+quoi\\s+toi)\\b`, 'i'));
R('app_self_reference', 'never', /\b(omnichat|ominichat|stornias)\b/i);

// — lookup —
R('identity_question', 'lookup', new RegExp(`\\b(qui\\s+(?:est|[eé]tait|sont|[eé]taient)|c${AP}est\\s+qui|c${AP}est\\s+quoi|c${AP}[eé]taient\\s+qui|kesako|k[eé]zako)\\b`, 'i'));
R('info_request', 'lookup', /\b(infos?\s+sur|parle[-\s]moi\s+(?:de|du|des|d['’])|renseigne[-\s]moi\s+sur|pr[eé]sente[-\s]moi|d[eé]cris[-\s]moi)/i);
R('character_question', 'lookup', /\b(personnage|h[eé]ro[sïe]?|antagoniste|protagoniste)\b[^.!?]*\b(qui|quel|comment|d[eé]cri\w*)\b/i);
R('work_question', 'lookup', new RegExp(`\\b(s[eé]rie|anime|manga|film|roman|livre|jeu\\s+vid[eé]o|webtoon|manhwa|light\\s+novel|saison|[eé]pisode)\\b[^.!?]*\\b(qui|quel|quelle|comment|c${AP}est|parle)\\b`, 'i'));
R('roleplay_on_work', 'lookup', /\b(rp|roleplay|jeu\s+de\s+r[oô]le|jouer|incarner)\b[^.!?]*\b(s[eé]rie|anime|manga|film|roman|drama|dorama|web.?series|k.?drama|j.?drama|c.?drama|bollywood|telenovela|webtoon|manhwa)\b/i);
R('background_lore', 'lookup', /\b(biographie|backstory|lore|background|origine\s+de)\b/i);
R('find_that_work', 'lookup', new RegExp(`\\b(il\\s+y\\s+a|y${AP}?a)\\s+(?:un[e]?\\s+)?(?:vieux|vieille|ancien(?:ne)?|old\\s+)?\\s*(film|s[eé]rie|drama|dorama|anime)\\b`, 'i'));
R('artist_question', 'lookup', new RegExp(`\\b(acteur|actrice|r[eé]alisateur|chanteur|chanteuse|auteur|autrice|[eé]crivain|compositeur|mangaka)\\b[^.!?]*\\b(qui|quel|c${AP}est|parle)\\b`, 'i'));
R('proper_noun_after_question', 'lookup', new RegExp(`\\b(?:[Qq]ui|[Qq]uel(?:le)?s?|c${AP}est|[Cc]onnais|sais[-\\s]tu|tu\\s+connais)\\b[^.!?]{0,30}[A-ZÀÂÆÇÉÈÊËÎÏÔÙÛÜŸ][a-zàâæçéèêëîïôùûüÿ]+(?:\\s+[A-ZÀÂÆÇÉÈÊËÎÏÔÙÛÜŸ][a-zàâæçéèêëîïôùûüÿ]+)+`));

// — soft_never (messages personnels) —
R('personal_relations', 'soft_never', /\b(mon\s+(?:ex|mec|copain|mari|ch[eé]ri|compagnon)|ma\s+(?:ex|meuf|copine|femme|ch[eé]rie|compagne)|ma\s+famille|mon\s+p[eè]re|ma\s+m[eè]re|mes\s+amis|notre\s+(?:relation|couple|s[eé]paration|rupture))\b/i);
R('personal_feelings', 'soft_never', new RegExp(`\\b(je\\s+(?:me\\s+sens|suis\\s+(?:triste|heureux|heureuse|content|contente|fatigu[eé]e?|stress[eé]e?|amoureux|amoureuse|d[eé]prim[eé]e?))|j${AP}(?:aime|adore|d[eé]teste|pr[eé]f[eè]re)\\b)`, 'i'));
R('personal_memory', 'soft_never', new RegExp(`\\b(ça\\s+me\\s+rappelle|j${AP}me\\s+souviens|tu\\s+(?:te\\s+)?souviens|on\\s+(?:se\\s+)?rappelle|on\\s+s${AP}(?:est\\s+s[eé]par[eé]|aime|aimait|dispute|retrouve))\\b`, 'i'));
R('first_person_statement', 'soft_never', (t) =>
  new RegExp(`^(je\\s|j${AP})`, 'i').test(t) && !t.includes('?') && !MENTIONS_WORK.test(t) &&
  !/\b(cherche|veux\s+savoir|voudrais\s+savoir|veux\s+trouver|connais|sais|entends\s+parler|parle\s+de)\b/i.test(t));

// — auto —
R('temporal', 'auto', new RegExp(`\\b(aujourd${AP}?hui|ce\\s+soir|ce\\s+matin|cette\\s+semaine|ce\\s+mois|cette\\s+ann[eé]e|en\\s+ce\\s+moment)\\b`, 'i'));
R('recency', 'auto', /\b(actuellement|r[eé]cemment|derni[eè]res?s?|nouveau|nouvelle|nouveaut[eé]s?)\b/i);
R('price', 'auto', /\b(prix|tarifs?|co[uû]te?r?|combien\s+(?:co[uû]te|vaut|co[uû]tent))\b/i);
R('weather', 'auto', /\b(m[eé]t[eé]o|temp[eé]rature|pr[eé]visions?)\b/i);
R('news', 'auto', /\b(news|actualit[eé]s?|actus?|[eé]v[eé]nements?)\b/i);
R('sports', 'auto', /\b(score|r[eé]sultats?|classement|match|tournoi)\b/i);
R('finance', 'auto', /\b(bourse|crypto|bitcoin|ethereum|cac\s?40|nasdaq|cotation|cours\s+(?:de|du|des))\b/i);
R('release', 'auto', /\b(sortie|disponibles?|lancement|release|changelog|mise\s+[àa]\s+jour)\b/i);
R('politics', 'auto', /\b(sondage|[eé]lections?|scrutin|gouvernement|pr[eé]sident|premier\s+ministre)\b/i);
R('just_happened', 'auto', new RegExp(`\\b(vient\\s+de|viennent\\s+de|vient\\s+d${AP})`, 'i'));
R('year_reference', 'auto', /\b(en|depuis|[àa]\s+partir\s+de)\s+20\d{2}\b/i);
R('tech_docs', 'auto', new RegExp(`\\b(documentation|docs?\\s+officielles?|release\\s+notes|rate\\s*-?limits?|quotas?|limites?\\s+(?:d${AP}utilisation|de\\s+(?:l${AP}|la\\s+)?api|de\\s+requ[eê]tes?)|mod[eè]les?\\s+(?:disponibles?|support[eé]s?|dispo))\\b`, 'i'));
R('unknown_product', 'auto', /\b(?:tu|vous)\s+connai(?:s|ssez)\b[^.!?]{0,40}[A-ZÀ-Ý][\wÀ-ÿ]+/);
R('named_app_or_service', 'auto', /\b(l['’]appli(?:cation)?|le\s+site|la\s+plateforme|le\s+service|le\s+logiciel|l['’]outil|le\s+bot|le\s+chatbot)\b[^.!?]{0,30}[A-ZÀ-Ý][\wÀ-ÿ]+/);
// Entité du catalogue + question : c'est LA règle qui corrige "modèles Groq disponibles".
R('official_entity_question', 'auto', (t) =>
  detectEntities(t).some((e) => e.category !== 'reference') &&
  /\?|\b(quel|quels|quelle|quelles|combien|comment|est-ce|dispo|liste|tarif|prix|limite|derni)/i.test(t));

function cleanForIntent(raw) {
  return cleanText(
    String(raw ?? '')
      .replace(/\*[^*\n]{0,300}\*/g, ' ') // *actions de RP*
      .replace(/https?:\/\/\S+/g, ' ')
  );
}

function resolveWebIntent(message, opts = {}) {
  const mode = ['off', 'auto', 'web'].includes(opts.mode) ? opts.mode : 'auto';
  const text = cleanForIntent(message);
  const none = (reasons) => ({ shouldSearch: false, level: 'none', intent: 'none', reasons, mode });

  if (!text) return none(['empty_after_cleanup']);
  if (mode === 'off') return none(['mode_off']);
  if (mode === 'web') return { shouldSearch: true, level: 'forced', intent: 'forced', reasons: ['mode_web'], mode };

  const ctx = { raw: String(message ?? ''), text };
  const matched = { forced: [], never: [], lookup: [], soft_never: [], auto: [] };
  for (const rule of INTENT_RULES) {
    let hit = false;
    try { hit = !!rule.test(text, ctx); } catch { hit = false; } // une règle cassée ne casse pas le moteur
    if (hit) matched[rule.kind].push(rule.id);
  }

  if (matched.forced.length) return { shouldSearch: true, level: 'forced', intent: 'forced', reasons: matched.forced, mode };
  if (matched.never.length) return none(matched.never);
  if (matched.lookup.length) return { shouldSearch: true, level: 'lookup', intent: 'lookup', reasons: matched.lookup, mode };
  if (matched.soft_never.length) return none(matched.soft_never);
  if (matched.auto.length) return { shouldSearch: true, level: 'auto', intent: 'auto', reasons: matched.auto, mode };
  return none(['no_trigger']);
}

/** Signature historique conservée : renvoie un booléen. */
function needsWebSearch(message, opts) {
  return resolveWebIntent(message, opts).shouldSearch;
}

// ───────────────────────────── 6. Construction des requêtes ─────────────────

const FILLER_RXS = [
  /^(?:bonjour|salut|hey|coucou|bonsoir|dis|alors|bon|ok|du\s+coup|eh\s+bien)[\s,!.-]+/i,
  /\b(?:s['’]il\s+(?:te|vous)\s+pla[iî]t|stp|svp|please)\b/gi,
  /\b(?:peux[-\s]tu|pourrais[-\s]tu|tu\s+peux|tu\s+pourrais|dis[-\s]moi|je\s+cherche|j['’]aimerais\s+savoir|je\s+voudrais\s+savoir|je\s+veux\s+savoir|est-ce\s+que\s+tu\s+sais)\b/gi,
];

function stripFiller(s) {
  let t = s;
  for (const rx of FILLER_RXS) t = t.replace(rx, ' ');
  return cleanText(t).replace(/^[\s,;:.!-]+/, '');
}

function isVagueQuery(text) {
  return /\b(lol|je\s+sais\s+pas|je\s+me\s+rappelle|un\s+truc|un\s+film|une\s+s[eé]rie|vieux|ancien|old|genre|je\s+crois|il\s+me\s+semble|quelque\s+chose|je\s+cherche|il\s+y\s+a|ya)\b/i.test(text) ||
    keywords(text).length < 2;
}

function detectTemporal(text) {
  const t = text;
  let topic = 'general';
  if (/\b(actualit[eé]s?|actus?|news|derni[eè]res?\s+(?:nouvelles|infos?)|ce\s+qui\s+s['’]est\s+pass[eé]|hier|ce\s+week-?end|r[eé]sultats?|scores?|match|[eé]lections?|sondage|vient\s+de)\b/i.test(t)) topic = 'news';
  if (/\b(bourse|cotation|crypto|bitcoin|ethereum|cac\s?40|nasdaq|dow\s+jones|s&p|cours\s+(?:de|du|des)\s+(?:l['’])?(?:action|bitcoin|ethereum|euro|dollar|p[eé]trole|or))\b/i.test(t)) topic = 'finance';

  let timeRange = null;
  if (/\b(aujourd['’]?hui|ce\s+soir|ce\s+matin|en\s+ce\s+moment)\b/i.test(t)) timeRange = 'day';
  else if (/\b(cette\s+semaine|hier|ce\s+week-?end|ces\s+derniers\s+jours|m[eé]t[eé]o)\b/i.test(t)) timeRange = 'week';
  else if (/\b(ce\s+mois|ces\s+derni[eè]res\s+semaines)\b/i.test(t)) timeRange = 'month';
  else if (/\b(cette\s+ann[eé]e|r[eé]cemment|nouveaut[eé]s?)\b/i.test(t)) timeRange = 'year';

  const freshness = !!timeRange ||
    /\b(actuellement|derni[eè]res?s?|nouveau|nouvelle|disponibles?|sortie|lancement|mise\s+[àa]\s+jour|changelog|prix|tarifs?|limites?|quotas?)\b/i.test(t);
  return { topic, timeRange, freshness };
}

function splitSubQuestions(prepared) {
  const parts = prepared
    .split(/\n+|(?<=\?)\s+|\s;\s|\s+(?:et\s+aussi|et\s+puis|et\s+ensuite|ensuite|par\s+ailleurs|d['’]autre\s+part)[\s,]+(?=\S)/i)
    .map((p) => stripFiller(p.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '')))
    .filter(Boolean);
  const meaningful = parts.filter((p) => keywords(p).length >= 2);
  return meaningful;
}

/**
 * Construit le plan de recherche.
 * @returns {Promise<Array<{id,purpose,original,query,topic,timeRange,freshness,officialDomains,entities,rewritten}>>}
 */
async function buildSearchPlan(message, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const log = opts.log || makeLogger(cfg);
  const now = opts.now instanceof Date ? opts.now : new Date();

  const prepared = String(message ?? '')
    .replace(/\*[^*\n]{0,300}\*/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(CONTROL_RX, ' ');
  const whole = cleanText(prepared);
  const wholeEntities = detectEntities(whole).filter((e) => e.category !== 'reference');

  let parts = splitSubQuestions(prepared);
  if (parts.length < 2) {
    let single = stripFiller(whole) || whole;
    if (single.length > MAX_QUERY_CHARS) {
      const q = single.split(/(?<=[.!?…])\s+/).filter((s) => s.includes('?')).pop();
      single = q ? stripFiller(q) : single;
    }
    parts = [single];
  } else if (parts.length > cfg.maxSubqueries) {
    log.debug('plan.subqueries_truncated', { found: parts.length, kept: cfg.maxSubqueries });
    parts = parts.slice(0, cfg.maxSubqueries);
  }

  const items = [];
  for (let i = 0; i < parts.length; i++) {
    let query = parts[i];

    // Une sous-question ne doit pas perdre le sujet de la question globale.
    if (parts.length > 1) {
      for (const e of wholeEntities.slice(0, 2)) {
        if (!e.patterns.some((rx) => rx.test(query))) query += ' ' + e.label;
      }
    }
    // Suivi vague ("et lui ?") : on emprunte des mots au message précédent.
    if (keywords(query).length < 2 && opts.contextHint) {
      query = truncate(cleanForIntent(opts.contextHint), 120, false) + ' ' + query;
    }

    const original = query;
    let rewritten = false;
    if (typeof opts.queryRewriter === 'function' && isVagueQuery(query)) {
      try {
        const r = await opts.queryRewriter(query, { message: String(message ?? ''), contextHint: opts.contextHint || null });
        const rq = typeof r === 'string' ? cleanText(r) : '';
        if (rq && rq.length <= MAX_QUERY_CHARS) { query = rq; rewritten = true; }
      } catch (e) {
        log.warn('plan.rewriter_failed', { error: String(e && e.message) });
      }
    }

    const temporal = detectTemporal(original);
    const entities = detectEntities(query).filter((e) => e.patterns.length);
    const officialDomains = [...new Set(entities.flatMap((e) => e.domains))];

    let topic = cfg.topic === 'auto' ? temporal.topic : cfg.topic;
    if (topic === 'finance' && cfg.topic === 'auto' && temporal.topic !== 'finance') topic = 'general';

    if (cfg.appendYear && temporal.freshness && topic === 'general' && !/\b20\d{2}\b/.test(query)) {
      query = query.replace(/[\s?!.]+$/, '') + ' ' + now.getFullYear();
    }
    query = truncate(cleanText(query), MAX_QUERY_CHARS, false);

    items.push({
      id: i + 1,
      purpose: parts.length > 1 ? 'sub' : 'main',
      original: truncate(original, 160, false),
      query,
      topic,
      timeRange: temporal.timeRange,
      freshness: temporal.freshness,
      officialDomains,
      entities: entities.map((e) => e.id),
      rewritten,
    });
  }
  return items;
}

// ───────────────────────────── 7. Appel Tavily ──────────────────────────────

class SearchError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
    this.status = extra.status ?? null;
    this.retryable = !!extra.retryable;
    this.retryAfterMs = extra.retryAfterMs ?? null;
  }
}

function classifyHttp(status) {
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 432 || status === 433) return 'quota_exceeded';
  if (status >= 500) return 'server_error';
  return 'http_error';
}

function buildPayload(item, cfg) {
  const p = {
    query: item.query,
    topic: item.topic,
    search_depth: cfg.searchDepth,
    max_results: cfg.maxResults,
    include_published_date: true,
    include_favicon: true,
  };
  if (cfg.searchDepth !== 'ultra-fast') p.chunks_per_source = cfg.chunksPerSource;
  if (cfg.includeAnswer) p.include_answer = true;
  if (cfg.includeRawContent) p.include_raw_content = cfg.includeRawContent;
  if (item.timeRange) p.time_range = item.timeRange;
  if (item.officialDomains.length) {
    p.include_domains = item.officialDomains;
    p.include_domains_mode = cfg.includeDomainsMode; // 'prefer' : booste sans exclure le reste du web
  }
  return p;
}

/** Payload minimal en cas de 400 : on retire les paramètres récents/optionnels. */
function degradePayload(p) {
  const d = { ...p };
  for (const k of ['include_published_date', 'include_favicon', 'chunks_per_source', 'include_domains', 'include_domains_mode']) delete d[k];
  return d;
}

async function callTavily(payload, ctx) {
  const { cfg, doFetch } = ctx;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await doFetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* corps non JSON */ }
    if (!res.ok) {
      const code = classifyHttp(res.status);
      const detail = json && json.detail;
      const msg = (detail && (detail.error || (Array.isArray(detail) && detail[0] && detail[0].msg))) || `HTTP ${res.status}`;
      const ra = Number.parseFloat(res.headers && res.headers.get ? res.headers.get('retry-after') : NaN);
      const retryAfterMs = Number.isFinite(ra) ? ra * 1000 : null;
      throw new SearchError(code, String(msg), {
        status: res.status,
        retryAfterMs,
        retryable: code === 'server_error' || (code === 'rate_limited' && (retryAfterMs === null || retryAfterMs <= 2000)),
      });
    }
    if (!json || !Array.isArray(json.results)) throw new SearchError('bad_response', 'Réponse Tavily inattendue');
    return json;
  } catch (e) {
    if (e instanceof SearchError) throw e;
    if (e && e.name === 'AbortError') throw new SearchError('timeout', `Timeout après ${cfg.timeoutMs} ms`);
    throw new SearchError('network', String((e && e.message) || e), { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callWithRetry(payload, ctx, info) {
  let last;
  for (let i = 0; i < 2; i++) {
    info.attempts++;
    try {
      return await callTavily(payload, ctx);
    } catch (e) {
      last = e;
      if (!e.retryable || i === 1) throw e;
      await sleep(Math.min(e.retryAfterMs ?? ctx.cfg.retryBaseMs, 2000));
    }
  }
  throw last;
}

// ───────────────────────────── 8. Normalisation & filtrage ──────────────────

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.protocol = 'https:';
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$|ref_src$|mc_)/i.test(k)) u.searchParams.delete(k);
    return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + u.search).toLowerCase();
  } catch { return String(url).toLowerCase(); }
}

function parsePublished(v, now) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime() + 86400000) return null;
  return d.toISOString();
}

function freshnessLabel(ageDays) {
  if (ageDays === null) return 'unknown';
  if (ageDays <= 30) return 'recent';
  if (ageDays <= 365) return 'dated';
  return 'old';
}

// Volontairement étroit : "system prompt" seul apparaît légitimement dans des docs d'API.
const INJECTION_RX = /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions|disregard\s+(?:the\s+|all\s+)?(?:previous|prior|system)\s+instructions|(?:reveal|print|show)\s+(?:your|the)\s+system\s+prompt|ignore\s+(?:toutes?\s+)?(?:les\s+|tes\s+)?instructions\s+pr[eé]c[eé]dentes|oublie\s+(?:toutes?\s+)?tes\s+instructions/i;

function normalizeResult(r, item, cfg, now) {
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) return null;
  const domain = hostOf(url);
  if (!domain) return null;
  const publishedAt = parsePublished(r.published_date, now);
  const ageDays = publishedAt ? Math.max(0, Math.floor((now.getTime() - new Date(publishedAt).getTime()) / 86400000)) : null;
  const content = truncate(cleanText(r.content), cfg.maxContentChars);
  const rawContent = r.raw_content ? truncate(cleanText(r.raw_content, true), MAX_RAW_CHARS) : null;
  return {
    id: null,
    title: truncate(cleanText(r.title), 200) || domain,
    url,
    domain,
    content,
    rawContent,
    score: typeof r.score === 'number' ? r.score : null,
    publishedAt,
    ageDays,
    freshness: freshnessLabel(ageDays),
    favicon: typeof r.favicon === 'string' && /^https?:\/\//i.test(r.favicon) ? r.favicon : null,
    sourceType: classifySource(domain),
    preferred: PREFERRED_OFFICIAL_DOMAINS.some((d) => domainMatches(domain, d)),
    authoritative: false,
    queryIds: [item.id],
    suspicious: INJECTION_RX.test(content) || (rawContent ? INJECTION_RX.test(rawContent) : false),
  };
}

function overlapsQuery(result, kws) {
  if (kws.length < 2) return true;
  const hay = norm(`${result.title} ${result.url} ${result.content}`);
  return kws.some((kw) => hay.includes(kw.length > 5 ? kw.slice(0, kw.length - 2) : kw));
}

const byRankThenScore = (a, b) =>
  Number(!!b.authoritative) - Number(!!a.authoritative) ||
  SOURCE_RANK[a.sourceType] - SOURCE_RANK[b.sourceType] ||
  Number(!!b.preferred) - Number(!!a.preferred) ||
  (b.score ?? 0) - (a.score ?? 0);

/** Fusionne, dédoublonne, filtre, classe. Retourne { kept, rejected }. */
function processResults(perQuery, plan, cfg) {
  const rejected = [];
  const rej = (r, reason) => rejected.push({ domain: r.domain, title: truncate(r.title, 80, false), reason });

  // 1) fusion + dédoublonnage par URL normalisée (on garde le meilleur score)
  const byUrl = new Map();
  for (const { item, results } of perQuery) {
    for (const r of results) {
      const key = normalizeUrl(r.url);
      const prev = byUrl.get(key);
      if (!prev) { byUrl.set(key, r); continue; }
      prev.queryIds = [...new Set([...prev.queryIds, ...r.queryIds])];
      if ((r.score ?? 0) > (prev.score ?? 0)) { r.queryIds = prev.queryIds; byUrl.set(key, r); rej(prev, 'duplicate_url'); } else rej(r, 'duplicate_url');
    }
  }
  const merged = [...byUrl.values()];

  // 2) doublons titre+domaine
  const seenTitle = new Set();
  const uniq = [];
  for (const r of merged.sort(byRankThenScore)) {
    const k = r.domain + '|' + norm(r.title);
    if (seenTitle.has(k)) { rej(r, 'duplicate_title'); continue; }
    seenTitle.add(k);
    uniq.push(r);
  }

  // 3) filtres qualité
  const kwByQuery = new Map(plan.map((it) => [it.id, keywords(it.original)]));
  const trusted = (r) => r.sourceType === 'official' || r.sourceType === 'institutional';
  const passed = [];
  const softRejected = [];
  for (const r of uniq) {
    if (r.suspicious) { rej(r, 'suspicious_content'); continue; }
    if (!r.content && !r.rawContent) { rej(r, 'empty_content'); continue; }
    if (!trusted(r) && r.score !== null && r.score < cfg.minScore) { rej(r, 'low_score'); continue; }
    if (!trusted(r) && !r.queryIds.some((id) => overlapsQuery(r, kwByQuery.get(id) || []))) { softRejected.push(r); continue; }
    passed.push(r);
  }
  // Fail-open : un filtre lexical trop strict ne doit jamais vider tous les résultats.
  let pool = passed;
  if (!pool.length && softRejected.length) pool = softRejected;
  else softRejected.forEach((r) => rej(r, 'off_topic'));

  // 4) plafond par domaine
  const perDomain = new Map();
  const capped = [];
  for (const r of pool) {
    const n = perDomain.get(r.domain) || 0;
    if (n >= MAX_PER_DOMAIN) { rej(r, 'domain_cap'); continue; }
    perDomain.set(r.domain, n + 1);
    capped.push(r);
  }

  // 5) sélection : chaque sous-question garde au moins son meilleur résultat
  const picked = new Set();
  const out = [];
  if (plan.length > 1) {
    for (const it of plan) {
      const first = capped.find((r) => r.queryIds.includes(it.id) && !picked.has(r));
      if (first && out.length < cfg.maxTotalResults) { picked.add(first); out.push(first); }
    }
  }
  for (const r of capped) {
    if (out.length >= cfg.maxTotalResults) break;
    if (!picked.has(r)) { picked.add(r); out.push(r); }
  }
  for (const r of capped) if (!picked.has(r)) rej(r, 'over_limit');

  out.sort(byRankThenScore);
  out.forEach((r, i) => { r.id = 'S' + (i + 1); });
  return { kept: out, rejected };
}

// ───────────────────────── 8bis. Endpoints officiels vérifiés ───────────────
//
// Pour certains faits à très haut risque d'hallucination (ex. "quels modèles
// sont disponibles chez X ?"), une recherche Tavily classique renvoie des
// pages web indexées — jamais garanties à jour, et souvent moins précises que
// des benchmarks tiers obsolètes qui, eux, listent beaucoup de détails
// (d'où le risque que le modèle s'appuie dessus). Ici, on interroge l'API
// officielle DIRECTEMENT, et on injecte le résultat comme source faisant
// autorité absolue (authoritative:true), toujours en tête, jamais évincée
// par le plafond de résultats.
//
// Best-effort et silencieux : si la clé serveur nécessaire est absente ou si
// l'appel échoue, on ne fait AUCUNE différence visible — le pipeline Tavily
// habituel prend le relais normalement. Aucune exception ne remonte jamais.

const OFFICIAL_ENDPOINTS = [];

function registerOfficialEndpoint(entry) {
  if (!entry || typeof entry.id !== 'string' || typeof entry.test !== 'function' || typeof entry.fetcher !== 'function') {
    throw new Error('registerOfficialEndpoint: { id, test(text)=>boolean, fetcher(ctx)=>Promise<Result|null> } requis');
  }
  const i = OFFICIAL_ENDPOINTS.findIndex((e) => e.id === entry.id);
  if (i >= 0) OFFICIAL_ENDPOINTS[i] = entry; else OFFICIAL_ENDPOINTS.push(entry);
}

/**
 * Liste en direct des modèles Groq — GET /openai/v1/models (doc Tavily non
 * concernée ici, c'est l'API OpenAI-compatible de Groq elle-même).
 * Nécessite une clé serveur GROQ_API_KEY (indépendante de la clé Tavily et
 * de la clé Groq personnelle de l'utilisateur, saisie côté navigateur).
 * Sans cette variable d'env sur Render, cette fonction rend simplement null
 * et le comportement redevient celui d'avant (Tavily seul).
 */
async function fetchGroqModelsList(ctx) {
  const apiKey = String(process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) {
    ctx.log.debug('official_endpoint.no_key', { id: 'groq-models', hint: 'GROQ_API_KEY absente côté serveur : repli sur Tavily seul' });
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await ctx.doFetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) { ctx.log.warn('official_endpoint.http_error', { id: 'groq-models', status: res.status }); return null; }
    const json = await res.json();
    const models = Array.isArray(json.data) ? json.data : [];
    if (!models.length) return null;
    const lines = models.map((m) => {
      const bits = [m.id];
      if (m.owned_by) bits.push(`par ${m.owned_by}`);
      if (m.context_window) bits.push(`contexte ${m.context_window} tokens`);
      if (m.active === false) bits.push('[INACTIF]');
      return `- ${bits.join(' — ')}`;
    }).join('\n');
    return {
      title: 'Modèles Groq — liste officielle en direct (API)',
      url: 'https://console.groq.com/docs/models',
      domain: 'api.groq.com',
      content: `Liste obtenue en temps réel via GET https://api.groq.com/openai/v1/models (source faisant autorité, pas une page web indexée) :\n${lines}\n\nUn modèle absent de cette liste n'est plus proposé par l'API Groq, même s'il apparaît encore dans d'anciens articles ou comparatifs.`,
      publishedAt: ctx.now.toISOString(),
    };
  } catch (e) {
    ctx.log.warn('official_endpoint.failed', { id: 'groq-models', error: String((e && e.message) || e) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

registerOfficialEndpoint({
  id: 'groq-models',
  test: (text) => /\bgroq\b/i.test(text) && /\b(mod[eè]les?|models?|liste|d[eé]pr[eé]ci[eé]?s?|deprecat|retir[eé]s?|tool[-\s]?use|function[-\s]?calling)\b/i.test(text),
  fetcher: fetchGroqModelsList,
});

// ───────────────────────────── 9. Exécution ─────────────────────────────────

async function runPlanItem(item, ctx) {
  const { cfg, log } = ctx;
  const t0 = Date.now();
  const info = {
    id: item.id, query: item.query, purpose: item.purpose, topic: item.topic, timeRange: item.timeRange,
    officialDomains: item.officialDomains, rewritten: item.rewritten,
    status: 'pending', resultCount: 0, durationMs: 0, attempts: 0, degraded: false, fallbackUnrestricted: false, error: null,
  };
  let results = [];
  let answer = null;
  try {
    let payload = buildPayload(item, cfg);
    log.debug('query.send', { id: item.id, query: item.query, topic: item.topic, timeRange: item.timeRange, domains: item.officialDomains, depth: cfg.searchDepth });
    let json;
    try {
      json = await callWithRetry(payload, ctx, info);
    } catch (e) {
      if (e.code !== 'bad_request') throw e;
      info.degraded = true;
      log.warn('query.degraded', { id: item.id, reason: e.message });
      payload = degradePayload(payload);
      json = await callWithRetry(payload, ctx, info);
    }
    if (!json.results.length && payload.include_domains) {
      info.fallbackUnrestricted = true;
      payload = { ...payload };
      delete payload.include_domains;
      delete payload.include_domains_mode;
      json = await callWithRetry(payload, ctx, info);
    }
    answer = typeof json.answer === 'string' && json.answer.trim() ? cleanText(json.answer) : null;
    results = json.results.map((r) => normalizeResult(r, item, cfg, ctx.now)).filter(Boolean);
    info.status = 'ok';
    info.resultCount = results.length;
  } catch (e) {
    info.status = 'error';
    info.error = { code: e.code || 'unknown', message: redact(String(e.message || e)), status: e.status ?? null };
    log.warn('query.failed', { id: item.id, code: info.error.code, status: info.error.status });
  }
  info.durationMs = Date.now() - t0;
  return { item, info, results, answer };
}

function baseResult(extra) {
  return {
    triggered: false, ok: false, intent: null, queries: [], results: [], sources: [], answers: [], rejected: [],
    error: null, meta: { retrieved: 0, kept: 0, totalMs: 0, searchedAt: null }, ...extra,
  };
}

/**
 * Point d'entrée principal. Ne lève jamais.
 *
 * @param {string} message  message brut de l'utilisateur
 * @param {object} [options]
 *   mode            'off' | 'auto' | 'web'  (défaut 'auto' ; 'web' = recherche forcée, 'off' = jamais)
 *   skipIntentCheck true si l'appelant a déjà décidé de chercher (ex. needsWebSearch() déjà appelé)
 *   contextHint     message précédent, pour les questions de suivi vagues
 *   queryRewriter   async (query, ctx) => string|null   (ex. reformulation via LLM)
 *   config          surcharge partielle de loadConfig()
 *   logger          { log, warn, error } (défaut console)
 *   now, fetchImpl  injection pour les tests
 */
async function searchWeb(message, options = {}) {
  const started = Date.now();
  const cfg = { ...loadConfig(), ...(options.config || {}) };
  const log = makeLogger(cfg, options.logger);
  try {
    const mode = options.mode || cfg.mode;
    const intent = options.skipIntentCheck && mode !== 'off'
      ? { shouldSearch: true, level: 'forced', intent: 'forced', reasons: ['skipIntentCheck'], mode }
      : resolveWebIntent(message, { mode });

    if (!intent.shouldSearch) {
      log.debug('intent.skip', { reasons: intent.reasons, mode: intent.mode });
      return baseResult({ intent, meta: { retrieved: 0, kept: 0, totalMs: Date.now() - started, searchedAt: null } });
    }
    log.debug('intent.search', { level: intent.level, reasons: intent.reasons });

    if (!cfg.apiKey) {
      log.warn('config.no_api_key', { hint: 'TAVILY_API_KEY manquante' });
      return baseResult({ triggered: true, intent, error: { code: 'no_api_key', message: 'Clé Tavily absente' } });
    }
    const doFetch = options.fetchImpl || globalThis.fetch;
    if (typeof doFetch !== 'function') {
      return baseResult({ triggered: true, intent, error: { code: 'no_fetch', message: 'fetch indisponible (Node ≥ 18 requis)' } });
    }
    const now = options.now instanceof Date ? options.now : new Date();

    const plan = await buildSearchPlan(message, { cfg, log, now, contextHint: options.contextHint, queryRewriter: options.queryRewriter });
    const ctx = { cfg, log, doFetch, now };

    // Endpoint officiel vérifié (ex. liste des modèles Groq en direct) : lancé
    // en parallèle de Tavily, jamais bloquant, jamais fatal en cas d'échec.
    const matchedEndpoint = OFFICIAL_ENDPOINTS.find((e) => { try { return e.test(message); } catch { return false; } });
    const endpointPromise = matchedEndpoint ? matchedEndpoint.fetcher(ctx) : Promise.resolve(null);

    const [runs, endpointData] = await Promise.all([
      Promise.all(plan.map((item) => runPlanItem(item, ctx))),
      endpointPromise,
    ]);
    if (matchedEndpoint) log.debug('official_endpoint.match', { id: matchedEndpoint.id, used: !!endpointData });

    const okRuns = runs.filter((r) => r.info.status === 'ok');
    const errors = runs.filter((r) => r.info.error).map((r) => r.info.error);
    const retrieved = okRuns.reduce((n, r) => n + r.results.length, 0);
    const { kept, rejected } = processResults(okRuns.map((r) => ({ item: r.item, results: r.results })), plan, cfg);

    // La source faisant autorité passe toujours en tête, sans jamais être
    // évincée par le plafond de résultats (cfg.maxTotalResults + 1 dans ce cas précis).
    let finalKept = kept;
    if (endpointData) {
      const synthetic = {
        id: null, title: endpointData.title, url: endpointData.url, domain: endpointData.domain,
        content: endpointData.content, rawContent: null, score: 1, publishedAt: endpointData.publishedAt,
        ageDays: 0, freshness: 'recent', favicon: null, sourceType: 'official',
        preferred: true, authoritative: true, queryIds: plan.map((p) => p.id), suspicious: false,
      };
      finalKept = [synthetic, ...kept].slice(0, cfg.maxTotalResults + 1);
    }
    finalKept.forEach((r, i) => { r.id = 'S' + (i + 1); });

    const sources = finalKept.map((r) => ({
      id: r.id, title: r.title, url: r.url, domain: r.domain, favicon: r.favicon,
      publishedAt: r.publishedAt, freshness: r.freshness, sourceType: r.sourceType, authoritative: !!r.authoritative,
    }));
    const answers = cfg.includeAnswer
      ? okRuns.filter((r) => r.answer).map((r) => ({ query: r.item.query, answer: r.answer }))
      : [];

    const totalMs = Date.now() - started;
    log.debug('search.done', {
      queries: runs.length, ok: okRuns.length, retrieved, kept: finalKept.length, rejected: rejected.length,
      domains: finalKept.map((r) => `${r.domain}(${r.sourceType}${r.authoritative ? ',authoritative' : r.preferred ? ',preferred' : ''})`),
      primaryDomain: finalKept[0] ? finalKept[0].domain : null,
      officialEndpointUsed: !!endpointData,
      rejectedDetail: rejected.map((r) => `${r.domain}:${r.reason}`),
      errors: errors.map((e) => e.code), totalMs,
    });

    return {
      triggered: true,
      ok: okRuns.length > 0 || !!endpointData,
      intent,
      queries: runs.map((r) => r.info),
      results: finalKept,
      sources,
      answers,
      rejected,
      error: (okRuns.length || endpointData) ? null : (errors[0] || { code: 'no_result', message: 'Aucune requête aboutie' }),
      meta: {
        retrieved, kept: finalKept.length, totalMs, searchedAt: now.toISOString(),
        partialFailure: errors.length > 0 && okRuns.length > 0, officialEndpointUsed: !!endpointData,
      },
    };
  } catch (e) {
    // Filet de sécurité : rien ne doit faire tomber le moteur de chat.
    log.error('search.unexpected', { message: String((e && e.message) || e) });
    return baseResult({ triggered: true, error: { code: 'unexpected', message: redact(String((e && e.message) || e)) }, meta: { retrieved: 0, kept: 0, totalMs: Date.now() - started, searchedAt: null } });
  }
}

// ───────────────────────────── 10. Compatibilité ────────────────────────────

/**
 * Rendu texte brut (ancien style) pour un promptBuilder pas encore migré.
 * Le futur promptBuilder v2 utilisera directement result.results.
 */
function formatResultsAsText(result) {
  if (!result || !Array.isArray(result.results) || !result.results.length) return '';
  return result.results.map((r) => {
    const meta = [r.domain, r.publishedAt ? r.publishedAt.slice(0, 10) : 'date inconnue', r.sourceType].join(' · ');
    return `[${r.id}] ${r.title} (${meta})\n${r.url}\n${r.content}`;
  }).join('\n\n');
}

/**
 * Compatibilité avec l'ancien contrat : renvoie un bloc texte ou null, ne lève jamais.
 * (Le moteur utilise désormais searchWeb() directement.)
 */
async function performWebSearch(query, options = {}) {
  const result = await searchWeb(query, { ...options, skipIntentCheck: true });
  return formatResultsAsText(result) || null;
}

module.exports = {
  searchWeb,
  performWebSearch,
  needsWebSearch,
  resolveWebIntent,
  buildSearchPlan,
  formatResultsAsText,
  registerRule,
  registerOfficialSource,
  classifySource,
  loadConfig,
  isVagueQuery,
  _internal: { redact, normalizeUrl, degradePayload, buildPayload, processResults, INTENT_RULES, OFFICIAL_SOURCES },
};

