const express = require('express');
const db = require('../../../../core/database/supabase');
const sessionManager = require('../../../../core/session/sessionManager');
const engine = require('../../../../core/engine');
const logger = require('../../../../core/utils/logger');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/sessions?page=0 — liste paginée des conversations de l'utilisateur.
router.get('/', async (req, res) => {
  const page = parseInt(req.query.page, 10) || 0;
  const { sessions, total, pageSize } = await sessionManager.listUserSessionsPage(req.user, page);
  res.json({ sessions, total, page, pageSize });
});

// POST /api/sessions { characterId?, title? } — nouvelle conversation.
router.post('/', async (req, res) => {
  const { characterId = null, title } = req.body || {};
  try {
    const session = await sessionManager.startNewSession(req.user, { characterId, title });
    res.status(201).json({ session });
  } catch (err) {
    logger.error('Erreur création session (web)', err);
    res.status(500).json({ error: 'Impossible de créer la conversation.' });
  }
});

// GET /api/sessions/active — session active de l'utilisateur (comme Telegram).
router.get('/active', async (req, res) => {
  const session = await sessionManager.getOrCreateActiveSession(req.user);
  res.json({ session });
});

// GET /api/sessions/:id — détail d'une conversation (avec personnage).
router.get('/:id', async (req, res) => {
  const session = await sessionManager.getSessionDetails(req.params.id);
  if (!session || session.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Conversation introuvable.' });
  }
  res.json({ session });
});

// POST /api/sessions/:id/activate — bascule la session active (identique à /sessions dans Telegram).
router.post('/:id/activate', async (req, res) => {
  const session = await sessionManager.switchToSession(req.user, req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Conversation introuvable.' });
  }
  res.json({ session });
});

// GET /api/sessions/:id/messages?limit=&offset= — historique paginé.
router.get('/:id/messages', async (req, res) => {
  const session = await db.getSession(req.params.id);
  if (!session || session.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Conversation introuvable.' });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const total = await db.getMessagesCount(session.id);
  const offset = req.query.offset !== undefined ? parseInt(req.query.offset, 10) || 0 : Math.max(0, total - limit);

  const messages = await db.getMessagesPage(session.id, { limit, offset });
  res.json({ messages, total, offset, limit });
});

// POST /api/sessions/:id/messages { text } — envoie un message, exécute le
// Core (1 seul appel IA, mémoire, recherche web), renvoie la réponse.
// C'est le SEUL endpoit qui appelle le moteur IA côté Web, comme
// handleIncomingMessage() côté Telegram.
router.post('/:id/messages', async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Le champ "text" est requis.' });
  }

  const session = await db.getSession(req.params.id);
  if (!session || session.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Conversation introuvable.' });
  }

  try {
    const { reply, character } = await engine.processMessage({
      user: req.user,
      session,
      text: text.trim(),
    });
    res.json({ reply, character: { id: character.id, name: character.name } });
  } catch (err) {
    logger.error('Erreur traitement message (web)', err);
    res.status(502).json({ error: "Le moteur IA n'a pas pu répondre, réessaie dans quelques secondes." });
  }
});

module.exports = router;
