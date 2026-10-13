// Tira de estampas con la imagen del negocio: cada estampa obtenida muestra la
// imagen a color y cada estampa pendiente la muestra en gris y tenue.
// La imagen se respeta tal cual (sin aro ni recorte en círculo): su forma es la estampa.
// Se usa como strip de Apple Wallet y como hero image de Google Wallet.
const sharp = require('sharp');
const { hexARgb } = require('./imagen.service');

const OPACIDAD_PENDIENTE = 0.3;
const TRANSPARENTE = { r: 0, g: 0, b: 0, alpha: 0 };

function filasPara(total) {
  if (total <= 6) return 1;
  if (total <= 16) return 2;
  return 3;
}

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

/**
 * @param {Buffer} logo   imagen de la estampa (PNG, JPG, WebP o SVG)
 * @param {number} total  estampas para el premio
 * @param {number} llenos estampas obtenidas
 * @param {string} fondo  color de fondo de la zona de estampas (#rrggbb)
 */
async function tiraConLogo({ logo, total, llenos, fondo, ancho = 750, alto = 246 }) {
  const filas = filasPara(total);
  const columnas = Math.ceil(total / filas);
  const celda = Math.min((ancho * 0.94) / columnas, (alto * 0.9) / filas);
  const lado = Math.round(celda * 0.84);
  const origenY = (alto - celda * filas) / 2;

  const color = await estampaColor(logo, lado);
  const gris = await estampaGris(color);

  const capas = [];
  for (let i = 0; i < total; i++) {
    const fila = Math.floor(i / columnas);
    const enFila = fila === filas - 1 ? total - columnas * (filas - 1) : columnas;
    const origenX = (ancho - celda * enFila) / 2;
    const cx = origenX + celda * ((i % columnas) + 0.5);
    const cy = origenY + celda * (fila + 0.5);
    capas.push({ input: i < llenos ? color : gris, left: Math.round(cx - lado / 2), top: Math.round(cy - lado / 2) });
  }

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

module.exports = { tiraConLogo, normalizarImagen, logoEncabezado, logoParaGoogle, iconoDesdeLogo };
