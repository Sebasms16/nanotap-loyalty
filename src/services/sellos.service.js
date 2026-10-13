// Lógica de sumar sello (RF-05) y canjear premio (RF-06).
// El cambio en la BD es atómico (funciones SQL en schema.sql). La actualización
// de los wallets se dispara después de responder: si Apple/Google fallan,
// el sello ya quedó guardado y walletSync lo reintenta (RNF-03).
const supabase = require('../db/supabaseClient');
const walletSync = require('./walletSync.service');
const log = require('../utils/logger');
const { HttpError, errorDb } = require('../utils/errores');

const ERRORES_SQL = {
  cliente_no_encontrado: [404, 'Cliente no encontrado.'],
  cliente_de_otro_negocio: [403, 'Este cliente pertenece a otro negocio.'],
  negocio_inactivo: [403, 'El negocio está inactivo.'],
  sellos_insuficientes: [409, 'El cliente todavía no tiene suficientes sellos para canjear.'],
};

async function ejecutar(funcion, tipo, clienteId, staff) {
  const contexto = { operacion: tipo, negocio_id: staff.negocio_id, cliente_id: clienteId, staff_id: staff.id };
  const { data, error } = await supabase.rpc(funcion, {
    p_cliente_id: clienteId,
    p_negocio_id: staff.negocio_id,
    p_staff_id: staff.id,
  });

  if (error) {
    const conocido = Object.keys(ERRORES_SQL).find((clave) => error.message?.includes(clave));
    if (conocido) {
      log.warn(`${tipo} rechazado: ${conocido}`, contexto);
      throw new HttpError(...ERRORES_SQL[conocido]);
    }
    throw errorDb(error, funcion);
  }

  log.info(`${tipo} registrado`, { ...contexto, sellos_actuales: data.sellos_actuales });
  setImmediate(() => walletSync.sincronizarCliente(clienteId, { operacion: tipo }));
  return data;
}

module.exports = {
  sumarSello: (clienteId, staff) => ejecutar('sumar_sello', 'sello', clienteId, staff),
  canjearPremio: (clienteId, staff) => ejecutar('canjear_premio', 'canje', clienteId, staff),
};
