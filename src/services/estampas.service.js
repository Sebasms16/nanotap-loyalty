// Tira de estampas con las imágenes del negocio: cada posición puede tener su
// propia imagen. La estampa obtenida la muestra a color; la pendiente, en gris y
// tenue, o como un círculo vacío si el negocio prefiere no revelarla.
// La imagen se respeta tal cual (sin aro ni recorte en círculo): su forma es la estampa.
// Se usa como strip de Apple Wallet y como hero image de Google Wallet.
const sharp = require('sharp');
const { hexARgb, distribuirEstampas } = require('./imagen.service');

const OPACIDAD_PENDIENTE = 0.3;
const TRANSPARENTE = { r: 0, g: 0, b: 0, alpha: 0 };

// Quita el margen transparente que traen muchos logos, para que el dibujo
// ocupe todo el espacio (si la imagen es uniforme, trim falla y se usa tal cual).
function sinMargen(imagen) {
  return sharp(imagen).trim().png().toBuffer().catch(() => imagen);
}

// La imagen encajada (sin deformar) en un cuadrado transparente de `lado` px.
async function estampaColor(imagen, lado) {
  return sharp(await sinMargen(imagen))
    .resize(lado, lado, { fit: 'contain', background: TRANSPARENTE })
    .png()
    .toBuffer();
}

async function estampaGris(color) {
  const { data, info } = await sharp(color).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const luz = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = luz;
    data[i + 3] = Math.round(data[i + 3] * OPACIDAD_PENDIENTE);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

// Círculos del mismo estilo que la tira sin imágenes (imagen.service): lleno con
// un punto al centro para una estampa obtenida, solo el contorno para una pendiente.
function circulo(lado, { color, fondo, lleno }) {
  const c = lado / 2;
  const radio = lado * 0.45;
  const svg = lleno
    ? `<circle cx="${c}" cy="${c}" r="${radio}" fill="${color}"/>`
      + `<circle cx="${c}" cy="${c}" r="${radio * 0.42}" fill="${fondo}" fill-opacity="0.9"/>`
    : `<circle cx="${c}" cy="${c}" r="${radio * 0.94}" fill="none" stroke="${color}" stroke-opacity="0.45"`
      + ` stroke-width="${Math.max(2, radio * 0.12)}"/>`;
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${lado}" height="${lado}">${svg}</svg>`))
    .png().toBuffer();
}

/**
 * @param {(Buffer|null)[]} imagenes una por estampa (PNG, JPG, WebP o SVG); null = círculo
 * @param {number} total    estampas para el premio
 * @param {number} llenos   estampas obtenidas
 * @param {string} fondo    color de fondo de la zona de estampas (#rrggbb)
 * @param {string} sello    color de los círculos de las posiciones sin imagen (#rrggbb)
 * @param {boolean} ocultas las pendientes se ven como círculo vacío en vez de la imagen en gris
 */
async function tiraConImagenes({ imagenes, total, llenos, fondo, sello = '#ffffff', ocultas = false, ancho = 750, alto = 246 }) {
  const { celda, centros } = distribuirEstampas(total, ancho, alto);
  const lado = Math.round(celda * 0.84);

  // Cada imagen distinta se prepara una sola vez: lo común es que varias posiciones la compartan.
  const memo = (crear) => {
    const hechas = new Map();
    return (clave) => {
      if (!hechas.has(clave)) hechas.set(clave, crear(clave));
      return hechas.get(clave);
    };
  };
  const color = memo((imagen) => estampaColor(imagen, lado));
  const gris = memo(async (imagen) => estampaGris(await color(imagen)));
  const circulos = memo((esLleno) => circulo(lado, { color: sello, fondo, lleno: esLleno }));

  const capas = await Promise.all(Array.from({ length: total }, async (_, i) => {
    const imagen = imagenes[i] || null;
    const input = i < llenos
      ? await (imagen ? color(imagen) : circulos(true))
      : await (imagen && !ocultas ? gris(imagen) : circulos(false));
    const { x, y } = centros[i];
    return { input, left: Math.round(x - lado / 2), top: Math.round(y - lado / 2) };
  }));

  const [r, g, b] = hexARgb(fondo);
  return sharp({ create: { width: ancho, height: alto, channels: 3, background: { r, g, b } } })
    .composite(capas)
    .png()
    .toBuffer();
}

// Normaliza una imagen subida por el operador: valida, limita a 660 px y la pasa a PNG.
async function normalizarImagen(buffer) {
  const meta = await sharp(buffer).metadata(); // lanza si no es una imagen
  if (!meta.width || !meta.height) throw new Error('imagen sin dimensiones');
  return sharp(buffer).rotate().resize(660, 660, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
}

// Logo para el encabezado de Apple Wallet: máximo 160x50 pt.
async function logoEncabezado(logo, escala) {
  return sharp(await sinMargen(logo))
    .resize(160 * escala, 50 * escala, { fit: 'inside' })
    .png()
    .toBuffer();
}

// Logo para Google Wallet: Google lo muestra recortado en círculo, así que se
// centra con margen sobre el color de la tarjeta para que nunca se corte.
async function logoParaGoogle(logo, fondo, tam = 660) {
  const [r, g, b] = hexARgb(fondo);
  const interior = Math.round(tam * 0.64);
  const dibujo = await sharp(await sinMargen(logo))
    .resize(interior, interior, { fit: 'contain', background: TRANSPARENTE })
    .png()
    .toBuffer();
  return sharp({ create: { width: tam, height: tam, channels: 3, background: { r, g, b } } })
    .composite([{ input: dibujo, gravity: 'center' }])
    .png()
    .toBuffer();
}

// Ícono cuadrado (notificaciones de Apple) con el logo centrado sobre el color de la tarjeta.
async function iconoDesdeLogo(logo, tam, fondo) {
  return sharp(await logoParaGoogle(logo, fondo)).resize(tam, tam).png().toBuffer();
}

module.exports = { tiraConImagenes, normalizarImagen, logoEncabezado, logoParaGoogle, iconoDesdeLogo };
