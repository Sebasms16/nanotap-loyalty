const { HttpError } = require('./errores');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
// Rutas propias de la app que no pueden usarse como slug de negocio.
const SLUGS_RESERVADOS = new Set([
  'api', 'staff', 'operador', 'css', 'js', 'img', 'vendor', 'salud', 'privacidad', 'consulta',
]);

function esUuid(valor) {
  return typeof valor === 'string' && UUID_RE.test(valor);
}

function texto(valor, campo, { requerido = false, max = 100 } = {}) {
  const limpio = typeof valor === 'string' ? valor.trim() : '';
  if (!limpio) {
    if (requerido) throw new HttpError(400, `El campo "${campo}" es obligatorio.`);
    return null;
  }
  if (limpio.length > max) throw new HttpError(400, `El campo "${campo}" es demasiado largo.`);
  return limpio;
}

// Teléfonos de Costa Rica: se guardan solo dígitos y sin el prefijo 506,
// para que "8888-7777", "+506 8888 7777" y "88887777" sean el mismo cliente.
function normalizarTelefono(valor) {
  let digitos = String(valor || '').replace(/\D/g, '');
  if (digitos.length === 11 && digitos.startsWith('506')) digitos = digitos.slice(3);
  return digitos;
}

function telefono(valor) {
  const t = normalizarTelefono(valor);
  if (t.length < 8 || t.length > 15) {
    throw new HttpError(400, 'Ingrese un número de teléfono válido (8 dígitos).');
  }
  return t;
}

function correo(valor) {
  const c = texto(valor, 'correo', { requerido: true, max: 254 })?.toLowerCase();
  if (!CORREO_RE.test(c)) throw new HttpError(400, 'Ingrese un correo electrónico válido.');
  return c;
}

function fecha(valor, campo) {
  const f = texto(valor, campo, { max: 10 });
  if (!f) return null;
  const d = new Date(`${f}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || Number.isNaN(d.getTime()) || d > new Date() || d.getUTCFullYear() < 1900) {
    throw new HttpError(400, `La fecha "${campo}" no es válida.`);
  }
  return f;
}

function color(valor, campo) {
  if (valor === undefined || valor === null || valor === '') return undefined;
  if (!COLOR_RE.test(valor)) throw new HttpError(400, `El color "${campo}" debe tener formato #RRGGBB.`);
  return valor.toLowerCase();
}

function slug(valor) {
  const s = String(valor || '').trim().toLowerCase();
  if (!SLUG_RE.test(s) || SLUGS_RESERVADOS.has(s)) {
    throw new HttpError(400, 'El slug solo puede tener minúsculas, números y guiones (ej. "podosport").');
  }
  return s;
}

function urlHttps(valor, campo) {
  const u = texto(valor, campo, { max: 500 });
  if (!u) return null;
  try {
    if (new URL(u).protocol !== 'https:') throw new Error();
  } catch {
    throw new HttpError(400, `"${campo}" debe ser una URL https:// válida.`);
  }
  return u;
}

// Rol de un usuario de staff: 'staff' (escanea) o 'administrador' (también ve el análisis).
function rolStaff(valor) {
  if (!['staff', 'administrador'].includes(valor)) throw new HttpError(400, 'El rol debe ser "staff" o "administrador".');
  return valor;
}

function entero(valor, campo, { min, max }) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `"${campo}" debe ser un número entero entre ${min} y ${max}.`);
  }
  return n;
}

module.exports = {
  esUuid, texto, normalizarTelefono, telefono, correo, fecha, color, slug, urlHttps, entero, rolStaff,
};
