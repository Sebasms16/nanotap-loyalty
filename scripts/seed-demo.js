// Crea un negocio de prueba con un usuario de staff (DoD #1).
// Uso: npm run seed:demo -- [slug] [contraseña]
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const supabase = require('../src/db/supabaseClient');
const env = require('../src/config/env');

async function main() {
  const slug = process.argv[2] || 'demo';
  const password = process.argv[3] || crypto.randomBytes(6).toString('base64url');

  let { data: negocio, error } = await supabase.from('negocios').select('*').eq('slug', slug).maybeSingle();
  if (error) throw error;
  if (!negocio) {
    ({ data: negocio, error } = await supabase.from('negocios').insert({
      nombre: 'Café Demo',
      slug,
      color_primario: '#3b2417',
      color_secundario: '#fff4e6',
      sellos_para_premio: 5,
      descripcion_premio: 'Café americano gratis',
    }).select().single());
    if (error) throw error;
  }

  const { error: e } = await supabase.from('staff').upsert({
    negocio_id: negocio.id,
    usuario: 'demo',
    nombre: 'Staff de prueba',
    password_hash: await bcrypt.hash(password, 12),
    activo: true,
  }, { onConflict: 'negocio_id,usuario' });
  if (e) throw e;

  console.log(`
Negocio de prueba listo: ${negocio.nombre}
  Inscripción:  ${env.baseUrl}/${slug}/inscripcion
  Staff:        ${env.baseUrl}/${slug}/staff
  Usuario:      demo
  Contraseña:   ${password}
`);
}

main().catch((error) => {
  console.error('No se pudo crear el negocio de prueba:', error.message || error);
  process.exit(1);
});
