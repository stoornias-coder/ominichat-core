const express = require('express');
const { supabaseAuth } = require('../supabaseAuthClient');
const db = require('../../../../core/database/supabase');
const logger = require('../../../../core/utils/logger');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// POST /api/auth/signup { email, password }
// Crée le compte Supabase Auth, puis la ligne Core "users" correspondante
// (auth_user_id). Si la confirmation email est activée côté projet
// Supabase, `session` sera null tant que l'email n'est pas confirmé.
router.post('/signup', async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Email valide et mot de passe (8 caractères min.) requis.' });
  }

  const { data, error } = await supabaseAuth.auth.signUp({ email, password });
  if (error) {
    logger.warn('Échec signup', error.message);
    return res.status(400).json({ error: error.message });
  }

  if (data.user) {
    try {
      await db.getOrCreateUserByAuthId(data.user.id);
    } catch (err) {
      logger.error('Échec création user Core après signup', err.message);
      return res.status(500).json({ error: 'Compte créé mais initialisation interne échouée.' });
    }
  }

  res.status(201).json({
    user: data.user ? { id: data.user.id, email: data.user.email } : null,
    session: data.session, // null si confirmation email requise
    requiresEmailConfirmation: !data.session,
  });
});

// POST /api/auth/login { email, password }
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }

  await db.getOrCreateUserByAuthId(data.user.id).catch((err) => {
    logger.error('Échec résolution user Core après login', err.message);
  });

  res.json({
    user: { id: data.user.id, email: data.user.email },
    session: data.session, // { access_token, refresh_token, expires_at, ... }
  });
});

// POST /api/auth/refresh { refresh_token }
router.post('/refresh', async (req, res) => {
  const { refresh_token: refreshToken } = req.body || {};
  if (!refreshToken) {
    return res.status(400).json({ error: 'refresh_token requis.' });
  }

  const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });
  if (error) {
    return res.status(401).json({ error: 'Impossible de rafraîchir la session.' });
  }

  res.json({ session: data.session });
});

// GET /api/auth/me — vérifie le token et renvoie l'utilisateur Core courant.
router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: req.user,
    authUser: { id: req.authUser.id, email: req.authUser.email },
  });
});

module.exports = router;
