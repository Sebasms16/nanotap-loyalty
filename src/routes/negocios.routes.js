// /api/negocios — alta y edición de negocios (operador), datos públicos,
// inscripción de clientes (RF-02), staff del negocio y exportación CSV (RF-09).
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../db/supabaseClient');
const env = require('../config/env');
const clientes = require('../services/clientes.service');
const marca = require('../services/marca.service');
const estampas = require('../services/estampas.service');
const log = require('../utils/logger');
const v = require('../utils/validacion');
const { aCsv } = require('../utils/csv');
const reglas = require('../utils/reglas');
const niveles = require('../services/niveles.service');
const sorpresas = require('../services/sorpresas.service');
const { HttpError, errorDb } = require('../utils/errores');
const { requiereOperador, requiereStaffUOperador } = require('../middlewares/auth.middleware');
const { limiteInscripcion, limiteConsulta } = require('../middlewares/limites.middleware');

const router = express.Router();

// Niveles: [{clave, tarjetas, puntos, compras, premio}]. Bronce empieza en 0; los demás
// necesitan cada vez más tarjetas canjeadas (estampas), puntos ganados (puntos) o
// colones comprados (cashback) en la temporada. Se guardan las tres metas: el programa
// del negocio elige cuál usa.
function validarNiveles(lista) {
  if (lista === null) return null;
  if (!Array.isArray(lista)) throw new HttpError(400, 'Los niveles no tienen el formato esperado.');
  let tarjetasAntes = 0;
  let puntosAntes = 0;
  let comprasAntes = 0;
  return niveles.NIVELES.map((nivel) => {
    const dado = lista.find((n) => n?.clave === nivel.clave) || {};
    const premio = v.texto(dado.premio, `premio del nivel ${nivel.nombre}`, { max: 120 }) || '';
    if (nivel.clave === 'bronce') return { clave: nivel.clave, tarjetas: 0, puntos: 0, compras: 0, premio };
    const tarjetas = v.entero(dado.tarjetas ?? niveles.TARJETAS_POR_DEFECTO[nivel.clave],
      `tarjetas para ${nivel.nombre}`, { min: 1, max: 100 });
    const puntos = v.entero(dado.puntos ?? niveles.PUNTOS_POR_DEFECTO[nivel.clave],
      `puntos para ${nivel.nombre}`, { min: 1, max: 100000000 });
    const compras = v.entero(dado.compras ?? niveles.COMPRAS_POR_DEFECTO[nivel.clave],
      `compras (₡) para ${nivel.nombre}`, { min: 1, max: 1000000000 });
    if (tarjetas <= tarjetasAntes) {
      throw new HttpError(400, `${nivel.nombre} debe pedir más tarjetas que el nivel anterior.`);
    }
    if (puntos <= puntosAntes) {
      throw new HttpError(400, `${nivel.nombre} debe pedir más puntos que el nivel anterior.`);
    }
    if (compras <= comprasAntes) {
      throw new HttpError(400, `${nivel.nombre} debe pedir más compras que el nivel anterior.`);
    }
    tarjetasAntes = tarjetas;
    puntosAntes = puntos;
    comprasAntes = compras;
    return { clave: nivel.clave, tarjetas, puntos, compras, premio };
  });
}

// Catálogo de premios de un programa de puntos: [{id, nombre, puntos}], hasta 12.
// Los premios nuevos reciben un id; los que ya tenían lo conservan (el staff canjea por id).
function validarCatalogo(lista) {
  if (!Array.isArray(lista)) throw new HttpError(400, 'El catálogo de premios no tiene el formato esperado.');
  if (lista.length > 12) throw new HttpError(400, 'El catálogo admite hasta 12 premios.');
  const ids = new Set();
  return lista.map((p, i) => {
    const nombre = v.texto(p?.nombre, `nombre del premio ${i + 1}`, { requerido: true, max: 60 });
    const puntos = v.entero(p?.puntos, `puntos del premio "${nombre}"`, { min: 1, max: 100000000 });
    let id = typeof p?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p.id) ? p.id : crypto.randomUUID();
    if (ids.has(id)) id = crypto.randomUUID();
    ids.add(id);
    return { id, nombre, puntos };
  }).sort((a, b) => a.puntos - b.puntos);
}

// Entero positivo o null (para quitar el tope o la espera).
const enteroONulo = (valor, nombre, limites) => (valor === null || valor === '' ? null : v.entero(valor, nombre, limites));

// Fecha AAAA-MM-DD válida (puede ser futura: una temporada que todavía no empieza).
function fechaValida(valor, nombre) {
  const texto = String(valor);
  const fecha = new Date(`${texto}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto) || Number.isNaN(fecha.getTime()) || fecha.toISOString().slice(0, 10) !== texto) {
    throw new HttpError(400, `La fecha de ${nombre} no es válida.`);
  }
  return texto;
}

// Opción de una lista cerrada, o null si se permite quitarla.
function unaDe(valor, opciones, mensaje, { anulable = false } = {}) {
  if (anulable && (valor === null || valor === '')) return null;
  if (!opciones.includes(valor)) throw new HttpError(400, mensaje);
  return valor;
}

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
  if (cuerpo.estampa_final_url === null) d.estampa_final_url = null;
  if (cuerpo.estampas_pendientes !== undefined) {
    if (!['gris', 'ocultas'].includes(cuerpo.estampas_pendientes)) {
      throw new HttpError(400, 'Las estampas pendientes deben verse "gris" u "ocultas".');
    }
    d.estampas_pendientes = cuerpo.estampas_pendientes;
  }
  if (cuerpo.ocultar_nombre !== undefined) d.ocultar_nombre = Boolean(cuerpo.ocultar_nombre);
  if (cuerpo.niveles_activos !== undefined) d.niveles_activos = Boolean(cuerpo.niveles_activos);
  if (cuerpo.niveles !== undefined) d.niveles = validarNiveles(cuerpo.niveles);
  if (cuerpo.temporada_meses !== undefined) {
    d.temporada_meses = v.entero(cuerpo.temporada_meses, 'duración de la temporada (meses)', { min: 1, max: 12 });
  }
  if (cuerpo.temporada_inicio !== undefined) {
    d.temporada_inicio = cuerpo.temporada_inicio ? fechaValida(cuerpo.temporada_inicio, 'inicio de la temporada') : null;
  }
  // null = las estampas no se reinician nunca.
  if (cuerpo.inactividad_meses !== undefined) {
    d.inactividad_meses = cuerpo.inactividad_meses === null ? null
      : v.entero(cuerpo.inactividad_meses, 'meses sin actividad para reiniciar la tarjeta', { min: 1, max: 36 });
  }
  // La foto de fondo se sube con POST /:id/imagenes/fondo; aquí solo se puede quitar.
  if (cuerpo.fondo_estampas_url === null) d.fondo_estampas_url = null;
  if (cuerpo.fondo_estampas_efecto !== undefined) {
    d.fondo_estampas_efecto = unaDe(cuerpo.fondo_estampas_efecto, estampas.EFECTOS_FONDO, 'El efecto de la foto de fondo no es válido.');
  }
  // Programa de puntos o de cashback (en vez de estampas) y sus reglas.
  if (cuerpo.tipo_programa !== undefined) {
    d.tipo_programa = unaDe(cuerpo.tipo_programa, ['estampas', 'puntos', 'cashback'], 'El programa debe ser de estampas, puntos o cashback.');
  }
  if (cuerpo.cashback_porcentaje !== undefined) {
    const pct = Number(cuerpo.cashback_porcentaje);
    if (!Number.isFinite(pct) || pct < 0.5 || pct > 50 || Math.abs(Math.round(pct * 10) - pct * 10) > 1e-9) {
      throw new HttpError(400, 'El cashback debe ser entre 0,5 % y 50 %, con un decimal como máximo.');
    }
    d.cashback_porcentaje = Math.round(pct * 10) / 10;
  }
  if (cuerpo.cashback_minimo !== undefined) {
    d.cashback_minimo = enteroONulo(cuerpo.cashback_minimo, 'saldo mínimo para usar el cashback', { min: 1, max: 100000000 });
  }
  if (cuerpo.cashback_texto_franja !== undefined) d.cashback_texto_franja = Boolean(cuerpo.cashback_texto_franja);
  // Premios sorpresa (estampas): probabilidad por estampa, lista de premios y tope al mes.
  if (cuerpo.sorpresas_activas !== undefined) d.sorpresas_activas = Boolean(cuerpo.sorpresas_activas);
  if (cuerpo.sorpresas_probabilidad !== undefined) {
    const pct = Number(cuerpo.sorpresas_probabilidad);
    if (!Number.isFinite(pct) || pct < 0.5 || pct > 50 || Math.abs(Math.round(pct * 10) - pct * 10) > 1e-9) {
      throw new HttpError(400, 'La probabilidad del premio sorpresa debe ser entre 0,5 % y 50 %, con un decimal como máximo.');
    }
    d.sorpresas_probabilidad = Math.round(pct * 10) / 10;
  }
  if (cuerpo.sorpresas_premios !== undefined) {
    try {
      d.sorpresas_premios = sorpresas.paraGuardar(cuerpo.sorpresas_premios);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
  }
  if (d.sorpresas_activas && d.sorpresas_premios && !d.sorpresas_premios.length) {
    throw new HttpError(400, 'Escriba al menos un premio sorpresa, o desactive los premios sorpresa.');
  }
  if (cuerpo.sorpresas_tope_mes !== undefined) {
    d.sorpresas_tope_mes = enteroONulo(cuerpo.sorpresas_tope_mes, 'máximo de premios sorpresa al mes', { min: 1, max: 100000 });
  }
  if (cuerpo.colones_por_punto !== undefined) {
    d.colones_por_punto = v.entero(cuerpo.colones_por_punto, 'colones por punto', { min: 1, max: 1000000 });
  }
  if (cuerpo.premios_puntos !== undefined) d.premios_puntos = validarCatalogo(cuerpo.premios_puntos);
  if (cuerpo.puntos_factura_obligatoria !== undefined) d.puntos_factura_obligatoria = Boolean(cuerpo.puntos_factura_obligatoria);
  if (cuerpo.puntos_tope_compra !== undefined) {
    d.puntos_tope_compra = enteroONulo(cuerpo.puntos_tope_compra, 'tope por compra', { min: 1, max: 100000000 });
  }
  if (cuerpo.puntos_espera_minutos !== undefined) {
    d.puntos_espera_minutos = enteroONulo(cuerpo.puntos_espera_minutos, 'minutos de espera entre compras', { min: 1, max: 1440 });
  }
  if (cuerpo.suscripcion_plan !== undefined) {
    d.suscripcion_plan = unaDe(cuerpo.suscripcion_plan, ['semestral', 'anual'], 'El plan debe ser semestral o anual.', { anulable: true });
  }
  if (cuerpo.suscripcion_inicio !== undefined) {
    d.suscripcion_inicio = cuerpo.suscripcion_inicio ? fechaValida(cuerpo.suscripcion_inicio, 'inicio de la suscripción') : null;
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
  if (datos.niveles_activos && !datos.temporada_inicio) datos.temporada_inicio = niveles.temporadaActual({}).clave;
  if (req.body.reglas !== undefined) {
    datos.reglas = reglas.paraGuardar(v.texto(req.body.reglas, 'reglas', { max: 3000 }), {
      sellos_para_premio: 10, descripcion_premio: 'Producto gratis', ...datos,
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
  const activaSinFecha = datos.niveles_activos && datos.temporada_inicio === undefined;
  if (req.body.reglas !== undefined || activaSinFecha) {
    const { data: actual, error: e } = await supabase.from('negocios').select('*').eq('id', req.params.id).maybeSingle();
    if (e) throw errorDb(e, 'leer negocio');
    if (!actual) throw new HttpError(404, 'Negocio no encontrado.');
    // Al activar los niveles sin fecha, la primera temporada empieza hoy (queda guardada).
    if (activaSinFecha && !actual.temporada_inicio) datos.temporada_inicio = niveles.temporadaActual({}).clave;
    if (req.body.reglas !== undefined) {
      datos.reglas = reglas.paraGuardar(v.texto(req.body.reglas, 'reglas', { max: 3000 }), { ...actual, ...datos });
    }
  }
  if (!Object.keys(datos).length) throw new HttpError(400, 'No hay cambios para guardar.');
  const { data, error } = await supabase.from('negocios').update(datos).eq('id', req.params.id).select().maybeSingle();
  if (error) throw errorDb(error, 'editar negocio');
  if (!data) throw new HttpError(404, 'Negocio no encontrado.');

  const afectaTarjeta = ['nombre', 'logo_url', 'sello_url', 'estampa_final_url','color_primario', 'color_secundario', 'color_fondo_sellos',
    'sellos_para_premio', 'descripcion_premio', 'reglas', 'estampas_pendientes', 'ocultar_nombre',
    'niveles_activos', 'niveles', 'temporada_meses', 'temporada_inicio', 'inactividad_meses',
    'fondo_estampas_url', 'fondo_estampas_efecto', 'tipo_programa', 'colones_por_punto', 'premios_puntos',
    'puntos_factura_obligatoria', 'cashback_porcentaje', 'cashback_minimo', 'cashback_texto_franja',
    'sorpresas_activas', 'sorpresas_premios'].some((k) => k in datos);
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

// Subida del logo, de la imagen general de la estampa, de la última estampa (final)
// o de la foto de fondo de las estampas.
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

// La tarjeta de un cliente que ya existía, desde el enlace que se le envió al correo.
// El token va en el cuerpo (no en la URL) para que no quede en los registros.
router.post('/:slug/tarjeta', limiteConsulta, async (req, res) => {
  res.json(await clientes.tarjetaPorEnlace(req.params.slug, req.body?.token));
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
  { titulo: 'puntos', valor: (c) => c.puntos },
  { titulo: 'premios_canjeados', valor: (c) => c.premios_canjeados },
  { titulo: 'fecha_inscripcion', valor: (c) => c.creado_en },
];

const COLUMNAS_EVENTOS = [
  { titulo: 'fecha', valor: (e) => e.creado_en },
  { titulo: 'tipo', valor: (e) => e.tipo },
  { titulo: 'puntos', valor: (e) => e.cantidad },
  { titulo: 'monto', valor: (e) => e.monto },
  { titulo: 'factura', valor: (e) => e.factura },
  { titulo: 'premio', valor: (e) => e.premio },
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
      .select('creado_en, tipo, cantidad, monto, factura, premio, cliente:clientes!inner(codigo_qr, nombre, primer_apellido, negocio_id), staff(usuario)')
      .eq('cliente.negocio_id', negocio.id)
      .order('creado_en')))
    : aCsv(COLUMNAS_CLIENTES, await todasLasFilas(() => supabase
      .from('clientes')
      .select('nombre, primer_apellido, segundo_apellido, telefono, correo, codigo_qr, sellos_actuales, puntos, premios_canjeados, creado_en')
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
    .from('staff').select('id, usuario, nombre, activo, rol, creado_en') // nunca password_hash
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
    rol: req.body.rol === undefined ? 'staff' : v.rolStaff(req.body.rol),
    password_hash: await bcrypt.hash(password, 12),
  }).select('id, usuario, nombre, activo, rol, creado_en').single();
  if (error?.code === '23505') throw new HttpError(409, 'Ya existe un usuario con ese nombre en este negocio.');
  if (error?.code === '23503') throw new HttpError(404, 'Negocio no encontrado.');
  if (error) throw errorDb(error, 'crear staff');
  log.info('staff creado', { negocio_id: req.params.id, staff_id: data.id, operacion: 'crear_staff' });
  res.status(201).json({ staff: data });
});

module.exports = router;
