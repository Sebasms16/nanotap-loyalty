// /api/clientes — consulta pública de saldo (RF-10) y operaciones del staff
// sobre un cliente (RF-05, RF-06). Eliminación por Ley 8968 (operador).
const express = require('express');
const supabase = require('../db/supabaseClient');
const clientes = require('../services/clientes.service');
const sellos = require('../services/sellos.service');
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
    .select('nombre, sellos_actuales, premios_canjeados')
    .eq('negocio_id', negocio.id)
    .eq('telefono', telefono)
    .maybeSingle();
  if (error) throw errorDb(error, 'consulta de saldo');
  if (!data) throw new HttpError(404, 'No encontramos una tarjeta con ese teléfono en este negocio.');
  res.json({
    nombre: data.nombre,
    sellos_actuales: data.sellos_actuales,
    premios_canjeados: data.premios_canjeados,
    sellos_para_premio: negocio.sellos_para_premio,
    descripcion_premio: negocio.descripcion_premio,
    premio_disponible: data.sellos_actuales >= negocio.sellos_para_premio,
  });
});

function vistaStaff(c) {
  return {
    id: c.id,
    nombre: [c.nombre, c.primer_apellido, c.segundo_apellido].filter(Boolean).join(' '),
    codigo_qr: c.codigo_qr,
    sellos_actuales: c.sellos_actuales,
    premios_canjeados: c.premios_canjeados,
    sellos_para_premio: c.negocio.sellos_para_premio,
    descripcion_premio: c.negocio.descripcion_premio,
    premio_disponible: c.sellos_actuales >= c.negocio.sellos_para_premio,
    creado_en: c.creado_en,
  };
}

// Acepta el id del cliente o el código leído del QR (ej. "POD-2026-D5471AC9").
router.get('/:id', requiereStaff, async (req, res) => {
  const cliente = await clientes.clienteDelStaff(req.params.id, req.staff);
  res.json({ cliente: vistaStaff(cliente) });
});

router.post('/:id/sello', requiereStaff, async (req, res) => {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Cliente no encontrado.');
  const r = await sellos.sumarSello(req.params.id, req.staff);
  res.json(r);
});

router.post('/:id/canje', requiereStaff, async (req, res) => {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Cliente no encontrado.');
  const r = await sellos.canjearPremio(req.params.id, req.staff);
  res.json(r);
});

// Ley 8968 — eliminación completa a solicitud del cliente (la ejecuta el operador).
router.delete('/:id', requiereOperador, async (req, res) => {
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Cliente no encontrado.');
  await clientes.eliminarCliente(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
