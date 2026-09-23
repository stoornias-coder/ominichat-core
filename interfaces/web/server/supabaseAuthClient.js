// Client Supabase séparé, avec la clé ANON (pas service_role), utilisé
// UNIQUEMENT pour les opérations d'authentification (signUp / signInWithPassword).
// Toutes les lectures/écritures de données passent par core/database/supabase.js
// (clé service_role, RLS contournée côté backend).

const { createClient } = require('@supabase/supabase-js');
const logger = require('../../../core/utils/logger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  logger.error('SUPABASE_URL ou SUPABASE_ANON_KEY manquant dans .env (nécessaire pour interfaces/web).');
}

const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = { supabaseAuth };
