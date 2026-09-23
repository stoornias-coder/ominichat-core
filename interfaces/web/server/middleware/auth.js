// Middleware d'authentification pour l'interface Web.
//
// Attend un header `Authorization: Bearer <access_token>` (le token renvoyé
// par Supabase Auth au login). Le vérifie auprès de Supabase (via le client
// service_role, qui peut interroger GoTrue pour n'importe quel token), puis
// résout/crée l'utilisateur Core correspondant (table `users`,
// auth_user_id). Injecte `req.user` (ligne Core) et `req.authUser`
// (utilisateur Supabase Auth brut) pour les routes suivantes.

const db = require('../../../../core/database/supabase');
const logger = require('../../../../core/utils/logger');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Authentification requise (Bearer token manquant).' });
  }

  try {
    const { data, error } = await db.supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Session invalide ou expirée.' });
    }

    const authUser = data.user;
    const user = await db.getOrCreateUserByAuthId(authUser.id);

    req.authUser = authUser;
    req.user = user;
    next();
  } catch (err) {
    logger.error("Erreur lors de la vérification de l'authentification", err);
    res.status(500).json({ error: 'Erreur interne pendant la vérification de la session.' });
  }
}

module.exports = { requireAuth };
