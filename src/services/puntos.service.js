// Programa de puntos: la alternativa a las estampas, por negocio (tipo_programa).
//
// - El staff digita el monto de la compra; la función SQL sumar_puntos calcula
//   los puntos (1 por cada colones_por_punto, hacia abajo) y revisa las reglas
//   del negocio: factura obligatoria y sin repetir, tope por compra y espera
//   entre compras. El navegador nunca dice cuántos puntos sumar.
// - Los puntos se cambian por premios del catálogo (premios_puntos) con
//   canjear_puntos. Los niveles por temporada, si están activos, suben por los
//   puntos ganados en la temporada.

const esPuntos = (negocio) => negocio?.tipo_programa === 'puntos';

const numero = new Intl.NumberFormat('es-CR');
const formatoPuntos = (n) => numero.format(n);
const formatoColones = (n) => `₡${numero.format(n)}`;

// Catálogo válido, del premio más barato al más caro.
function catalogo(negocio) {
  const lista = Array.isArray(negocio?.premios_puntos) ? negocio.premios_puntos : [];
  return lista
    .filter((p) => p && p.id && p.nombre && Number.isInteger(p.puntos) && p.puntos > 0)
    .sort((a, b) => a.puntos - b.puntos);
}

// El premio al que va el cliente: el más barato que todavía no le alcanza. Si
// ya le alcanzan todos, el más caro (faltan 0). null si no hay catálogo.
function proximo(negocio, saldo) {
  const lista = catalogo(negocio);
  if (!lista.length) return null;
  const siguiente = lista.find((p) => p.puntos > saldo);
  const premio = siguiente || lista[lista.length - 1];
  return { premio, faltan: siguiente ? siguiente.puntos - saldo : 0 };
}

const premioConPuntos = (p) => `${p.nombre} (${formatoPuntos(p.puntos)} puntos)`;

// "1 punto por cada ₡1 000"
const regla = (negocio) => `1 punto por cada ${formatoColones(negocio.colones_por_punto || 1000)}`;

function reglasDePuntos(negocio) {
  const lista = catalogo(negocio);
  return [
    `Recibe ${regla(negocio)} de compra en ${negocio.nombre}, mostrando esta tarjeta al momento de pagar.`,
    lista.length
      ? `Cambie sus puntos por: ${lista.map(premioConPuntos).join(', ')}.`
      : 'Cambie sus puntos por los premios del negocio.',
    ...(negocio.puntos_factura_obligatoria ? ['Para sumar puntos se pide el número de factura de la compra.'] : []),
  ];
}

// Puntos que daría un monto (lo mismo que calcula sumar_puntos).
const calcular = (negocio, monto) => Math.floor(monto / (negocio.colones_por_punto || 1000));

// Datos del catálogo para el navegador (staff, consulta, inscripción).
function paraMostrar(negocio, saldo = 0) {
  if (!esPuntos(negocio)) return null;
  const sig = proximo(negocio, saldo);
  return {
    puntos: saldo,
    regla: regla(negocio),
    colones_por_punto: negocio.colones_por_punto,
    premios: catalogo(negocio).map((p) => ({ id: p.id, nombre: p.nombre, puntos: p.puntos, alcanza: saldo >= p.puntos })),
    proximo: sig && { nombre: sig.premio.nombre, puntos: sig.premio.puntos, faltan: sig.faltan },
  };
}

module.exports = {
  esPuntos, catalogo, proximo, calcular, regla, reglasDePuntos, paraMostrar, formatoPuntos, formatoColones, premioConPuntos,
};
