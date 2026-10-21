// Imágenes de marca de cada negocio: logo, imagen de la estampa y, opcionalmente,
// una imagen propia para cada posición de la tarjeta (estampas_urls).
//  - Se suben desde el panel del operador y se guardan como PNG en Supabase
//    Storage (bucket público "marcas"), porque Google necesita descargarlas.
//  - tiraDelNegocio() arma la zona de estampas con esas imágenes.
const crypto = require('node:crypto');
const supabase = require('../db/supabaseClient');
const estampas = require('./estampas.service');
const imagen = require('./imagen.service');
const log = require('../utils/logger');
const { errorDb } = require('../utils/errores');

const BUCKET = 'marcas';
// final: la imagen de la última estampa (la del premio), distinta de las demás.
const TIPOS = { logo: 'logo_url', sello: 'sello_url', final: 'estampa_final_url', fondo: 'fondo_estampas_url' };
let bucketListo = false;

async function asegurarBucket() {
  if (bucketListo) return;
  const { error } = await supabase.storage.createBucket(BUCKET, { public: true, fileSizeLimit: '5MB' });
  if (error && !/already exists|duplicate/i.test(error.message)) throw errorDb(error, 'crear bucket de marcas');
  bucketListo = true;
}

// Guarda la imagen (PNG; la foto de fondo, JPG) y devuelve su URL pública. Cada subida
// usa un nombre nuevo para que Apple y Google no sigan mostrando la versión anterior desde su caché.
async function guardarPng(negocioId, nombre, buffer) {
  const foto = nombre === 'fondo';
  const archivo = await (foto ? estampas.normalizarFoto(buffer) : estampas.normalizarImagen(buffer));
  await asegurarBucket();
  const ruta = `${negocioId}/${nombre}-${Date.now()}.${foto ? 'jpg' : 'png'}`;
  const { error } = await supabase.storage.from(BUCKET)
    .upload(ruta, archivo, { contentType: foto ? 'image/jpeg' : 'image/png' });
  if (error) throw errorDb(error, 'subir imagen de marca');
  return { url: supabase.storage.from(BUCKET).getPublicUrl(ruta).data.publicUrl, bytes: archivo.length };
}

async function actualizarNegocio(negocioId, datos) {
  const { data, error } = await supabase.from('negocios').update(datos).eq('id', negocioId).select().maybeSingle();
  if (error) throw errorDb(error, 'guardar imagen de marca');
  return data;
}

async function subirImagen(negocioId, tipo, buffer) {
  const { url, bytes } = await guardarPng(negocioId, tipo, buffer);
  const data = await actualizarNegocio(negocioId, { [TIPOS[tipo]]: url });
  log.info('imagen de marca subida', { negocio_id: negocioId, operacion: 'subir_imagen', tipo, bytes });
  return data;
}

// Imagen propia de una posición (1 = primera estampa). url null = quitarla y
// volver a la imagen general. Las posiciones mayores que la cantidad actual de
// estampas se conservan, por si el negocio vuelve a subirla.
async function ponerEstampa(negocioId, posicion, url) {
  const { data: actual, error } = await supabase.from('negocios').select('estampas_urls').eq('id', negocioId).maybeSingle();
  if (error) throw errorDb(error, 'leer estampas del negocio');
  if (!actual) return null;
  const lista = Array.isArray(actual.estampas_urls) ? [...actual.estampas_urls] : [];
  while (lista.length < posicion) lista.push(null);
  lista[posicion - 1] = url;
  while (lista.length && !lista[lista.length - 1]) lista.pop();
  return actualizarNegocio(negocioId, { estampas_urls: lista });
}

async function subirEstampa(negocioId, posicion, buffer) {
  const { url, bytes } = await guardarPng(negocioId, `estampa-${posicion}`, buffer);
  const data = await ponerEstampa(negocioId, posicion, url);
  log.info('imagen de estampa subida', { negocio_id: negocioId, operacion: 'subir_imagen', tipo: 'estampa', posicion, bytes });
  return data;
}

const quitarEstampa = (negocioId, posicion) => ponerEstampa(negocioId, posicion, null);

// Descarga imágenes remotas (logos en Storage) con caché de 1 hora por URL.
// Si recibe un Buffer lo devuelve tal cual: la vista previa del panel pone así
// los archivos que el operador eligió pero todavía no guardó.
const remotas = new Map();
async function cargarImagen(url, contexto = {}) {
  if (!url) return null;
  if (Buffer.isBuffer(url)) return url;
  const guardada = remotas.get(url);
  if (guardada && Date.now() - guardada.en < 60 * 60 * 1000) return guardada.buffer;
  let buffer = null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (r.ok) buffer = Buffer.from(await r.arrayBuffer());
    else log.warn('no se pudo descargar la imagen del negocio', { ...contexto, url, status: r.status });
  } catch (error) {
    log.warn('no se pudo descargar la imagen del negocio', { ...contexto, url, error });
  }
  if (remotas.size >= 200) remotas.delete(remotas.keys().next().value);
  remotas.set(url, { buffer, en: Date.now() });
  return buffer;
}

// Si el logo del negocio es alargado (ver estampas.PROPORCION_ANCHO). Se recuerda
// por URL: cada logo subido tiene una URL nueva, así que no cambia sin cambiarla.
const logosAnchos = new Map();
async function logoEsAncho(negocio) {
  if (!negocio.logo_url) return false;
  if (logosAnchos.has(negocio.logo_url)) return logosAnchos.get(negocio.logo_url);
  const logo = await cargarImagen(negocio.logo_url, { negocio_id: negocio.id });
  if (!logo) return false; // no se pudo descargar: se vuelve a intentar la próxima vez
  const ancho = (await estampas.proporcionLogo(logo).catch(() => 1)) >= estampas.PROPORCION_ANCHO;
  if (logosAnchos.size >= 200) logosAnchos.delete(logosAnchos.keys().next().value);
  logosAnchos.set(negocio.logo_url, ancho);
  return ancho;
}

const fondoSellos = (negocio) => negocio.color_fondo_sellos || negocio.color_primario || '#1a1a2e';

const estampasPropias = (negocio) => (Array.isArray(negocio.estampas_urls) ? negocio.estampas_urls : []);

// Subirlo cuando cambia cómo se dibujan la tira o el logo (no solo los datos del negocio),
// para que Google descargue la imagen nueva en vez de usar la de su caché.
// 2: margen a los lados para que el iPhone no recorte estampas.
// 3: los logos con fondo sólido ya no se recortan (esquinas redondeadas).
const VERSION_DIBUJO = 3;

// Cambia cuando cambia algo que se ve en la tira: sirve para invalidar cachés.
function versionTira(negocio) {
  return crypto.createHash('sha1')
    .update([VERSION_DIBUJO, negocio.sello_url, negocio.logo_url, fondoSellos(negocio), negocio.color_secundario, negocio.sellos_para_premio,
      JSON.stringify(estampasPropias(negocio)), negocio.estampas_pendientes,
      // Solo si hay foto o última estampa propia: así no cambia la versión (ni se re-descarga nada) en los demás.
      ...(negocio.fondo_estampas_url ? [negocio.fondo_estampas_url, negocio.fondo_estampas_efecto] : []),
      ...(negocio.estampa_final_url ? [`final:${negocio.estampa_final_url}`] : [])].join('|'))
    .digest('hex').slice(0, 10);
}

function versionLogo(negocio) {
  return crypto.createHash('sha1').update([VERSION_DIBUJO, negocio.logo_url, negocio.color_primario].join('|'))
    .digest('hex').slice(0, 10);
}

// Imagen de cada posición: la propia, o (en la última) la de la última estampa,
// o la general (estampa o logo), o null.
// Las URLs repetidas se descargan una sola vez y comparten el mismo Buffer.
async function imagenesDeEstampas(negocio) {
  const contexto = { negocio_id: negocio.id };
  const propias = estampasPropias(negocio);
  const total = negocio.sellos_para_premio;
  const urls = Array.from({ length: total }, (_, i) => propias[i]
    || (i === total - 1 && negocio.estampa_final_url) || negocio.sello_url || negocio.logo_url || null);
  const descargas = new Map([...new Set(urls)].map((url) => [url, cargarImagen(url, contexto)]));
  return Promise.all(urls.map((url) => descargas.get(url)));
}

// Foto de fondo ya recortada y con su efecto, para un tamaño de franja. Se guarda
// unos minutos: la misma tarjeta se pide en tres tamaños y para cada cliente.
const fondosListos = new Map();
async function fondoDelNegocio(negocio, { ancho, alto }) {
  if (!negocio.fondo_estampas_url) return null;
  // La vista previa del panel manda el archivo sin guardar (un Buffer): ese no se guarda.
  const clave = typeof negocio.fondo_estampas_url === 'string'
    && [negocio.fondo_estampas_url, negocio.fondo_estampas_efecto, fondoSellos(negocio), ancho, alto].join('|');
  const guardado = clave && fondosListos.get(clave);
  if (guardado && Date.now() - guardado.en < 10 * 60 * 1000) return guardado.base;
  const foto = await cargarImagen(negocio.fondo_estampas_url, { negocio_id: negocio.id });
  if (!foto) return null; // no se pudo descargar: por esta vez, el color de fondo
  let base = null;
  try {
    base = await estampas.fondoConFoto(foto, { ancho, alto, efecto: negocio.fondo_estampas_efecto, color: fondoSellos(negocio) });
  } catch (error) {
    log.warn('no se pudo usar la foto de fondo de las estampas', { negocio_id: negocio.id, error });
  }
  if (!clave) return base;
  if (fondosListos.size >= 60) fondosListos.delete(fondosListos.keys().next().value);
  fondosListos.set(clave, { base, en: Date.now() });
  return base;
}

// Zona de estampas del negocio. Con imágenes: cada estampa con la suya (color /
// gris o círculo vacío). Sin ninguna imagen: círculos con los colores del negocio.
// Con foto de fondo, las estampas van sobre la foto en vez del color.
async function tiraDelNegocio(negocio, llenos, { ancho = 750, alto = 246 } = {}) {
  const total = negocio.sellos_para_premio;
  const obtenidas = Math.min(Math.max(llenos, 0), total);
  const fondo = fondoSellos(negocio);
  const sello = negocio.color_secundario || '#ffffff';
  const [imagenes, base] = await Promise.all([imagenesDeEstampas(negocio), fondoDelNegocio(negocio, { ancho, alto })]);
  if (imagenes.some(Boolean) || base) {
    try {
      return await estampas.tiraConImagenes({
        imagenes, total, llenos: obtenidas, fondo, sello, ocultas: negocio.estampas_pendientes === 'ocultas', ancho, alto, base,
        tarjeta: negocio.color_primario,
      });
    } catch (error) {
      log.warn('no se pudieron usar las imágenes del negocio en las estampas', { negocio_id: negocio.id, error });
    }
  }
  return imagen.tiraSellos({ total, llenos: obtenidas, fondo, sello, ancho, alto });
}

module.exports = {
  subirImagen, subirEstampa, quitarEstampa, cargarImagen, logoEsAncho, tiraDelNegocio, versionTira, versionLogo, TIPOS,
};
