// /api/negocios — alta y edición de negocios (operador), datos públicos,
// inscripción de clientes (RF-02), staff del negocio y exportación CSV (RF-09).
const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../db/supabaseClient');
const env = require('../config/env');
const clientes = require('../services/clientes.service');
const marca = require('../services/marca.service');
const log = require('../utils/logger');
const v = require('../utils/validacion');
const { aCsv } = require('../utils/csv');
const reglas = require('../utils/reglas');
const { HttpError, errorDb } = require('../utils/errores');
const { requiereOperador, requiereStaffUOperador } = require('../middlewares/auth.middleware');
const { limiteInscripcion } = require('../middlewares/limites.middleware');

const router = express.Router();

function datosNegocio(cuerpo, { parcial }) {
  const d = {};
  if (!parcial || cuerpo.nombre !== undefined) d.nombre = v.texto(cuerpo.nombre, 'nombre', { requerido: true });
  if (cuerpo.logo_url !== undefined) d.logo_url = v.urlHttps(cuerpo.logo_url, 'logo_url');
  if (cuerpo.color_primario !== undefined) d.color_primario = v.color(cuerpo.color_primario, 'color primario');
  if (cuerpo.color_secundario !== undefined) d.color_secundario = v.color(cuerpo.color_secundario, 'color secundario');
  // null = usar el color de la tarjeta
  if (cuerpo.color_fondo_sellos !== undefined) {
    d.color_fondo_sellos = cuerpo.color_fondo_sellos ? v.color(cuerpo.color_fondo_sellos, 'fondo de las estampas') : null;
  }
  // Las imágenes se suben con POST /:id/imagenes/:tipo; aquí solo se pueden quitar.
  if (cuerpo.sello_url === null) d.sello_url = null;
  if (cuerpo.estampas_pendientes !== undefined) {
    if (!['gris', 'ocultas'].includes(cuerpo.estampas_pendientes)) {
      throw new HttpError(400, 'Las estampas pendientes deben verse "gris" u "ocultas".');
    }
    d.estampas_pendientes = cuerpo.estampas_pendientes;
  }
  if (cuerpo.sellos_para_premio !== undefined) {
    d.sellos_para_premio = v.entero(cuerpo.sellos_para_premio, 'sellos para premio', { min: 1, max: 30 });
  }
  if (cuerpo.descripcion_premio !== undefined) {
    d.descripcion_premio = v.texto(cuerpo.descripcion_premio, 'descripción del premio', { requerido: true, max: 120 });
  }
  if (parcial && cuerpo.activo !== undefined) d.activo = Boolean(cuerpo.activo);
  for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
  return d;
}

// Marca todas las tarjetas del negocio para re-sincronizar (Apple y Google) en segundo plano.
async function refrescarTarjetas(negocioId) {
  const { data, error } = await supabase.rpc('encolar_sync_negocio', { p_negocio_id: negocioId });
  if (!error) return data;
  log.error('no se pudieron encolar las tarjetas del negocio', { negocio_id: negocioId, error: errorDb(error, 'encolar') });
  return 0;
}

// RF-01 — alta de negocio
router.post('/', requiereOperador, async (req, res) => {
  const datos = { ...datosNegocio(req.body, { parcial: false }), slug: v.slug(req.body.slug) };
  if (req.body.reglas !== undefined) {
    datos.reglas = reglas.paraGuardar(v.texto(req.body.reglas, 'reglas', { max: 3000 }), {
      nombre: datos.nombre,
      sellos_para_premio: datos.sellos_para_premio ?? 10,
      descripcion_premio: datos.descripcion_premio ?? 'Producto gratis',
    });
  }
  const { data, error } = await supabase.from('negocios').insert(datos).select().single();
  if (error?.code === '23505') throw new HttpError(409, 'Ese slug ya está en uso. Elija otro.');
  if (error) throw errorDb(error, 'crear negocio');
  log.info('negocio creado', { negocio_id: data.id, operacion: 'crear_negocio', slug: data.slug });
  res.status(201).json({ negocio: data, url_inscripcion: `${env.baseUrl}/${data.slug}/inscripcion` });
});

// Edición (incluye activar/desactivar, RF-08). Si cambia algo que se ve en la
// tarjeta, se re-sincronizan todas las tarjetas del negocio en segundo plano.
router.patch('/:id', requiereOperador, async (req, res) => {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Negocio no encontrado.');
  const datos = datosNegocio(req.body, { parcial: true });
  if (req.body.reglas !== undefined) {
    const { data: actual, error: e } = await supabase.from('negocios').select('*').eq('id', req.params.id).maybeSingle();
    if (e) throw errorDb(e, 'leer negocio');
    if (!actual) throw new HttpError(404, 'Negocio no encontrado.');
    datos.reglas = reglas.paraGuardar(v.texto(req.body.reglas, 'reglas', { max: 3000 }), { ...actual, ...datos });
  }
  if (!Object.keys(datos).length) throw new HttpError(400, 'No hay cambios para guardar.');
  const { data, error } = await supabase.from('negocios').update(datos).eq('id', req.params.id).select().maybeSingle();
  if (error) throw errorDb(error, 'editar negocio');
  if (!data) throw new HttpError(404, 'Negocio no encontrado.');

  const afectaTarjeta = ['nombre', 'logo_url', 'sello_url', 'color_primario', 'color_secundario', 'color_fondo_sellos',
    'sellos_para_premio', 'descripcion_premio', 'reglas', 'estampas_pendientes'].some((k) => k in datos);
  const tarjetasEnCola = afectaTarjeta ? await refrescarTarjetas(data.id) : 0;
  log.info('negocio editado', { negocio_id: data.id, operacion: 'editar_negocio', campos: Object.keys(datos), tarjetasEnCola });
  res.json({ negocio: data, tarjetas_en_cola: tarjetasEnCola });
});

// Guarda la imagen subida con `guardar(buffer)` y re-sincroniza las tarjetas. El
// cuerpo es el archivo tal cual (Content-Type image/png, image/jpeg, image/webp o image/svg+xml).
async function recibirImagen(req, res, guardar) {
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    throw new HttpError(415, 'Suba una imagen PNG, JPG, WebP o SVG.');
  }
  let negocio;
  try {
    negocio = await guardar(req.body);
  } catch (error) {
    if (/unsupported image format|Input buffer|corrupt/i.test(error.message)) {
      throw new HttpError(415, 'El archivo no es una imagen válida. Use PNG, JPG, WebP o SVG.');
    }
    throw error;
  }
  if (!negocio) throw new HttpError(404, 'Negocio no encontrado.');
  res.json({ negocio, tarjetas_en_cola: await refrescarTarjetas(negocio.id) });
}
const crudo = express.raw({ type: 'image/*', limit: '5mb' });

// Subida del logo o de la imagen general de la estampa.
router.post('/:id/imagenes/:tipo', requiereOperador, crudo, async (req, res) => {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Negocio no encontrado.');
  if (!marca.TIPOS[req.params.tipo]) throw new HttpError(404, 'Tipo de imagen desconocido.');
  await recibirImagen(req, res, (buffer) => marca.subirImagen(req.params.id, req.params.tipo, buffer));
});

// Imagen propia de una estampa (posición 1 a 30). DELETE la quita y esa
// posición vuelve a usar la imagen general.
function posicionEstampa(req) {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Negocio no encontrado.');
  return v.entero(req.params.posicion, 'posición de la estampa', { min: 1, max: 30 });
}

router.post('/:id/estampas/:posicion', requiereOperador, crudo, async (req, res) => {
  const posicion = posicionEstampa(req);
  await recibirImagen(req, res, (buffer) => marca.subirEstampa(req.params.id, posicion, buffer));
});

router.delete('/:id/estampas/:posicion', requiereOperador, async (req, res) => {
  const negocio = await marca.quitarEstampa(req.params.id, posicionEstampa(req));
  if (!negocio) throw new HttpError(404, 'Negocio no encontrado.');
  res.json({ negocio, tarjetas_en_cola: await refrescarTarjetas(negocio.id) });
});

// Datos públicos para pintar el formulario de inscripción
router.get('/:slug', async (req, res) => {
  const negocio = await clientes.negocioActivoPorSlug(req.params.slug);
  res.json({
    negocio: clientes.negocioPublico(negocio),
    wallets: { apple: env.apple.habilitado, google: env.google.habilitado },
    contacto_privacidad: env.contactoPrivacidad,
  });
});

// RF-02 — inscripción pública
router.post('/:slug/clientes', limiteInscripcion, async (req, res) => {
  const negocio = await clientes.negocioActivoPorSlug(req.params.slug);
  const tarjeta = await clientes.inscribir(negocio, req.body || {});
  res.status(tarjeta.existente ? 200 : 201).json(tarjeta);
});

// ---------------------------------------------------------------------------
// RF-09 — exportación CSV (staff de ese negocio u operador)
//   ?tipo=clientes (por defecto) o ?tipo=eventos (historial de sellos y canjes)
// ---------------------------------------------------------------------------
async function todasLasFilas(construir) {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await construir().range(desde, desde + 999);
    if (error) throw errorDb(error, 'exportar');
    filas.push(...data);
    if (data.length < 1000) return filas;
  }
}

const COLUMNAS_CLIENTES = [
  { titulo: 'nombre', valor: (c) => c.nombre },
  { titulo: 'primer_apellido', valor: (c) => c.primer_apellido },
  { titulo: 'segundo_apellido', valor: (c) => c.segundo_apellido },
  { titulo: 'telefono', valor: (c) => c.telefono },
  { titulo: 'correo', valor: (c) => c.correo },
  { titulo: 'codigo_qr', valor: (c) => c.codigo_qr },
  { titulo: 'sellos_actuales', valor: (c) => c.sellos_actuales },
  { titulo: 'premios_canjeados', valor: (c) => c.premios_canjeados },
  { titulo: 'fecha_inscripcion', valor: (c) => c.creado_en },
];

const COLUMNAS_EVENTOS = [
  { titulo: 'fecha', valor: (e) => e.creado_en },
  { titulo: 'tipo', valor: (e) => e.tipo },
  { titulo: 'codigo_qr', valor: (e) => e.cliente?.codigo_qr },
  { titulo: 'cliente', valor: (e) => [e.cliente?.nombre, e.cliente?.primer_apellido].filter(Boolean).join(' ') },
  { titulo: 'staff', valor: (e) => e.staff?.usuario },
];

router.get('/:slug/clientes/export', requiereStaffUOperador, async (req, res) => {
  const { data: negocio, error } = await supabase
    .from('negocios').select('id, slug').eq('slug', String(req.params.slug).toLowerCase()).maybeSingle();
  if (error) throw errorDb(error, 'buscar negocio');
  if (!negocio) throw new HttpError(404, 'Negocio no encontrado.');
  if (req.staff && req.staff.negocio_id !== negocio.id) throw new HttpError(403, 'No tiene acceso a este negocio.');

  const tipo = req.query.tipo === 'eventos' ? 'eventos' : 'clientes';
  const csv = tipo === 'eventos'
    ? aCsv(COLUMNAS_EVENTOS, await todasLasFilas(() => supabase
      .from('sellos_eventos')
      .select('creado_en, tipo, cliente:clientes!inner(codigo_qr, nombre, primer_apellido, negocio_id), staff(usuario)')
      .eq('cliente.negocio_id', negocio.id)
      .order('creado_en')))
    : aCsv(COLUMNAS_CLIENTES, await todasLasFilas(() => supabase
      .from('clientes')
      .select('nombre, primer_apellido, segundo_apellido, telefono, correo, codigo_qr, sellos_actuales, premios_canjeados, creado_en')
      .eq('negocio_id', negocio.id)
      .order('creado_en')));

  log.info('exportación CSV', {
    negocio_id: negocio.id, operacion: 'export', tipo, por: req.staff ? `staff:${req.staff.id}` : 'operador',
  });
  const fecha = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${negocio.slug}-${tipo}-${fecha}.csv"`);
  res.send(csv);
});

// ---------------------------------------------------------------------------
// Staff de un negocio (operador)
// ---------------------------------------------------------------------------
router.get('/:id/staff', requiereOperador, async (req, res) => {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Negocio no encontrado.');
  const { data, error } = await supabase
    .from('staff').select('id, usuario, nombre, activo, creado_en') // nunca password_hash
    .eq('negocio_id', req.params.id).order('creado_en');
  if (error) throw errorDb(error, 'listar staff');
  res.json({ staff: data });
});

router.post('/:id/staff', requiereOperador, async (req, res) => {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Negocio no encontrado.');
  const usuario = v.texto(req.body.usuario, 'usuario', { requerido: true, max: 50 }).toLowerCase();
  const password = String(req.body.password || '');
  if (password.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');
  const { data, error } = await supabase.from('staff').insert({
    negocio_id: req.params.id,
    usuario,
    nombre: v.texto(req.body.nombre, 'nombre'),
    password_hash: await bcrypt.hash(password, 12),
  }).select('id, usuario, nombre, activo, creado_en').single();
  if (error?.code === '23505') throw new HttpError(409, 'Ya existe un usuario con ese nombre en este negocio.');
  if (error?.code === '23503') throw new HttpError(404, 'Negocio no encontrado.');
  if (error) throw errorDb(error, 'crear staff');
  log.info('staff creado', { negocio_id: req.params.id, staff_id: data.id, operacion: 'crear_staff' });
  res.status(201).json({ staff: data });
});

module.exports = router;
