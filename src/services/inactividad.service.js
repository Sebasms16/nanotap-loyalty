// Reinicio de la tarjeta por inactividad (opcional por negocio).
//
// Si el negocio fija inactividad_dias, a quien pase ese tiempo sin recibir una
// estampa ni canjear se le vuelven a cero las estampas (función SQL
// reiniciar_inactivos, que corre cada hora desde el worker). La tarjeta le
// avisa la fecha límite para que no lo tome por sorpresa.
const supabase = require('../db/supabaseClient');
const log = require('../utils/logger');
const { errorDb } = require('../utils/errores');

const DIA_MS = 24 * 60 * 60 * 1000;
const ZONA = 'America/Costa_Rica';

const activo = (negocio) => Number.isInteger(negocio?.inactividad_dias) && negocio.inactividad_dias > 0;

// Instante en que se reinician las estampas del cliente si no vuelve (null si no aplica).
function fechaLimite(cliente, negocio) {
  if (!activo(negocio) || !cliente.ultima_actividad) return null;
  return new Date(new Date(cliente.ultima_actividad).getTime() + negocio.inactividad_dias * DIA_MS);
}

const formato = (fecha) => new Intl.DateTimeFormat('es-CR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: ZONA })
  .format(fecha);

const plazo = (dias) => `${dias} ${dias === 1 ? 'día' : 'días'}`;

// Línea para las reglas sugeridas del programa.
function regla(negocio) {
  return `Si pasan ${plazo(negocio.inactividad_dias)} sin recibir una estampa, las estampas acumuladas vuelven a cero.`;
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
