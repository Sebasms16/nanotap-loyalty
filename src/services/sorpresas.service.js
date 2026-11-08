// Premios sorpresa (solo en programas de estampas).
//
// - Al sumar una estampa, la función SQL sumar_sello decide al azar si trae un premio
//   sorpresa: con sorpresas_probabilidad (%) y eligiendo uno de sorpresas_premios
//   (un premio repetido en la lista sale más seguido).
// - Nunca en la estampa que completa la tarjeta, máximo uno por tarjeta (hasta el
//   próximo canje) y, si el negocio fija sorpresas_tope_mes, no más que eso al mes.
// - Queda pendiente en premios_sorpresa (y en clientes.sorpresa_pendiente, para las
//   tarjetas) hasta que el staff lo entrega (entregar_sorpresa).
const MAX_PREMIOS = 20;
const MAX_LARGO = 60;

const activas = (negocio) => Boolean(negocio?.sorpresas_activas)
  && (negocio.tipo_programa || 'estampas') === 'estampas' && premios(negocio).length > 0;

function premios(negocio) {
  return (Array.isArray(negocio?.sorpresas_premios) ? negocio.sorpresas_premios : [])
    .map((p) => String(p || '').trim()).filter(Boolean);
}

const probabilidad = (negocio) => Number(negocio?.sorpresas_probabilidad) || 5;

// 5 → "1 de cada 20 estampas"; 30 → "1 de cada 3 estampas" (aprox.)
const unaDeCada = (pct) => `1 de cada ${Math.max(2, Math.round(100 / pct))} estampas`;

// Normaliza la lista que manda el operador (texto con un premio por línea, o un arreglo).
function paraGuardar(valor) {
  const lista = (Array.isArray(valor) ? valor : String(valor ?? '').split(/\r?\n/))
    .map((p) => String(p ?? '').replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  if (lista.length > MAX_PREMIOS) throw new Error(`Escriba como máximo ${MAX_PREMIOS} premios sorpresa.`);
  const largo = lista.find((p) => p.length > MAX_LARGO);
  if (largo) throw new Error(`El premio sorpresa «${largo.slice(0, 20)}…» es muy largo (máximo ${MAX_LARGO} letras).`);
  return lista;
}

// Regla para el cliente (inscripción, reverso de la tarjeta).
const regla = () => 'Algunas estampas traen un premio sorpresa, al azar. Se entrega en el local; máximo uno por tarjeta.';

module.exports = { activas, premios, probabilidad, unaDeCada, paraGuardar, regla, MAX_PREMIOS };
