// Imágenes de marca de cada negocio: logo e imagen de la estampa.
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

// Guarda la imagen y actualiza el negocio. Cada subida usa un nombre nuevo para
// que Apple y Google no sigan mostrando la versión anterior desde su caché.
async function subirImagen(negocioId, tipo, buffer) {
  const png = await estampas.normalizarImagen(buffer);
  await asegurarBucket();
  const ruta = `${negocioId}/${tipo}-${Date.now()}.png`;
  const { error } = await supabase.storage.from(BUCKET).upload(ruta, png, { contentType: 'image/png' });
  if (error) throw errorDb(error, 'subir imagen de marca');
  const url = supabase.storage.from(BUCKET).getPublicUrl(ruta).data.publicUrl;

  const { data, error: e } = await supabase
    .from('negocios').update({ [TIPOS[tipo]]: url }).eq('id', negocioId).select().maybeSingle();
  if (e) throw errorDb(e, 'guardar imagen de marca');
  log.info('imagen de marca subida', { negocio_id: negocioId, operacion: 'subir_imagen', tipo, bytes: png.length });
  return data;
}

// Descarga imágenes remotas (logos en Storage) con caché de 1 hora por URL.
const remotas = new Map();
async function cargarImagen(url, contexto = {}) {
  if (!url) return null;
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

// Cambia cuando cambia algo que se ve en la tira: sirve para invalidar cachés.
function versionTira(negocio) {
  return crypto.createHash('sha1')
    .update([negocio.sello_url, negocio.logo_url, fondoSellos(negocio), negocio.color_secundario, negocio.sellos_para_premio].join('|'))
    .digest('hex').slice(0, 10);
}

function versionLogo(negocio) {
  return crypto.createHash('sha1').update([negocio.logo_url, negocio.color_primario].join('|')).digest('hex').slice(0, 10);
}

// Zona de estampas del negocio. Con imagen: estampas con el logo (gris / color).
// Sin imagen: círculos con los colores del negocio.
async function tiraDelNegocio(negocio, llenos, { ancho = 750, alto = 246, imagenEstampa } = {}) {
  const total = negocio.sellos_para_premio;
  const obtenidas = Math.min(Math.max(llenos, 0), total);
  const fondo = fondoSellos(negocio);
  // imagenEstampa: archivo aún no guardado (vista previa del panel del operador).
  const logo = imagenEstampa || await cargarImagen(negocio.sello_url || negocio.logo_url, { negocio_id: negocio.id });
  if (logo) {
    try {
      return await estampas.tiraConLogo({ logo, total, llenos: obtenidas, fondo, ancho, alto });
    } catch (error) {
      log.warn('no se pudo usar la imagen del negocio en las estampas', { negocio_id: negocio.id, error });
    }
  }
  return imagen.tiraSellos({ total, llenos: obtenidas, fondo, sello: negocio.color_secundario || '#ffffff', ancho, alto });
}

module.exports = { subirImagen, cargarImagen, tiraDelNegocio, versionTira, versionLogo, TIPOS };
