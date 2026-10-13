// Genera las imágenes de las tarjetas (PNG) sin dependencias externas:
//  - la tira de sellos (strip de Apple / hero image de Google), con círculos
//    llenos por cada sello y vacíos por cada sello faltante
//  - un ícono genérico con los colores del negocio, para cuando no hay logo
// Se dibuja con anti-aliasing analítico (cobertura por distancia al borde).
const zlib = require('node:zlib');

const TABLA_CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = TABLA_CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(tipo, datos) {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([largo, cuerpo, crc]);
}

// Codifica un lienzo RGB (3 bytes por pixel) como PNG.
function codificarPng(ancho, alto, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // RGB
  const filas = Buffer.alloc((ancho * 3 + 1) * alto);
  for (let y = 0; y < alto; y++) {
    rgb.copy(filas, y * (ancho * 3 + 1) + 1, y * ancho * 3, (y + 1) * ancho * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(filas)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hexARgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return [26, 26, 46];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function lienzo(ancho, alto, fondo) {
  const rgb = Buffer.alloc(ancho * alto * 3);
  for (let i = 0; i < ancho * alto; i++) rgb.set(fondo, i * 3);
  return { ancho, alto, rgb };
}

// Pinta un círculo (relleno o anillo) mezclando el color con opacidad `alfa`.
function circulo(l, cx, cy, radio, color, { alfa = 1, grosor = null } = {}) {
  const x0 = Math.max(0, Math.floor(cx - radio - 1));
  const x1 = Math.min(l.ancho - 1, Math.ceil(cx + radio + 1));
  const y0 = Math.max(0, Math.floor(cy - radio - 1));
  const y1 = Math.min(l.alto - 1, Math.ceil(cy + radio + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cobertura = grosor === null
        ? radio - d + 0.5
        : grosor / 2 - Math.abs(d - (radio - grosor / 2)) + 0.5;
      const a = Math.min(1, Math.max(0, cobertura)) * alfa;
      if (a <= 0) continue;
      const i = (y * l.ancho + x) * 3;
      for (let c = 0; c < 3; c++) l.rgb[i + c] = Math.round(l.rgb[i + c] * (1 - a) + color[c] * a);
    }
  }
}

function filasPara(total) {
  if (total <= 6) return 1;
  if (total <= 16) return 2;
  return 3;
}

// Parte del ancho donde van las estampas. El strip mide 375 pt, pero en la mayoría
// de los iPhone la tarjeta se muestra más angosta (~340 pt) y iOS recorta los
// bordes de la imagen: con un 10 % de margen por lado ninguna estampa queda cortada.
const ANCHO_UTIL = 0.8;

// Tamaño de cada celda y centro de cada estampa en la tira (filas centradas).
function distribuirEstampas(total, ancho, alto) {
  const filas = filasPara(total);
  const columnas = Math.ceil(total / filas);
  const celda = Math.min((ancho * ANCHO_UTIL) / columnas, (alto * 0.9) / filas);
  const origenY = (alto - celda * filas) / 2;
  const centros = Array.from({ length: total }, (_, i) => {
    const fila = Math.floor(i / columnas);
    const enFila = fila === filas - 1 ? total - columnas * (filas - 1) : columnas;
    const origenX = (ancho - celda * enFila) / 2;
    return { x: origenX + celda * ((i % columnas) + 0.5), y: origenY + celda * (fila + 0.5) };
  });
  return { celda, centros };
}

/**
 * Tira de sellos. Por defecto 750x246 (strip @2x de Apple para storeCard;
 * Google también la acepta como hero image).
 */
function tiraSellos({ total, llenos, fondo, sello, ancho = 750, alto = 246 }) {
  const colorFondo = hexARgb(fondo);
  const colorSello = hexARgb(sello);
  const l = lienzo(ancho, alto, colorFondo);
  const { celda, centros } = distribuirEstampas(total, ancho, alto);
  const radio = celda * 0.38;

  for (let i = 0; i < total; i++) {
    const { x: cx, y: cy } = centros[i];
    if (i < llenos) {
      circulo(l, cx, cy, radio, colorSello);
      circulo(l, cx, cy, radio * 0.42, colorFondo, { alfa: 0.9 });
    } else {
      circulo(l, cx, cy, radio, colorSello, { alfa: 0.45, grosor: Math.max(2, radio * 0.12) });
    }
  }
  return codificarPng(ancho, alto, l.rgb);
}

// Ícono cuadrado genérico (Apple icon.png y logo de Google si el negocio no tiene).
function icono({ tam, fondo, color }) {
  const colorFondo = hexARgb(fondo);
  const l = lienzo(tam, tam, colorFondo);
  const c = tam / 2;
  circulo(l, c, c, tam * 0.34, hexARgb(color));
  circulo(l, c, c, tam * 0.15, colorFondo);
  return codificarPng(tam, tam, l.rgb);
}

// Caché pequeña en memoria: las imágenes dependen solo de sus parámetros.
const cache = new Map();
function conCache(clave, generar) {
  if (cache.has(clave)) return cache.get(clave);
  const png = generar();
  if (cache.size >= 300) cache.delete(cache.keys().next().value);
  cache.set(clave, png);
  return png;
}

module.exports = {
  tiraSellos: (p) => conCache(`tira:${JSON.stringify(p)}`, () => tiraSellos(p)),
  icono: (p) => conCache(`icono:${JSON.stringify(p)}`, () => icono(p)),
  distribuirEstampas,
  hexARgb,
};
