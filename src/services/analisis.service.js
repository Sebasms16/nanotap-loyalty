// Análisis de datos: panel del dueño del negocio y panel del operador.
// Los cálculos pesados están en las funciones SQL analisis_negocio y
// analisis_operador (schema.sql); aquí se arman los rangos de fechas en hora de
// Costa Rica y se completa lo que depende de la configuración (niveles).
const supabase = require('../db/supabaseClient');
const niveles = require('./niveles.service');
const { errorDb } = require('../utils/errores');

// Períodos que ofrece el panel. Los de días terminan hoy (incluido); el de 12
// meses toma meses completos, para que cada barra sea un mes entero.
const PERIODOS = {
  '7d': { nombre: 'Últimos 7 días', dias: 7, unidad: 'day' },
  '30d': { nombre: 'Últimos 30 días', dias: 30, unidad: 'day' },
  '90d': { nombre: 'Últimos 90 días', dias: 90, unidad: 'week' },
  '12m': { nombre: 'Últimos 12 meses', meses: 12, unidad: 'month' },
};
const PERIODO_POR_DEFECTO = '30d';

function rango(clave, ahora = new Date()) {
  const periodo = PERIODOS[clave] || PERIODOS[PERIODO_POR_DEFECTO];
  const hoy = niveles.hoyCR(ahora);
  let desde;
  let hasta;
  if (periodo.meses) {
    const mes = { ...hoy, d: 1 };
    desde = niveles.instanteCR(niveles.sumarMeses(mes, 1 - periodo.meses));
    hasta = niveles.instanteCR(niveles.sumarMeses(mes, 1));
  } else {
    const manana = niveles.instanteCR({ ...hoy, d: hoy.d + 1 }); // Date.UTC normaliza el desborde
    hasta = manana;
    desde = new Date(manana.getTime() - periodo.dias * 24 * 60 * 60 * 1000);
  }
  return { clave: PERIODOS[clave] ? clave : PERIODO_POR_DEFECTO, nombre: periodo.nombre, unidad: periodo.unidad, desde, hasta };
}

async function rpc(funcion, parametros) {
  const { data, error } = await supabase.rpc(funcion, parametros);
  if (error) throw errorDb(error, funcion);
  return data;
}

// Clientes por nivel en la temporada actual, a partir de cuántas tarjetas canjeó cada uno.
function clientesPorNivel(negocio, histograma, temporada) {
  const conteo = new Map(niveles.NIVELES.map((n) => [n.clave, 0]));
  for (const { canjes, clientes } of histograma || []) {
    const { nivel } = niveles.describir(negocio, canjes, temporada);
    conteo.set(nivel.clave, conteo.get(nivel.clave) + clientes);
  }
  return {
    fin: niveles.fechaFin(temporada),
    niveles: niveles.configuracion(negocio).map((n) => ({
      clave: n.clave, nombre: n.nombre, emoji: n.emoji, tarjetas: n.tarjetas, clientes: conteo.get(n.clave),
    })),
  };
}

async function delNegocio(negocio, clavePeriodo, ahora = new Date()) {
  const periodo = rango(clavePeriodo, ahora);
  const temporada = niveles.activos(negocio) ? niveles.temporadaActual(negocio, ahora) : null;
  const datos = await rpc('analisis_negocio', {
    p_negocio_id: negocio.id,
    p_desde: periodo.desde.toISOString(),
    p_hasta: periodo.hasta.toISOString(),
    p_unidad: periodo.unidad,
    p_temporada_desde: temporada?.desde.toISOString() ?? null,
    p_temporada_hasta: temporada?.hasta.toISOString() ?? null,
  });
  return {
    periodo: { clave: periodo.clave, nombre: periodo.nombre, unidad: periodo.unidad },
    negocio: { nombre: negocio.nombre, sellos_para_premio: negocio.sellos_para_premio },
    ...datos,
    niveles: temporada ? clientesPorNivel(negocio, datos.niveles, temporada) : null,
  };
}

async function delOperador(clavePeriodo, ahora = new Date()) {
  const periodo = rango(clavePeriodo, ahora);
  const datos = await rpc('analisis_operador', {
    p_desde: periodo.desde.toISOString(),
    p_hasta: periodo.hasta.toISOString(),
    p_unidad: periodo.unidad,
  });
  return { periodo: { clave: periodo.clave, nombre: periodo.nombre, unidad: periodo.unidad }, ...datos };
}

module.exports = { PERIODOS, rango, delNegocio, delOperador, clientesPorNivel };
