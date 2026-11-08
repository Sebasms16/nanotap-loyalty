// Niveles por temporada: Bronce → Plata → Oro → Diamante.
//
// - El nivel sale de cuántas tarjetas canjeó el cliente EN LA TEMPORADA ACTUAL
//   (eventos 'canje' de sellos_eventos). No se guarda: se calcula, así que al
//   empezar una temporada todos vuelven a Bronce sin tocar la base de datos.
//   Las estampas en curso no cambian.
// - Cada nivel tiene su premio: al canjear, el cliente recibe el de su nivel en ese
//   momento; si con ese canje alcanza el siguiente, sube.
// - Temporadas: duran `temporada_meses` y se encadenan desde `temporada_inicio`.
//   Las fechas se cuentan en hora de Costa Rica (UTC-6, sin horario de verano).
const supabase = require('../db/supabaseClient');
const { errorDb } = require('../utils/errores');

// Cada nivel tiene su insignia (insignias.service): en las páginas y dibujada en la franja.
// En los textos (campos de la tarjeta, reglas) va solo el nombre.
const NIVELES = [
  { clave: 'bronce', nombre: 'Bronce' },
  { clave: 'plata', nombre: 'Plata' },
  { clave: 'oro', nombre: 'Oro' },
  { clave: 'diamante', nombre: 'Diamante' },
];
// Tarjetas canjeadas en la temporada para llegar a cada nivel (si el negocio no elige).
const TARJETAS_POR_DEFECTO = { bronce: 0, plata: 2, oro: 4, diamante: 6 };
// Con programa de puntos: puntos ganados en la temporada.
const PUNTOS_POR_DEFECTO = { bronce: 0, plata: 500, oro: 1500, diamante: 3000 };
// Con cashback: colones comprados en la temporada.
const COMPRAS_POR_DEFECTO = { bronce: 0, plata: 50000, oro: 150000, diamante: 300000 };
// Unidad de la meta de cada nivel según el programa del negocio.
const unidadDe = (negocio) => ({ puntos: 'puntos', cashback: 'compras' })[negocio?.tipo_programa] || 'tarjetas';
const POR_DEFECTO = { tarjetas: TARJETAS_POR_DEFECTO, puntos: PUNTOS_POR_DEFECTO, compras: COMPRAS_POR_DEFECTO };
const MESES_POR_DEFECTO = 3;
const DESFASE_CR_MS = 6 * 60 * 60 * 1000;
const ZONA = 'America/Costa_Rica';

const activos = (negocio) => Boolean(negocio?.niveles_activos);

// Los cuatro niveles con lo que eligió el negocio. Un premio vacío usa el premio general.
// `tarjetas` es la meta para llegar al nivel, en la unidad del programa: tarjetas
// canjeadas (estampas), puntos ganados (puntos) o colones comprados (cashback), según
// `unidad`. Con puntos o cashback el premio del nivel es un beneficio que solo se muestra.
function configuracion(negocio) {
  const propios = Array.isArray(negocio.niveles) ? negocio.niveles : [];
  const clave = unidadDe(negocio);
  const conEstampas = clave === 'tarjetas';
  const porDefecto = POR_DEFECTO[clave];
  return NIVELES.map((nivel) => {
    const propio = propios.find((p) => p?.clave === nivel.clave) || {};
    const meta = nivel.clave === 'bronce' ? 0
      : Number.isInteger(propio[clave]) ? propio[clave] : porDefecto[nivel.clave];
    const premio = String(propio.premio || '').trim() || (conEstampas ? negocio.descripcion_premio : '');
    return { ...nivel, tarjetas: meta, unidad: clave, premio };
  });
}

// --- Fechas en hora de Costa Rica -------------------------------------------
const instanteCR = ({ y, m, d }) => new Date(Date.UTC(y, m, d) + DESFASE_CR_MS); // medianoche en CR

function hoyCR(ahora = new Date()) {
  const f = new Date(ahora.getTime() - DESFASE_CR_MS);
  return { y: f.getUTCFullYear(), m: f.getUTCMonth(), d: f.getUTCDate() };
}

// Suma meses sin desbordar: el 31 de enero + 1 mes es el 28 (o 29) de febrero.
function sumarMeses({ y, m, d }, meses) {
  const total = y * 12 + m + meses;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const ultimoDia = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return { y: ny, m: nm, d: Math.min(d, ultimoDia) };
}

function leerFecha(texto) {
  const partes = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(texto || ''));
  return partes ? { y: Number(partes[1]), m: Number(partes[2]) - 1, d: Number(partes[3]) } : null;
}

const aTexto = ({ y, m, d }) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Temporada vigente: { desde, hasta } (instantes; `hasta` es el inicio de la
// siguiente) y `clave` (fecha de inicio, para saber cuándo cambió).
function temporadaActual(negocio, ahora = new Date()) {
  const meses = negocio.temporada_meses || MESES_POR_DEFECTO;
  const inicio = leerFecha(negocio.temporada_inicio) || hoyCR(ahora);
  let k = 0;
  while (instanteCR(sumarMeses(inicio, (k + 1) * meses)) <= ahora) k += 1;
  const desde = sumarMeses(inicio, k * meses);
  return {
    desde: instanteCR(desde),
    hasta: instanteCR(sumarMeses(inicio, (k + 1) * meses)),
    clave: aTexto(desde),
  };
}

// "31 dic 2026": último día de la temporada.
function fechaFin(temporada) {
  return new Intl.DateTimeFormat('es-CR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: ZONA })
    .format(new Date(temporada.hasta.getTime() - 1)).replace('.', '');
}

// --- Nivel del cliente ------------------------------------------------------
// Estado a partir del avance en la temporada: tarjetas canjeadas o, con puntos, puntos ganados.
function describir(negocio, tarjetas, temporada) {
  const niveles = configuracion(negocio);
  let i = 0;
  while (i + 1 < niveles.length && tarjetas >= niveles[i + 1].tarjetas) i += 1;
  const siguiente = niveles[i + 1] || null;
  return {
    nivel: niveles[i],
    siguiente,
    tarjetas,
    unidad: niveles[i].unidad,
    faltan: siguiente ? siguiente.tarjetas - tarjetas : 0,
    premio: niveles[i].premio,
    temporada,
    fin: fechaFin(temporada),
  };
}

// null si el negocio no usa niveles.
async function estadoDelCliente(cliente, negocio, ahora = new Date()) {
  if (!activos(negocio)) return null;
  const temporada = temporadaActual(negocio, ahora);
  const unidad = unidadDe(negocio);
  if (unidad !== 'tarjetas') {
    const { data, error } = await supabase.rpc(unidad === 'puntos' ? 'puntos_ganados' : 'compras_en_rango', {
      p_cliente_id: cliente.id, p_desde: temporada.desde.toISOString(), p_hasta: temporada.hasta.toISOString(),
    });
    if (error) throw errorDb(error, unidad === 'puntos' ? 'sumar puntos de la temporada' : 'sumar compras de la temporada');
    return describir(negocio, Number(data) || 0, temporada);
  }
  const { count, error } = await supabase
    .from('sellos_eventos')
    .select('id', { count: 'exact', head: true })
    .eq('cliente_id', cliente.id)
    .eq('tipo', 'canje')
    .gte('creado_en', temporada.desde.toISOString())
    .lt('creado_en', temporada.hasta.toISOString());
  if (error) throw errorDb(error, 'contar canjes de la temporada');
  return describir(negocio, count || 0, temporada);
}

const etiqueta = (nivel) => nivel.nombre.toUpperCase();

// Premio que recibe el cliente al canjear: el de su nivel, o el general sin niveles.
const premioActual = (negocio, estado) => (estado ? estado.premio : negocio.descripcion_premio);

// Texto corto para mostrar: "Nivel Oro · 5 tarjetas esta temporada · faltan 1 para Diamante".
// Con puntos: "Nivel Plata · 820 puntos ganados esta temporada · faltan 680 para Oro".
// Con cashback: "Nivel Plata · ₡82 000 en compras esta temporada · faltan ₡68 000 para Oro".
const numeroCR = (n) => new Intl.NumberFormat('es-CR').format(n);
function resumen(estado) {
  const n = estado.tarjetas;
  const avance = {
    puntos: () => `${numeroCR(n)} punto${n === 1 ? '' : 's'} ganado${n === 1 ? '' : 's'} esta temporada`,
    compras: () => `₡${numeroCR(n)} en compras esta temporada`,
  }[estado.unidad]?.() || `${n} tarjeta${n === 1 ? '' : 's'} llena${n === 1 ? '' : 's'} esta temporada`;
  const partes = [`Nivel ${estado.nivel.nombre}`, avance];
  if (estado.siguiente) {
    const faltan = estado.unidad === 'compras' ? `faltan ₡${numeroCR(estado.faltan)}`
      : estado.faltan === 1 ? 'falta 1' : `faltan ${numeroCR(estado.faltan)}`;
    partes.push(`${faltan} para ${estado.siguiente.nombre}`);
  }
  return `${partes.join(' · ')}. La temporada termina el ${estado.fin}.`;
}

// Datos para el navegador (staff, consulta): sin instantes ni funciones.
function paraMostrar(estado) {
  if (!estado) return null;
  return {
    nivel: { clave: estado.nivel.clave, nombre: estado.nivel.nombre },
    siguiente: estado.siguiente && { clave: estado.siguiente.clave, nombre: estado.siguiente.nombre },
    tarjetas: estado.tarjetas,
    unidad: estado.unidad,
    faltan: estado.faltan,
    premio: estado.premio,
    fin: estado.fin,
    resumen: resumen(estado),
  };
}

module.exports = {
  instanteCR, hoyCR, sumarMeses, leerFecha, aTexto,
  NIVELES, TARJETAS_POR_DEFECTO, PUNTOS_POR_DEFECTO, COMPRAS_POR_DEFECTO, MESES_POR_DEFECTO, unidadDe,
  activos, configuracion, temporadaActual, fechaFin, describir, estadoDelCliente, etiqueta, premioActual, resumen, paraMostrar,
};
