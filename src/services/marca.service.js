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
const TIPOS = { logo: 'logo_url', sello: 'sello_url' };
let bucketListo = false;

async function asegurarBucket() {
  if (bucketListo) return;
  const { error } = await supabase.storage.createBucket(BUCKET, { public: true, fileSizeLimit: '5MB' });
  if (error && !/already exists|duplicate/i.test(error.message)) throw errorDb(error, 'crear bucket de marcas');
  bucketListo = true;
}

// Guarda la imagen como PNG y devuelve su URL pública. Cada subida usa un nombre
// nuevo para que Apple y Google no sigan mostrando la versión anterior desde su caché.
async function guardarPng(negocioId, nombre, buffer) {
  const png = await estampas.normalizarImagen(buffer);
  await asegurarBucket();
  const ruta = `${negocioId}/${nombre}-${Date.now()}.png`;
  const { error } = await supabase.storage.from(BUCKET).upload(ruta, png, { contentType: 'image/png' });
  if (error) throw errorDb(error, 'subir imagen de marca');
  return { url: supabase.storage.from(BUCKET).getPublicUrl(ruta).data.publicUrl, bytes: png.length };
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

const fondoSellos = (negocio) => negocio.color_fondo_sellos || negocio.color_primario || '#1a1a2e';

const estampasPropias = (negocio) => (Array.isArray(negocio.estampas_urls) ? negocio.estampas_urls : []);

// Subirlo cuando cambia cómo se dibuja la tira (no solo los datos del negocio),
// para que Google descargue la imagen nueva en vez de usar la de su caché.
const VERSION_DIBUJO = 2; // 2: margen a los lados para que el iPhone no recorte estampas

// Cambia cuando cambia algo que se ve en la tira: sirve para invalidar cachés.
function versionTira(negocio) {
  return crypto.createHash('sha1')
    .update([VERSION_DIBUJO, negocio.sello_url, negocio.logo_url, fondoSellos(negocio), negocio.color_secundario, negocio.sellos_para_premio,
      JSON.stringify(estampasPropias(negocio)), negocio.estampas_pendientes].join('|'))
    .digest('hex').slice(0, 10);
}

function versionLogo(negocio) {
  return crypto.createHash('sha1').update([negocio.logo_url, negocio.color_primario].join('|')).digest('hex').slice(0, 10);
}

// Imagen de cada posición: la propia, o la general (estampa o logo), o null.
// Las URLs repetidas se descargan una sola vez y comparten el mismo Buffer.
async function imagenesDeEstampas(negocio) {
  const contexto = { negocio_id: negocio.id };
  const propias = estampasPropias(negocio);
  const urls = Array.from({ length: negocio.sellos_para_premio },
    (_, i) => propias[i] || negocio.sello_url || negocio.logo_url || null);
  const descargas = new Map([...new Set(urls)].map((url) => [url, cargarImagen(url, contexto)]));
  return Promise.all(urls.map((url) => descargas.get(url)));
}

// Zona de estampas del negocio. Con imágenes: cada estampa con la suya (color /
// gris o círculo vacío). Sin ninguna imagen: círculos con los colores del negocio.
async function tiraDelNegocio(negocio, llenos, { ancho = 750, alto = 246 } = {}) {
  const total = negocio.sellos_para_premio;
  const obtenidas = Math.min(Math.max(llenos, 0), total);
  const fondo = fondoSellos(negocio);
  const sello = negocio.color_secundario || '#ffffff';
  const imagenes = await imagenesDeEstampas(negocio);
  if (imagenes.some(Boolean)) {
    try {
      return await estampas.tiraConImagenes({
        imagenes, total, llenos: obtenidas, fondo, sello, ocultas: negocio.estampas_pendientes === 'ocultas', ancho, alto,
      });
    } catch (error) {
      log.warn('no se pudieron usar las imágenes del negocio en las estampas', { negocio_id: negocio.id, error });
    }
  }
  return imagen.tiraSellos({ total, llenos: obtenidas, fondo, sello, ancho, alto });
}

module.exports = {
  subirImagen, subirEstampa, quitarEstampa, cargarImagen, tiraDelNegocio, versionTira, versionLogo, TIPOS,
};
