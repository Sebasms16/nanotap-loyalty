// Cliente único de Supabase con la service_role key. Solo se usa en el servidor:
// las tablas tienen RLS activado sin políticas, así que la anon key no ve nada.
const { createClient } = require('@supabase/supabase-js');
const env = require('../config/env');

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = supabase;
