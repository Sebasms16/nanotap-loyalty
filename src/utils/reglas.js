// Reglas del programa de lealtad que se muestran en el reverso de la tarjeta y
// en la página de inscripción. Cada negocio puede tener las suyas (una por línea
// en negocios.reglas); si no tiene, se usan estas sugeridas.
const niveles = require('../services/niveles.service');
const inactividad = require('../services/inactividad.service');
const puntos = require('../services/puntos.service');
const cashback = require('../services/cashback.service');

function reglasDeNiveles(negocio) {
  const lista = niveles.configuracion(negocio);
  const meses = negocio.temporada_meses || niveles.MESES_POR_DEFECTO;
  const duracion = `Cada temporada dura ${meses} ${meses === 1 ? 'mes' : 'meses'}. Al terminar, todos vuelven a Bronce`;
  if (puntos.esPuntos(negocio)) {
    return [
      'Según los puntos que gane en la temporada, sube de nivel:',
      ...lista.map((n) => {
        const desde = n.tarjetas === 0 ? 'desde la inscripción' : `al ganar ${puntos.formatoPuntos(n.tarjetas)} puntos en la temporada`;
        return `${n.emoji} ${n.nombre} (${desde})${n.premio ? `: ${n.premio}` : ''}.`;
      }),
      `${duracion}; los puntos que tenga se conservan.`,
    ];
  }
  if (cashback.esCashback(negocio)) {
    return [
      'Según lo que compre en la temporada, sube de nivel:',
      ...lista.map((n) => {
        const desde = n.tarjetas === 0 ? 'desde la inscripción' : `al comprar ${puntos.formatoColones(n.tarjetas)} en la temporada`;
        return `${n.emoji} ${n.nombre} (${desde})${n.premio ? `: ${n.premio}` : ''}.`;
      }),
      `${duracion}; el saldo que tenga se conserva.`,
    ];
  }
  return [
    `Al completar ${negocio.sellos_para_premio} estampas recibe el premio de su nivel:`,
    ...lista.map((n) => (n.tarjetas === 0
      ? `${n.emoji} ${n.nombre} (desde la inscripción): ${n.premio}.`
      : `${n.emoji} ${n.nombre} (al canjear ${n.tarjetas} tarjetas en la temporada): ${n.premio}.`)),
    `${duracion}; las estampas que lleve se conservan.`,
  ];
}

function reglasSugeridas(negocio) {
  if (cashback.esCashback(negocio)) {
    return [
      ...cashback.reglasDeCashback(negocio),
      ...(niveles.activos(negocio) ? reglasDeNiveles(negocio) : []),
      ...(inactividad.activo(negocio) ? [inactividad.regla(negocio)] : []),
      'El saldo solo se usa en compras en el negocio: no se cambia por dinero en efectivo.',
      'El cashback no se otorga por compras anteriores a la inscripción.',
      'La tarjeta es personal: el saldo no se puede transferir a otra persona.',
      'No acumulable con otras promociones, salvo que el negocio indique lo contrario.',
      `${negocio.nombre} puede modificar o terminar el programa avisándolo con anticipación.`,
    ];
  }
  if (puntos.esPuntos(negocio)) {
    return [
      ...puntos.reglasDePuntos(negocio),
      ...(niveles.activos(negocio) ? reglasDeNiveles(negocio) : []),
      ...(inactividad.activo(negocio) ? [inactividad.regla(negocio)] : []),
      'Los premios no se pueden cambiar por dinero en efectivo ni por otro producto.',
      'Los puntos no tienen valor comercial y no se otorgan por compras anteriores.',
      'La tarjeta es personal: los puntos y premios no se pueden transferir a otra persona.',
      'No acumulable con otras promociones, salvo que el negocio indique lo contrario.',
      `${negocio.nombre} puede modificar o terminar el programa avisándolo con anticipación.`,
    ];
  }
  const total = negocio.sellos_para_premio;
  return [
    `Recibe una estampa por cada compra en ${negocio.nombre}, mostrando esta tarjeta al momento de pagar.`,
    ...(niveles.activos(negocio) ? reglasDeNiveles(negocio) : [`Al completar ${total} estampas recibe: ${negocio.descripcion_premio}.`]),
    ...(inactividad.activo(negocio) ? [inactividad.regla(negocio)] : []),
    'El premio no se puede cambiar por dinero en efectivo ni por otro producto.',
    'Las estampas no tienen valor comercial y no se otorgan por compras anteriores.',
    'La tarjeta es personal: las estampas y premios no se pueden transferir a otra persona.',
    'No acumulable con otras promociones, salvo que el negocio indique lo contrario.',
    `${negocio.nombre} puede modificar o terminar el programa avisándolo con anticipación.`,
  ];
}

// Convierte el texto guardado en una lista (una regla por línea, sin viñetas).
function aLista(texto) {
  return String(texto || '')
    .split(/\r?\n/)
    .map((linea) => linea.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

function reglasDelNegocio(negocio) {
  const propias = aLista(negocio.reglas);
  return propias.length ? propias : reglasSugeridas(negocio);
}

// Texto para guardar: null si quedó vacío o igual a las sugeridas, para que las
// sugeridas sigan al día si cambia el nombre, el premio o la cantidad de estampas.
function paraGuardar(texto, negocio) {
  const lista = aLista(texto);
  if (!lista.length) return null;
  if (lista.join('\n') === reglasSugeridas(negocio).join('\n')) return null;
  return lista.join('\n');
}

// Lista con viñetas, para el reverso de Apple y el detalle de Google.
function reglasComoTexto(negocio) {
  return reglasDelNegocio(negocio).map((regla) => `• ${regla}`).join('\n');
}

module.exports = { reglasSugeridas, reglasDelNegocio, reglasComoTexto, paraGuardar, aLista };
