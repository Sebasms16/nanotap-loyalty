// Lógica de sumar sello (RF-05) y canjear premio (RF-06), y su equivalente con
// puntos (sumar puntos por el monto de una compra y canjearlos por un premio)
// y con cashback (sumar saldo por el monto de una compra y usarlo para pagar).
// El cambio en la BD es atómico (funciones SQL en schema.sql). La actualización
// de los wallets se dispara después de responder: si Apple/Google fallan,
// el cambio ya quedó guardado y walletSync lo reintenta (RNF-03).
const supabase = require('../db/supabaseClient');
const walletSync = require('./walletSync.service');
const log = require('../utils/logger');
const { HttpError, errorDb } = require('../utils/errores');

const ERRORES_SQL = {
  cliente_no_encontrado: [404, 'Cliente no encontrado.'],
  cliente_de_otro_negocio: [403, 'Este cliente pertenece a otro negocio.'],
  negocio_inactivo: [403, 'El negocio está inactivo.'],
  sellos_insuficientes: [409, 'El cliente todavía no tiene suficientes sellos para canjear.'],
  programa_de_puntos: [409, 'Este negocio no usa estampas: registre el monto de la compra.'],
  programa_de_estampas: [409, 'Este negocio usa estampas, no puntos ni cashback.'],
  programa_sin_catalogo: [409, 'Este negocio no tiene catálogo de premios.'],
  programa_sin_cashback: [409, 'Este negocio no usa cashback.'],
  monto_sin_cashback: [400, 'El monto es muy bajo: no alcanza para sumar cashback.'],
  saldo_bajo_minimo: [409, 'El cliente todavía no alcanza el saldo mínimo para usarlo.'],
  saldo_insuficiente: [409, 'El cliente no tiene tanto saldo.'],
  monto_invalido: [400, 'Escriba el monto de la compra en colones.'],
  monto_insuficiente: [400, 'El monto no alcanza para sumar un punto.'],
  factura_requerida: [400, 'Este negocio pide el número de factura para sumar puntos.'],
  factura_repetida: [409, 'Esa factura ya se usó para sumar puntos.'],
  monto_sobre_tope: [403, 'La compra supera el tope del negocio: solo un administrador puede registrarla.'],
  compra_muy_seguida: [409, 'Este cliente acaba de sumar puntos. Espere unos minutos antes de registrar otra compra.'],
  premio_no_encontrado: [404, 'Ese premio ya no está en el catálogo.'],
  puntos_insuficientes: [409, 'El cliente no tiene suficientes puntos para ese premio.'],
};

async function ejecutar(funcion, tipo, clienteId, staff, extra = {}) {
  const contexto = { operacion: tipo, negocio_id: staff.negocio_id, cliente_id: clienteId, staff_id: staff.id };
  const { data, error } = await supabase.rpc(funcion, {
    p_cliente_id: clienteId,
    p_negocio_id: staff.negocio_id,
    p_staff_id: staff.id,
    ...extra,
  });

  if (error) {
    const conocido = Object.keys(ERRORES_SQL).find((clave) => error.message?.includes(clave));
    if (conocido) {
      log.warn(`${tipo} rechazado: ${conocido}`, contexto);
      throw new HttpError(...ERRORES_SQL[conocido]);
    }
    throw errorDb(error, funcion);
  }

  log.info(`${tipo} registrado`, {
    ...contexto,
    ...(data.puntos_actuales !== undefined ? { puntos_actuales: data.puntos_actuales } : { sellos_actuales: data.sellos_actuales }),
  });
  setImmediate(() => walletSync.sincronizarCliente(clienteId, { operacion: tipo }));
  return data;
}

module.exports = {
  sumarSello: (clienteId, staff) => ejecutar('sumar_sello', 'sello', clienteId, staff),
  canjearPremio: (clienteId, staff) => ejecutar('canjear_premio', 'canje', clienteId, staff),
  // El tope por compra no aplica al administrador del negocio (lo revisa la función SQL).
  sumarPuntos: (clienteId, staff, { monto, factura }) => ejecutar('sumar_puntos', 'puntos', clienteId, staff, {
    p_monto: monto, p_factura: factura || null, p_sin_tope: staff.rol === 'administrador',
  }),
  usarCashback: (clienteId, staff, monto) => ejecutar('usar_cashback', 'usar_cashback', clienteId, staff, { p_monto: monto }),
  canjearPuntos: (clienteId, staff, premioId) => ejecutar('canjear_puntos', 'canje_puntos', clienteId, staff, {
    p_premio_id: premioId,
  }),
};
