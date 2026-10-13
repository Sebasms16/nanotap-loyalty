// Reglas del programa de lealtad que se muestran en el reverso de la tarjeta y
// en la página de inscripción. Cada negocio puede tener las suyas (una por línea
// en negocios.reglas); si no tiene, se usan estas sugeridas.
function reglasSugeridas(negocio) {
  const total = negocio.sellos_para_premio;
  return [
    `Recibe una estampa por cada compra en ${negocio.nombre}, mostrando esta tarjeta al momento de pagar.`,
    `Al completar ${total} estampas recibe: ${negocio.descripcion_premio}.`,
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
