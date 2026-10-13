// /api/staff — login del staff (RF-04) y administración de usuarios (operador).
const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../db/supabaseClient');
const log = require('../utils/logger');
const v = require('../utils/validacion');
const { HttpError, errorDb } = require('../utils/errores');
const { firmarStaff, requiereStaff, requiereOperador } = require('../middlewares/auth.middleware');
const { limiteLogin } = require('../middlewares/limites.middleware');

const router = express.Router();

// Hash ficticio para que un usuario inexistente tarde lo mismo que uno real.
const HASH_FICTICIO = bcrypt.hashSync('nanotap-sin-usuario', 12);

router.post('/login', limiteLogin, async (req, res) => {
  const slug = String(req.body.negocio || '').trim().toLowerCase();
  const usuario = String(req.body.usuario || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const errorCredenciales = new HttpError(401, 'Usuario o contraseña incorrectos.');
  if (!slug || !usuario || !password) throw errorCredenciales;

  const { data: negocio, error } = await supabase
    .from('negocios').select('id, slug, nombre, activo').eq('slug', slug).maybeSingle();
  if (error) throw errorDb(error, 'login: buscar negocio');
  // El código del negocio es público (va en el enlace de inscripción), así que se
  // puede decir que no existe; usuario y contraseña siguen con el mensaje genérico.
  if (!negocio) {
    log.warn('login de staff fallido: negocio inexistente', { operacion: 'login_staff', slug, usuario });
    throw new HttpError(401, `No existe un negocio con el código "${slug.slice(0, 60)}". Revise el enlace de staff de su negocio.`);
  }

  const r = await supabase
    .from('staff').select('id, negocio_id, usuario, nombre, activo, password_hash')
    .eq('negocio_id', negocio.id).eq('usuario', usuario).maybeSingle();
  if (r.error) throw errorDb(r.error, 'login: buscar staff');
  const staff = r.data;

  const valida = await bcrypt.compare(password, staff?.password_hash || HASH_FICTICIO);
  if (!staff || !valida || !staff.activo) {
    log.warn('login de staff fallido', { operacion: 'login_staff', negocio_id: negocio.id, usuario });
    throw errorCredenciales;
  }
  if (!negocio.activo) throw new HttpError(403, 'El negocio está inactivo. Contacte a Nanotap.');

  log.info('login de staff', { operacion: 'login_staff', negocio_id: negocio.id, staff_id: staff.id });
  res.json({
    token: firmarStaff(staff),
    staff: { id: staff.id, usuario: staff.usuario, nombre: staff.nombre },
    negocio: { slug: negocio.slug, nombre: negocio.nombre },
  });
});

// Datos de la sesión actual (el panel lo usa al cargar).
router.get('/yo', requiereStaff, async (req, res) => {
  const { data: negocio, error } = await supabase
    .from('negocios')
    .select('slug, nombre, logo_url, color_primario, color_secundario, sellos_para_premio, descripcion_premio')
    .eq('id', req.staff.negocio_id).single();
  if (error) throw errorDb(error, 'leer negocio del staff');
  res.json({
    staff: { id: req.staff.id, usuario: req.staff.usuario, nombre: req.staff.nombre },
    negocio,
  });
});

// Operador: activar/desactivar, cambiar nombre o restablecer contraseña.
router.patch('/:id', requiereOperador, async (req, res) => {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Usuario no encontrado.');
  const cambios = {};
  if (req.body.activo !== undefined) cambios.activo = Boolean(req.body.activo);
  if (req.body.nombre !== undefined) cambios.nombre = v.texto(req.body.nombre, 'nombre');
  if (req.body.password !== undefined) {
    if (String(req.body.password).length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');
    cambios.password_hash = await bcrypt.hash(String(req.body.password), 12);
  }
  if (!Object.keys(cambios).length) throw new HttpError(400, 'No hay cambios para guardar.');
  const { data, error } = await supabase
    .from('staff').update(cambios).eq('id', req.params.id)
    .select('id, negocio_id, usuario, nombre, activo, creado_en').maybeSingle();
  if (error) throw errorDb(error, 'editar staff');
  if (!data) throw new HttpError(404, 'Usuario no encontrado.');
  log.info('staff editado', {
    operacion: 'editar_staff', staff_id: data.id, negocio_id: data.negocio_id,
    campos: Object.keys(cambios).map((k) => (k === 'password_hash' ? 'password' : k)),
  });
  res.json({ staff: data });
});

module.exports = router;
