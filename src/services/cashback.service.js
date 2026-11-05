// Programa de cashback: la otra alternativa a las estampas (tipo_programa = 'cashback').
//
// - El staff digita el monto de la compra; la función SQL sumar_puntos (la misma
//   de los puntos) le suma al cliente el cashback_porcentaje de la compra en
//   colones, hacia abajo, con las mismas reglas: factura, tope y espera.
// - El saldo se guarda en clientes.puntos (en colones) y el cliente lo usa para
//   pagar parte de una compra: usar_cashback resta lo que digita el staff, nunca
//   más de lo que tiene. Si el negocio fija cashback_minimo, hay que alcanzarlo
//   antes de poder usarlo.
// - Los niveles por temporada, si están activos, suben por los colones comprados
//   en la temporada (compras_en_rango).
const { formatoColones } = require('./puntos.service');

const esCashback = (negocio) => negocio?.tipo_programa === 'cashback';

// Puntos y cashback guardan un saldo (clientes.puntos) y suman por el monto de la compra.
const usaSaldo = (negocio) => ['puntos', 'cashback'].includes(negocio?.tipo_programa);

const porcentaje = (negocio) => Number(negocio?.cashback_porcentaje) || 5;
const minimo = (negocio) => (Number.isInteger(negocio?.cashback_minimo) && negocio.cashback_minimo > 0 ? negocio.cashback_minimo : null);

// "5 %" o "2,5 %"
const formatoPorcentaje = (valor) => `${new Intl.NumberFormat('es-CR', { maximumFractionDigits: 1 }).format(valor)} %`;

// Cashback que daría un monto (lo mismo que calcula sumar_puntos).
const calcular = (negocio, monto) => Math.floor((monto * porcentaje(negocio)) / 100 + 1e-9);

// "5 % de cada compra"
const regla = (negocio) => `${formatoPorcentaje(porcentaje(negocio))} de cada compra`;

// El cliente ya puede usar su saldo (tiene algo y, si hay mínimo, lo alcanzó).
const puedeUsar = (negocio, saldo) => saldo > 0 && saldo >= (minimo(negocio) || 0);

function reglasDeCashback(negocio) {
  const min = minimo(negocio);
  return [
    `Recibe el ${regla(negocio)} en ${negocio.nombre} como saldo en su tarjeta, mostrándola al momento de pagar.`,
    min
      ? `Cuando su saldo llegue a ${formatoColones(min)}, puede usarlo para pagar parte o el total de una compra.`
      : 'Puede usar su saldo para pagar parte o el total de una compra.',
    ...(negocio.puntos_factura_obligatoria ? ['Para sumar cashback se pide el número de factura de la compra.'] : []),
  ];
}

// Datos para el navegador (staff, consulta, inscripción).
function paraMostrar(negocio, saldo = 0) {
  if (!esCashback(negocio)) return null;
  return {
    saldo,
    porcentaje: porcentaje(negocio),
    regla: regla(negocio),
    minimo: minimo(negocio),
    puede_usar: puedeUsar(negocio, saldo),
    faltan_para_usar: minimo(negocio) ? Math.max(0, minimo(negocio) - saldo) : 0,
  };
}

module.exports = {
  esCashback, usaSaldo, porcentaje, minimo, calcular, regla, puedeUsar, reglasDeCashback, paraMostrar,
  formatoPorcentaje, formatoColones,
};
