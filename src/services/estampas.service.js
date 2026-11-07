// Tira de estampas con las imágenes del negocio: cada posición puede tener su
// propia imagen. La estampa obtenida la muestra a color; la pendiente, en gris y
// tenue, o como un círculo vacío si el negocio prefiere no revelarla.
// La imagen se respeta tal cual (sin aro ni recorte en círculo): su forma es la estampa.
// Se usa como strip de Apple Wallet y como hero image de Google Wallet.
const path = require('node:path');
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
// un punto al centro para una estampa obtenida. Una pendiente sin imagen (u oculta)
// es un aro punteado, como en el panel del staff, en el color `aro`.
function circulo(lado, { color, fondo, lleno, aro = color }) {
  const c = lado / 2;
  const radio = lado * 0.45;
  let svg;
  if (lleno) {
    svg = `<circle cx="${c}" cy="${c}" r="${radio}" fill="${color}"/>`
      + `<circle cx="${c}" cy="${c}" r="${radio * 0.42}" fill="${fondo}" fill-opacity="0.9"/>`;
  } else {
    const r = radio * 0.94;
    const trazo = (2 * Math.PI * r) / 32; // 16 trazos con 16 espacios iguales
    svg = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${aro}" stroke-opacity="0.7"`
      + ` stroke-width="${Math.max(2, radio * 0.1)}" stroke-dasharray="${trazo} ${trazo}" stroke-linecap="round"/>`;
  }
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${lado}" height="${lado}">${svg}</svg>`))
    .png().toBuffer();
}

// Contraste (WCAG) entre dos colores [r, g, b].
function luminancia(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contraste(a, b) {
  const [claro, oscuro] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (claro + 0.05) / (oscuro + 0.05);
}

// Color del aro de las pendientes: el primero de los colores del negocio que se
// distinga del fondo (3:1, lo mínimo para un gráfico); si ninguno, blanco u oscuro.
// Hace falta porque muchos negocios usan el mismo color para el texto y el fondo de las estampas.
function colorQueSeVe(fondoRgb, candidatos) {
  const opciones = [...candidatos.filter(Boolean), '#ffffff', '#1f1f1f'];
  return opciones.find((hex) => contraste(hexARgb(hex), fondoRgb) >= 3)
    || opciones.reduce((mejor, hex) => (contraste(hexARgb(hex), fondoRgb) > contraste(hexARgb(mejor), fondoRgb) ? hex : mejor));
}

// Color promedio de la foto de fondo (para elegir un aro que se vea encima).
async function colorPromedio(png) {
  const { channels } = await sharp(png).stats();
  return channels.slice(0, 3).map((canal) => Math.round(canal.mean));
}

/**
 * @param {(Buffer|null)[]} imagenes una por estampa (PNG, JPG, WebP o SVG); null = círculo
 * @param {number} total    estampas para el premio
 * @param {number} llenos   estampas obtenidas
 * @param {string} fondo    color de fondo de la zona de estampas (#rrggbb)
 * @param {string} sello    color de los círculos de las posiciones sin imagen (#rrggbb)
 * @param {boolean} ocultas las pendientes se ven como círculo vacío en vez de la imagen en gris
 * @param {Buffer} [base]   fondo ya armado de ancho × alto (foto de fondo); si no, el color `fondo`
 * @param {string} [tarjeta] color de la tarjeta: otra opción para el aro de las pendientes
 */
async function tiraConImagenes({
  imagenes, total, llenos, fondo, sello = '#ffffff', ocultas = false, ancho = 750, alto = 246, base = null, tarjeta = null,
}) {
  const { celda, centros } = distribuirEstampas(total, ancho, alto);
  const lado = Math.round(celda * 0.84);
  const hayAros = imagenes.slice(llenos, total).some((imagen) => !imagen || ocultas);
  const aro = hayAros ? colorQueSeVe(base ? await colorPromedio(base) : hexARgb(fondo), [sello, tarjeta]) : sello;

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
  const circulos = memo((esLleno) => circulo(lado, { color: sello, fondo, lleno: esLleno, aro }));

  const capas = await Promise.all(Array.from({ length: total }, async (_, i) => {
    const imagen = imagenes[i] || null;
    const input = i < llenos
      ? await (imagen ? color(imagen) : circulos(true))
      : await (imagen && !ocultas ? gris(imagen) : circulos(false));
    const { x, y } = centros[i];
    return { input, left: Math.round(x - lado / 2), top: Math.round(y - lado / 2) };
  }));

  const [r, g, b] = hexARgb(fondo);
  return sharp(base || { create: { width: ancho, height: alto, channels: 3, background: { r, g, b } } })
    .composite(capas)
    .png()
    .toBuffer();
}

// --- Programa de puntos: barra de avance ------------------------------------
/**
 * Franja de una tarjeta de puntos: una barra que se llena con el saldo y una
 * marca por cada premio del catálogo (rellena si ya le alcanza). Sin texto: el
 * saldo y el próximo premio van en los campos de la tarjeta.
 * @param {number} puntos saldo del cliente
 * @param {number[]} metas costo de cada premio, en puntos
 */
async function tiraPuntos({ puntos, metas, fondo, sello = '#ffffff', tarjeta = null, ancho = 750, alto = 246, base = null }) {
  const fondoRgb = base ? await colorPromedio(base) : hexARgb(fondo);
  const color = colorQueSeVe(fondoRgb, [sello, tarjeta]);
  const relleno = `rgb(${fondoRgb.join(',')})`;
  const tope = Math.max(1, ...metas);
  // Mismo margen a los lados que las estampas, para que el iPhone no corte las marcas.
  const x0 = ancho * 0.12;
  const x1 = ancho * 0.88;
  const cy = alto / 2;
  const grosor = alto * 0.09;
  const radio = alto * 0.13;
  const x = (valor) => x0 + (x1 - x0) * Math.min(1, Math.max(0, valor / tope));
  const avance = x(puntos);
  const marcas = metas.map((meta) => {
    const cx = x(meta);
    if (puntos >= meta) {
      return `<circle cx="${cx}" cy="${cy}" r="${radio}" fill="${color}"/>`
        + `<circle cx="${cx}" cy="${cy}" r="${radio * 0.42}" fill="${relleno}"/>`;
    }
    const trazo = (2 * Math.PI * radio * 0.94) / 24;
    return `<circle cx="${cx}" cy="${cy}" r="${radio * 0.94}" fill="${relleno}" stroke="${color}" stroke-opacity="0.75"`
      + ` stroke-width="${Math.max(2, radio * 0.14)}" stroke-dasharray="${trazo} ${trazo}" stroke-linecap="round"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}">`
    + `<rect x="${x0}" y="${cy - grosor / 2}" width="${x1 - x0}" height="${grosor}" rx="${grosor / 2}" fill="${color}" fill-opacity="0.3"/>`
    + (avance > x0 ? `<rect x="${x0}" y="${cy - grosor / 2}" width="${avance - x0}" height="${grosor}" rx="${grosor / 2}" fill="${color}"/>` : '')
    + marcas
    + '</svg>';
  const [r, g, b] = hexARgb(fondo);
  return sharp(base || { create: { width: ancho, height: alto, channels: 3, background: { r, g, b } } })
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
}

// La letra va dentro del proyecto: el servidor no tiene fuentes instaladas.
const FUENTES = {
  negrita: { font: 'Poppins Bold', fontfile: path.join(__dirname, '..', 'assets', 'fuentes', 'Poppins-Bold.ttf') },
  media: { font: 'Poppins Medium', fontfile: path.join(__dirname, '..', 'assets', 'fuentes', 'Poppins-Medium.ttf') },
};
const escaparXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Una línea de texto (PNG transparente) del tamaño más grande que cabe en ancho × alto.
async function lineaDeTexto(texto, { color, fuente, ancho, alto }) {
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${color}">${escaparXml(texto)}</span>`,
      ...FUENTES[fuente], rgba: true, width: Math.round(ancho), height: Math.round(alto),
    },
  }).png().toBuffer({ resolveWithObject: true });
  return { png: data, ancho: info.width, alto: info.height };
}

/**
 * Franja de una tarjeta de cashback: no hay estampas que llenar, así que es la foto
 * del negocio (o el color de fondo) con el porcentaje encima. El saldo va en los campos.
 * @param {string} porcentaje ya formateado ("5 %", "2,5 %")
 * @param {Buffer} [base]     la foto ya recortada y con su efecto (fondoConFoto)
 * @param {string} [efecto]   el de la foto: con «clara» el texto va oscuro
 * @param {boolean} [texto]   false = solo la foto (o el color), sin nada encima: una portada propia
 */
async function tiraCashback({
  porcentaje, fondo, sello = '#ffffff', tarjeta = null, ancho = 750, alto = 246, base = null, efecto = 'nitida', texto = true,
}) {
  const [r, g, b] = hexARgb(fondo);
  const lienzo = base || { create: { width: ancho, height: alto, channels: 3, background: { r, g, b } } };
  if (!texto) return sharp(lienzo).png().toBuffer();
  // Sobre la foto, blanco con sombra (oscuro si la foto está aclarada); sobre el color, el que se distinga.
  const claro = base && efecto === 'clara';
  const color = base ? (claro ? '#1f1f1f' : '#ffffff') : colorQueSeVe([r, g, b], [sello, tarjeta]);
  const capas = [];
  if (base) {
    // Un velo suave detrás del texto para que se lea en cualquier foto.
    const velo = claro ? '#ffffff' : '#000000';
    capas.push({
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}">`
        + `<defs><radialGradient id="v" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${velo}" stop-opacity="0.5"/>`
        + `<stop offset="1" stop-color="${velo}" stop-opacity="0"/></radialGradient></defs>`
        + `<ellipse cx="${ancho / 2}" cy="${alto / 2}" rx="${ancho * 0.48}" ry="${alto * 0.62}" fill="url(#v)"/></svg>`),
    });
  }
  try {
    // Mismo margen a los lados que las estampas, para que el iPhone no corte el texto.
    const [arriba, abajo] = await Promise.all([
      lineaDeTexto(`${porcentaje} de cashback`, { color, fuente: 'negrita', ancho: ancho * 0.7, alto: alto * 0.28 }),
      lineaDeTexto('en cada compra', { color, fuente: 'media', ancho: ancho * 0.44, alto: alto * 0.14 }),
    ]);
    const hueco = Math.round(alto * 0.075);
    let y = Math.round((alto - arriba.alto - hueco - abajo.alto) / 2);
    for (const linea of [arriba, abajo]) {
      const left = Math.round((ancho - linea.ancho) / 2);
      if (base && !claro) {
        const sombra = await sharp(linea.png).linear([0, 0, 0, 0.55], [0, 0, 0, 0])
          .blur(Math.max(1, alto / 90)).png().toBuffer();
        capas.push({ input: sombra, left, top: y + Math.max(1, Math.round(alto / 120)) });
      }
      capas.push({ input: linea.png, left, top: y });
      y += linea.alto + hueco;
    }
  } catch {
    // Sin texto (no debería pasar): queda la foto o el color, y el % sigue en los campos de la tarjeta.
  }
  return sharp(lienzo).composite(capas).png().toBuffer();
}

// Estilos de la franja de puntos. 'linea' es la barra continua de tiraPuntos.
const ESTILOS_PUNTOS = ['linea', 'tramos', 'proximo', 'iconos'];

// Cuánto lleva el cliente del tramo que termina en metas[i] (0 a 1).
function avanceDelTramo(puntos, metas, i) {
  const desde = i === 0 ? 0 : metas[i - 1];
  return Math.min(1, Math.max(0, (puntos - desde) / Math.max(1, metas[i] - desde)));
}

// Marca de premio: aro relleno con punto al centro si ya le alcanza; si no, aro punteado.
function marcaPremio(cx, cy, radio, { alcanzado, color, relleno }) {
  if (alcanzado) {
    return `<circle cx="${cx}" cy="${cy}" r="${radio}" fill="${color}"/>`
      + `<circle cx="${cx}" cy="${cy}" r="${radio * 0.42}" fill="${relleno}"/>`;
  }
  const r = radio * 0.94;
  const trazo = (2 * Math.PI * r) / 24;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${relleno}" stroke="${color}" stroke-opacity="0.75"`
    + ` stroke-width="${Math.max(2, radio * 0.14)}" stroke-dasharray="${trazo} ${trazo}" stroke-linecap="round"/>`;
}

// Barra con fondo tenue y la parte avanzada en color sólido.
function barra(xa, xb, cy, grosor, fraccion, color) {
  const largo = Math.max(0, xb - xa);
  const lleno = largo * fraccion;
  return `<rect x="${xa}" y="${cy - grosor / 2}" width="${largo}" height="${grosor}" rx="${grosor / 2}" fill="${color}" fill-opacity="0.3"/>`
    + (lleno > 0.5 ? `<rect x="${xa}" y="${cy - grosor / 2}" width="${Math.max(lleno, grosor)}" height="${grosor}" rx="${grosor / 2}" fill="${color}"/>` : '');
}

/**
 * Franja de puntos en el estilo elegido por el negocio:
 *  - linea:   barra continua con una marca en cada premio (proporcional a los puntos).
 *  - tramos:  un tramo del mismo largo por premio; cada uno se llena hasta su premio.
 *  - proximo: una barra grande solo hasta el próximo premio, y abajo un punto por premio.
 *  - iconos:  la imagen de cada premio (a color si ya le alcanza, en gris si no), unidas por la barra.
 * @param {(Buffer|null)[]} [imagenes] una por premio, para 'proximo' e 'iconos'; null = círculo
 */
async function tiraPuntosEstilo({ estilo = 'linea', imagenes = [], ...opciones }) {
  const { puntos, fondo, sello = '#ffffff', tarjeta = null, ancho = 750, alto = 246, base = null } = opciones;
  const metas = [...opciones.metas].sort((a, b) => a - b);
  if (estilo === 'linea' || !ESTILOS_PUNTOS.includes(estilo) || !metas.length) return tiraPuntos({ ...opciones, metas });

  const fondoRgb = base ? await colorPromedio(base) : hexARgb(fondo);
  const color = colorQueSeVe(fondoRgb, [sello, tarjeta]);
  const relleno = `rgb(${fondoRgb.join(',')})`;
  const x0 = ancho * 0.12;
  const x1 = ancho * 0.88;
  const cy = alto / 2;
  const grosor = alto * 0.09;
  let svg = '';
  const capas = [];

  if (estilo === 'tramos') {
    const radio = alto * 0.11;
    const hueco = alto * 0.035;
    const paso = (x1 - x0) / metas.length;
    const centro = (i) => x0 + paso * (i + 1) - radio;
    metas.forEach((meta, i) => {
      const inicio = i === 0 ? x0 : centro(i - 1) + radio + hueco;
      svg += barra(inicio, centro(i) - radio - hueco, cy, grosor, avanceDelTramo(puntos, metas, i), color);
      svg += marcaPremio(centro(i), cy, radio, { alcanzado: puntos >= meta, color, relleno });
    });
  }

  if (estilo === 'proximo') {
    const i = metas.findIndex((meta) => meta > puntos);
    const todos = i === -1;
    const actual = todos ? metas.length - 1 : i;
    const yBarra = alto * 0.43;
    const lado = Math.round(alto * 0.44);
    const centro = x1 - lado / 2;
    svg += barra(x0, centro - lado / 2 - alto * 0.05, yBarra, alto * 0.13, todos ? 1 : avanceDelTramo(puntos, metas, actual), color);
    const imagen = imagenes[actual];
    if (imagen) {
      const icono = await estampaColor(imagen, lado);
      capas.push({ input: todos ? icono : await estampaGris(icono), left: Math.round(centro - lado / 2), top: Math.round(yBarra - lado / 2) });
    } else {
      svg += marcaPremio(centro, yBarra, lado * 0.45, { alcanzado: todos, color, relleno });
    }
    // Un punto por premio del catálogo: los que ya le alcanzan, rellenos.
    const r = alto * 0.03;
    const sep = r * 4;
    const yPuntos = alto * 0.82;
    const primero = (x0 + x1) / 2 - (sep * (metas.length - 1)) / 2;
    metas.forEach((meta, k) => {
      const cx = primero + sep * k;
      svg += puntos >= meta
        ? `<circle cx="${cx}" cy="${yPuntos}" r="${r}" fill="${color}"/>`
        : `<circle cx="${cx}" cy="${yPuntos}" r="${r * 0.85}" fill="none" stroke="${color}" stroke-opacity="0.7" stroke-width="${Math.max(1.5, r * 0.35)}"/>`;
    });
  }

  if (estilo === 'iconos') {
    const lado = Math.round(Math.min(alto * 0.4, ((x1 - x0) / metas.length) * 0.55));
    const paso = (x1 - lado / 2 - x0) / metas.length;
    const centros = metas.map((_, i) => x0 + paso * (i + 1));
    metas.forEach((meta, i) => {
      const inicio = i === 0 ? x0 : centros[i - 1];
      svg += barra(inicio, centros[i], cy, grosor * 0.8, avanceDelTramo(puntos, metas, i), color);
    });
    await Promise.all(metas.map(async (meta, i) => {
      const alcanzado = puntos >= meta;
      // Círculo del color del fondo detrás de cada imagen, para que la barra no se vea a través.
      svg += `<circle cx="${centros[i]}" cy="${cy}" r="${lado * 0.5}" fill="${relleno}"/>`;
      const imagen = imagenes[i];
      if (!imagen) {
        svg += marcaPremio(centros[i], cy, lado * 0.45, { alcanzado, color, relleno });
        return;
      }
      const icono = await estampaColor(imagen, Math.round(lado * 0.9));
      capas.push({
        input: alcanzado ? icono : await estampaGris(icono),
        left: Math.round(centros[i] - lado * 0.45),
        top: Math.round(cy - lado * 0.45),
      });
    }));
  }

  const [r, g, b] = hexARgb(fondo);
  return sharp(base || { create: { width: ancho, height: alto, channels: 3, background: { r, g, b } } })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}">${svg}</svg>`) }, ...capas])
    .png()
    .toBuffer();
}

// --- Foto de fondo de la zona de estampas -----------------------------------
// Efectos que puede elegir el negocio para que las estampas se lean sobre la foto.
const EFECTOS_FONDO = ['nitida', 'borrosa', 'oscura', 'borrosa_oscura', 'clara', 'byn', 'color'];

const capaDeColor = (ancho, alto, color, opacidad) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}">`
  + `<rect width="${ancho}" height="${alto}" fill="${color}" fill-opacity="${opacidad}"/></svg>`);

/**
 * La foto recortada para llenar la franja (se busca la parte más llamativa) con su efecto:
 * nitida tal cual; borrosa; oscura (velo negro); borrosa_oscura; clara (velo blanco,
 * para estampas oscuras); byn (blanco y negro); color (en gris, teñida con `color`).
 */
async function fondoConFoto(foto, { ancho, alto, efecto = 'nitida', color = '#000000' }) {
  const [r, g, b] = hexARgb(color);
  const recorte = await sharp(foto).rotate()
    .resize(ancho, alto, { fit: 'cover', position: sharp.strategy.attention })
    .flatten({ background: { r, g, b } })
    .png().toBuffer();
  let img = sharp(recorte);
  if (efecto === 'borrosa' || efecto === 'borrosa_oscura') img = img.blur(Math.max(1, ancho / 80));
  if (efecto === 'byn' || efecto === 'color') img = img.grayscale();
  const velo = {
    oscura: ['#000000', 0.45], borrosa_oscura: ['#000000', 0.4], clara: ['#ffffff', 0.5], color: [color, 0.6],
  }[efecto];
  // El velo va en un segundo paso, sobre la foto ya borrosa o en gris (así no
  // depende del orden en que sharp aplica las operaciones de un mismo paso).
  if (!velo) return img.png().toBuffer();
  return sharp(await img.png().toBuffer())
    .composite([{ input: capaDeColor(ancho, alto, ...velo) }])
    .png().toBuffer();
}

// Normaliza una imagen subida por el operador: valida, limita a 660 px y la pasa a PNG.
async function normalizarImagen(buffer) {
  const meta = await sharp(buffer).metadata(); // lanza si no es una imagen
  if (!meta.width || !meta.height) throw new Error('imagen sin dimensiones');
  return sharp(buffer).rotate().resize(660, 660, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
}

// Foto de fondo: hasta 1600 px y en JPG (en PNG una foto pesa varias veces más).
// 1600 px alcanza para la franja más grande (la de iPhone @3x mide 1125 px).
async function normalizarFoto(buffer) {
  const meta = await sharp(buffer).metadata(); // lanza si no es una imagen
  if (!meta.width || !meta.height) throw new Error('imagen sin dimensiones');
  return sharp(buffer).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();
}

// Logo listo para la tarjeta. Con fondo transparente se le quita el margen para
// que el dibujo ocupe todo el espacio. Con fondo sólido (JPG, o PNG sin
// transparencia) se respeta su margen y se le redondean las esquinas, como un
// ícono: recortarlo dejaría un borde finito del fondo pegado al dibujo.
async function logoListo(logo) {
  if (!(await sharp(logo).stats()).isOpaque) return sinMargen(logo);
  const { width, height } = await sharp(logo).metadata();
  const radio = Math.round(Math.min(width, height) * 0.18);
  const mascara = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="${width}" height="${height}" rx="${radio}" ry="${radio}" fill="#fff"/></svg>`);
  return sharp(logo).ensureAlpha().composite([{ input: mascara, blend: 'dest-in' }]).png().toBuffer();
}

// Desde 2:1 un logo se trata como alargado: casi siempre ya trae el nombre del
// negocio, y en un círculo o junto al nombre quedaría diminuto.
const PROPORCION_ANCHO = 2;

// Proporción ancho/alto del dibujo del logo (sin su margen transparente).
async function proporcionLogo(logo) {
  const { width, height } = await sharp(await logoListo(logo)).metadata();
  return width / height;
}

// Logo ancho de Google Wallet (wideProgramLogo): PNG transparente de 1280 × 400
// (16:5, lo que pide Google), con el logo alineado a la izquierda.
async function logoAnchoParaGoogle(logo) {
  return sharp(await logoListo(logo))
    .resize(1280, 400, { fit: 'contain', position: 'left', background: TRANSPARENTE })
    .png()
    .toBuffer();
}

// Logo para el encabezado de Apple Wallet: máximo 160x50 pt.
async function logoEncabezado(logo, escala) {
  return sharp(await logoListo(logo))
    .resize(160 * escala, 50 * escala, { fit: 'inside' })
    .png()
    .toBuffer();
}

// Logo para Google Wallet: Google lo muestra recortado en círculo, así que se
// centra con margen sobre el color de la tarjeta para que nunca se corte.
async function logoParaGoogle(logo, fondo, tam = 660) {
  const [r, g, b] = hexARgb(fondo);
  const interior = Math.round(tam * 0.64);
  const dibujo = await sharp(await logoListo(logo))
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

module.exports = {
  tiraConImagenes, tiraPuntos, tiraPuntosEstilo, tiraCashback, ESTILOS_PUNTOS, normalizarImagen, normalizarFoto, fondoConFoto, EFECTOS_FONDO, logoEncabezado, logoParaGoogle, logoAnchoParaGoogle, iconoDesdeLogo,
  proporcionLogo, PROPORCION_ANCHO,
};
