// Reinicio de la tarjeta por inactividad (opcional por negocio).
//
// Si el negocio fija inactividad_meses, a quien pase ese tiempo sin recibir una
// estampa ni canjear se le vuelven a cero las estampas (función SQL
// reiniciar_inactivos, que corre cada hora desde el worker). La tarjeta le
// avisa la fecha límite para que no lo tome por sorpresa.
const supabase = require('../db/supabaseClient');
const log = require('../utils/logger');
const { errorDb } = require('../utils/errores');

const ZONA = 'America/Costa_Rica';

const activo = (negocio) => Number.isInteger(negocio?.inactividad_meses) && negocio.inactividad_meses > 0;

// Suma meses como Postgres (el 31 de enero + 1 mes es el 28 o 29 de febrero).
function sumarMeses(fecha, meses) {
  const f = new Date(fecha);
  const dia = f.getUTCDate();
  f.setUTCDate(1);
  f.setUTCMonth(f.getUTCMonth() + meses);
  const ultimoDia = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 0)).getUTCDate();
  f.setUTCDate(Math.min(dia, ultimoDia));
  return f;
}

// Instante en que se reinician las estampas del cliente si no vuelve (null si no aplica).
function fechaLimite(cliente, negocio) {
  if (!activo(negocio) || !cliente.ultima_actividad) return null;
  return sumarMeses(cliente.ultima_actividad, negocio.inactividad_meses);
}

const formato = (fecha) => new Intl.DateTimeFormat('es-CR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: ZONA })
  .format(fecha);

const plazo = (meses) => `${meses} ${meses === 1 ? 'mes' : 'meses'}`;

// Línea para las reglas sugeridas del programa.
function regla(negocio) {
  const meses = negocio.inactividad_meses;
  return `Si ${meses === 1 ? 'pasa' : 'pasan'} ${plazo(meses)} sin recibir una estampa, las estampas acumuladas vuelven a cero.`;
}

// Aviso para el cliente (reverso de la tarjeta y consulta): con estampas, la fecha límite.
function aviso(cliente, negocio) {
  if (!activo(negocio)) return null;
  const limite = fechaLimite(cliente, negocio);
  if (!cliente.sellos_actuales || !limite) return regla(negocio);
  return `Reciba su próxima estampa antes del ${formato(limite)}; si no, sus estampas vuelven a cero.`;
}

async function reiniciarInactivos() {
  const { data, error } = await supabase.rpc('reiniciar_inactivos');
  if (error) throw errorDb(error, 'reiniciar tarjetas inactivas');
  if (data) log.info('tarjetas reiniciadas por inactividad', { operacion: 'reinicio_inactividad', clientes: data });
  return data;
}

module.exports = { activo, fechaLimite, regla, aviso, reiniciarInactivos };
