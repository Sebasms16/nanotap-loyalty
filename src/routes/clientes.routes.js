// /api/clientes — consulta pública de saldo (RF-10) y operaciones del staff
// sobre un cliente (RF-05, RF-06). Eliminación por Ley 8968 (operador).
const express = require('express');
const supabase = require('../db/supabaseClient');
const clientes = require('../services/clientes.service');
const sellos = require('../services/sellos.service');
const niveles = require('../services/niveles.service');
const inactividad = require('../services/inactividad.service');
const puntos = require('../services/puntos.service');
const cashback = require('../services/cashback.service');
const v = require('../utils/validacion');
const { HttpError, errorDb } = require('../utils/errores');
const { requiereStaff, requiereOperador } = require('../middlewares/auth.middleware');
const { limiteConsulta } = require('../middlewares/limites.middleware');

const router = express.Router();

// RF-10 — consulta pública por teléfono. Solo devuelve el nombre de pila y los
// sellos, para no exponer datos personales a quien conozca un número.
// (Debe ir antes de /:id para que "consulta" no se tome como id.)
router.get('/consulta', limiteConsulta, async (req, res) => {
  const negocio = await clientes.negocioActivoPorSlug(req.query.slug || '');
  const telefono = v.telefono(req.query.telefono);
  const { data, error } = await supabase
    .from('clientes')
    .select('id, nombre, sellos_actuales, puntos, premios_canjeados, ultima_actividad, sorpresa_pendiente')
    .eq('negocio_id', negocio.id)
    .eq('telefono', telefono)
    .maybeSingle();
  if (error) throw errorDb(error, 'consulta de saldo');
  if (!data) throw new HttpError(404, 'No encontramos una tarjeta con ese teléfono en este negocio.');
  const estado = await niveles.estadoDelCliente(data, negocio);
  res.json({
    nombre: data.nombre,
    sellos_actuales: data.sellos_actuales,
    premios_canjeados: data.premios_canjeados,
    sellos_para_premio: negocio.sellos_para_premio,
    descripcion_premio: niveles.premioActual(negocio, estado),
    premio_disponible: data.sellos_actuales >= negocio.sellos_para_premio,
    nivel: niveles.paraMostrar(estado),
    vigencia: inactividad.aviso(data, negocio),
    tipo_programa: negocio.tipo_programa || 'estampas',
    puntos: puntos.paraMostrar(negocio, data.puntos), // null si el negocio no usa puntos
    cashback: cashback.paraMostrar(negocio, data.puntos), // null si el negocio no usa cashback
    sorpresa: data.sorpresa_pendiente || null, // premio sorpresa que ganó y todavía no retira
  });
});

// estado: nivel del cliente (null si el negocio no usa niveles).
// sorpresasPendientes: premios sorpresa que ganó y todavía no se le entregan.
function vistaStaff(c, estado, sorpresasPendientes = []) {
  return {
    sorpresas: sorpresasPendientes,
    id: c.id,
    nombre: [c.nombre, c.primer_apellido, c.segundo_apellido].filter(Boolean).join(' '),
    codigo_qr: c.codigo_qr,
    sellos_actuales: c.sellos_actuales,
    premios_canjeados: c.premios_canjeados,
    sellos_para_premio: c.negocio.sellos_para_premio,
    descripcion_premio: niveles.premioActual(c.negocio, estado),
    premio_disponible: c.sellos_actuales >= c.negocio.sellos_para_premio,
    nivel: niveles.paraMostrar(estado),
    creado_en: c.creado_en,
    tipo_programa: c.negocio.tipo_programa || 'estampas',
    // Con puntos: saldo, catálogo (con lo que le alcanza) y las reglas que el staff debe saber.
    puntos: puntos.esPuntos(c.negocio) ? {
      ...puntos.paraMostrar(c.negocio, c.puntos),
      factura_obligatoria: c.negocio.puntos_factura_obligatoria,
      tope_compra: c.negocio.puntos_tope_compra,
    } : null,
    // Con cashback: saldo en colones, el % y si ya lo puede usar.
    cashback: cashback.esCashback(c.negocio) ? {
      ...cashback.paraMostrar(c.negocio, c.puntos),
      factura_obligatoria: c.negocio.puntos_factura_obligatoria,
      tope_compra: c.negocio.puntos_tope_compra,
    } : null,
  };
}

// El cliente tal como lo ve el staff, con su nivel al día.
async function clienteParaStaff(idOCodigo, staff) {
  const cliente = await clientes.clienteDelStaff(idOCodigo, staff);
  const estado = await niveles.estadoDelCliente(cliente, cliente.negocio);
  let pendientes = [];
  if (cliente.sorpresa_pendiente) { // solo se consulta si tiene alguna
    const { data, error } = await supabase
      .from('premios_sorpresa').select('id, premio, estampa, creado_en')
      .eq('cliente_id', cliente.id).is('entregado_en', null).order('creado_en');
    if (error) throw errorDb(error, 'leer premios sorpresa');
    pendientes = data;
  }
  return { cliente, estado, vista: vistaStaff(cliente, estado, pendientes) };
}

// Acepta el id del cliente o el código leído del QR (ej. "POD-2026-D5471AC9").
router.get('/:id', requiereStaff, async (req, res) => {
  const { vista } = await clienteParaStaff(req.params.id, req.staff);
  res.json({ cliente: vista });
});

router.post('/:id/sello', requiereStaff, async (req, res) => {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Cliente no encontrado.');
  const r = await sellos.sumarSello(req.params.id, req.staff);
  res.json({ ...r, cliente: (await clienteParaStaff(req.params.id, req.staff)).vista });
});

// Entrega de un premio sorpresa pendiente del cliente.
router.post('/:id/sorpresas/:sorpresa/entregar', requiereStaff, async (req, res) => {
  if (!v.esUuid(req.params.id) || !v.esUuid(req.params.sorpresa)) throw new HttpError(404, 'No se encontró ese premio sorpresa.');
  const antes = await clienteParaStaff(req.params.id, req.staff);
  if (!antes.vista.sorpresas.some((s) => s.id === req.params.sorpresa)) {
    throw new HttpError(409, 'Ese premio sorpresa ya se entregó o no es de este cliente.');
  }
  const r = await sellos.entregarSorpresa(req.params.id, req.staff, req.params.sorpresa);
  res.json({ ...r, cliente: (await clienteParaStaff(req.params.id, req.staff)).vista });
});

router.post('/:id/canje', requiereStaff, async (req, res) => {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Cliente no encontrado.');
  // El premio que se entrega es el del nivel ANTES de canjear; el canje puede subirlo.
  const antes = await clienteParaStaff(req.params.id, req.staff);
  const r = await sellos.canjearPremio(req.params.id, req.staff);
  const despues = await clienteParaStaff(req.params.id, req.staff);
  res.json({
    ...r,
    premio_entregado: niveles.premioActual(antes.cliente.negocio, antes.estado),
    subio_de_nivel: Boolean(antes.estado && despues.estado && antes.estado.nivel.clave !== despues.estado.nivel.clave),
    cliente: despues.vista,
  });
});

// Programa de puntos o de cashback: el staff manda el monto de la compra (y la
// factura); los puntos o el saldo los calcula la base de datos con las reglas del negocio.
router.post('/:id/puntos', requiereStaff, async (req, res) => {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Cliente no encontrado.');
  const monto = v.entero(req.body.monto, 'monto de la compra', { min: 1, max: 100000000 });
  const factura = v.texto(req.body.factura, 'número de factura', { max: 60 }) || null;
  const antes = await clienteParaStaff(req.params.id, req.staff);
  const r = await sellos.sumarPuntos(req.params.id, req.staff, { monto, factura });
  const despues = await clienteParaStaff(req.params.id, req.staff);
  res.json({
    ...r,
    subio_de_nivel: Boolean(antes.estado && despues.estado && antes.estado.nivel.clave !== despues.estado.nivel.clave),
    cliente: despues.vista,
  });
});

router.post('/:id/canje-puntos', requiereStaff, async (req, res) => {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Cliente no encontrado.');
  const premioId = v.texto(req.body.premio_id, 'premio', { requerido: true, max: 64 });
  const r = await sellos.canjearPuntos(req.params.id, req.staff, premioId);
  res.json({ ...r, cliente: (await clienteParaStaff(req.params.id, req.staff)).vista });
});

// Cashback: el cliente paga parte de la compra con su saldo (monto en colones).
router.post('/:id/usar-saldo', requiereStaff, async (req, res) => {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Cliente no encontrado.');
  const monto = v.entero(req.body.monto, 'monto a usar del saldo', { min: 1, max: 100000000 });
  const r = await sellos.usarCashback(req.params.id, req.staff, monto);
  res.json({ ...r, cliente: (await clienteParaStaff(req.params.id, req.staff)).vista });
});

// Ley 8968 — eliminación completa a solicitud del cliente (la ejecuta el operador).
router.delete('/:id', requiereOperador, async (req, res) => {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Cliente no encontrado.');
  await clientes.eliminarCliente(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
