// Sesiones con JWT (cabecera Authorization: Bearer <token>).
//  - Staff: el token lleva su negocio_id; todas las operaciones se limitan a ese
//    negocio (RF-04). En cada request se verifica que el staff y su negocio
//    sigan activos, para que desactivar a alguien tenga efecto inmediato.
//  - Operador: un único rol con contraseña en OPERADOR_PASSWORD.
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const supabase = require('../db/supabaseClient');
const { HttpError, errorDb } = require('../utils/errores');

const DURACION_STAFF = '12h';
const DURACION_OPERADOR = '8h';

function firmarStaff(staff) {
  return jwt.sign({ rol: 'staff', negocio_id: staff.negocio_id }, env.jwtSecret, {
    subject: staff.id, expiresIn: DURACION_STAFF,
  });
}

function firmarOperador() {
  return jwt.sign({ rol: 'operador' }, env.jwtSecret, { subject: 'operador', expiresIn: DURACION_OPERADOR });
}

// Comparación en tiempo constante para la contraseña del operador.
function passwordOperadorValida(intento) {
  const a = crypto.createHash('sha256').update(String(intento || '')).digest();
  const b = crypto.createHash('sha256').update(env.operadorPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

function leerToken(req) {
  const [tipo, token] = (req.get('authorization') || '').split(' ');
  if (tipo !== 'Bearer' || !token) return null;
  try {
    return jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

async function cargarStaff(payload) {
  const { data, error } = await supabase
    .from('staff')
    .select('id, negocio_id, usuario, nombre, activo, rol, negocio:negocios(id, slug, nombre, activo)')
    .eq('id', payload.sub)
    .maybeSingle();
  if (error) throw errorDb(error, 'verificar sesión de staff');
  if (!data || !data.activo || data.negocio_id !== payload.negocio_id) {
    throw new HttpError(401, 'Su sesión ya no es válida. Inicie sesión de nuevo.');
  }
  if (!data.negocio.activo) throw new HttpError(403, 'El negocio está inactivo.');
  return data;
}

// Exige sesión de staff. Deja req.staff = { id, negocio_id, negocio, ... }.
async function requiereStaff(req, res, next) {
  const payload = leerToken(req);
  if (payload?.rol !== 'staff') return next(new HttpError(401, 'Inicie sesión para continuar.'));
  req.staff = await cargarStaff(payload);
  next();
}

// Exige sesión de staff con rol de administrador (el dueño): ve el análisis del negocio.
async function requiereAdministrador(req, res, next) {
  const payload = leerToken(req);
  if (payload?.rol !== 'staff') return next(new HttpError(401, 'Inicie sesión para continuar.'));
  req.staff = await cargarStaff(payload);
  if (req.staff.rol !== 'administrador') return next(new HttpError(403, 'Solo el administrador del negocio puede ver el análisis.'));
  next();
}

function requiereOperador(req, res, next) {
  const payload = leerToken(req);
  if (payload?.rol !== 'operador') return next(new HttpError(401, 'Acceso solo para el operador.'));
  req.operador = true;
  next();
}

// Para rutas compartidas (ej. exportación CSV): deja req.staff o req.operador.
async function requiereStaffUOperador(req, res, next) {
  const payload = leerToken(req);
  if (payload?.rol === 'operador') {
    req.operador = true;
    return next();
  }
  if (payload?.rol === 'staff') {
    req.staff = await cargarStaff(payload);
    return next();
  }
  next(new HttpError(401, 'Inicie sesión para continuar.'));
}

module.exports = {
  firmarStaff, firmarOperador, passwordOperadorValida, requiereStaff, requiereAdministrador, requiereOperador,
  requiereStaffUOperador,
};
