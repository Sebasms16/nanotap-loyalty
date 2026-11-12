// Insignias de los niveles (Bronce, Plata, Oro, Diamante), dibujadas en SVG.
// Cada nivel tiene una pieza distinta sobre un escudo hexagonal, y el escudo gana adornos:
//   Bronce: gema redonda · Plata: gota (+ doble marco) · Oro: lingote (+ corona)
//   Diamante: diamante (+ resplandor detrás y destellos)
// Se usan en las páginas (/img/insignias/{clave}.svg) y dibujadas en la franja de la tarjeta,
// porque el campo de texto del nivel en Apple y Google no admite imágenes.
const sharp = require('sharp');

const PALETAS = {
  bronce:   { claro: '#f6c194', medio: '#c97a42', oscuro: '#7f4421', aro1: '#e3a06a', aro2: '#6e3a1c' },
  plata:    { claro: '#ffffff', medio: '#c3ccd6', oscuro: '#7d8896', aro1: '#f4f7fa', aro2: '#7b8694' },
  oro:      { claro: '#fff0a8', medio: '#f3b72a', oscuro: '#a96c08', aro1: '#ffe8a0', aro2: '#a8700f' },
  diamante: { claro: '#f1fbff', medio: '#86d3f5', oscuro: '#5865e6', aro1: '#d9f4ff', aro2: '#4a58c9' },
};
const CLAVES = Object.keys(PALETAS);
const NIVEL = { bronce: 0, plata: 1, oro: 2, diamante: 3 };

const f = (v) => v.toFixed(1);
const hexagono = (cx, cy, r) => [-90, -30, 30, 90, 150, 210]
  .map((a) => `${f(cx + r * Math.cos(a * Math.PI / 180))},${f(cy + r * Math.sin(a * Math.PI / 180))}`).join(' ');
const destello = (x, y, r, color) => `<path d="M${x} ${y - r} Q${x} ${y} ${x + r} ${y} Q${x} ${y} ${x} ${y + r} `
  + `Q${x} ${y} ${x - r} ${y} Q${x} ${y} ${x} ${y - r}Z" fill="${color}"/>`;

// Gema redonda vista de frente: mesa octogonal al centro y caras alrededor.
function gemaRedonda(p) {
  const cx = 60; const cy = 75; const R = 19; const r = 9;
  const punto = (radio, i) => [cx + radio * Math.cos((i * 45 - 112.5) * Math.PI / 180), cy + radio * Math.sin((i * 45 - 112.5) * Math.PI / 180)];
  const tonos = [p.claro, p.medio, p.oscuro, p.oscuro, p.medio, p.oscuro, p.medio, p.claro];
  const caras = Array.from({ length: 8 }, (_, i) => {
    const puntos = [punto(r, i), punto(r, i + 1), punto(R, i + 1), punto(R, i)];
    return `<polygon points="${puntos.map((q) => q.map(f).join(',')).join(' ')}" fill="${tonos[i]}"/>`;
  }).join('');
  const mesa = Array.from({ length: 8 }, (_, i) => punto(r, i).map(f).join(',')).join(' ');
  return `<g stroke="${p.oscuro}" stroke-width=".6" stroke-linejoin="round">${caras}<polygon points="${mesa}" fill="${p.claro}" fill-opacity=".9"/></g>`;
}

const PIEZAS = {
  bronce: gemaRedonda,
  plata: (p) => `<g stroke="${p.oscuro}" stroke-width=".6" stroke-linejoin="round">
    <path d="M60 52 C67 60 78 70 78 80 A18 18 0 0 1 42 80 C42 70 53 60 60 52 Z" fill="${p.medio}"/>
    <path d="M60 52 C56 62 50 72 50 80 A10 10 0 0 0 60 90 Z" fill="${p.claro}"/>
    <path d="M60 52 C64 62 70 72 70 80 A10 10 0 0 1 60 90 Z" fill="${p.oscuro}" fill-opacity=".75"/>
    <path d="M42 80 A18 18 0 0 0 78 80 A18 18 0 0 1 60 98 A18 18 0 0 1 42 80 Z" fill="${p.oscuro}" fill-opacity=".35"/></g>`,
  oro: (p) => `<g stroke="${p.oscuro}" stroke-width=".6" stroke-linejoin="round">
    <polygon points="49,60 71,60 76,65 76,87 71,92 49,92 44,87 44,65" fill="${p.medio}"/>
    <polygon points="49,60 71,60 67,67 53,67" fill="${p.claro}"/>
    <polygon points="71,60 76,65 76,87 67,85 67,67" fill="${p.oscuro}" fill-opacity=".8"/>
    <polygon points="49,92 71,92 67,85 53,85" fill="${p.oscuro}"/>
    <polygon points="49,60 53,67 53,85 44,87 44,65" fill="${p.claro}" fill-opacity=".7"/>
    <rect x="53" y="67" width="14" height="18" fill="${p.claro}" fill-opacity=".9"/></g>`,
  diamante: (p) => `<g stroke="${p.oscuro}" stroke-width=".6" stroke-linejoin="round">
    <polygon points="48,60 72,60 66,70 54,70" fill="${p.claro}"/>
    <polygon points="48,60 54,70 38,70" fill="${p.medio}"/>
    <polygon points="72,60 82,70 66,70" fill="${p.oscuro}"/>
    <polygon points="38,70 54,70 60,94" fill="${p.medio}"/>
    <polygon points="54,70 66,70 60,94" fill="${p.claro}" fill-opacity=".85"/>
    <polygon points="66,70 82,70 60,94" fill="${p.oscuro}"/></g>`,
};
// Brillo de cada pieza (x, y, tamaño) y cuánto subirla para centrarla en el escudo (y = 72).
const BRILLO = { bronce: [50, 68, 3.5], plata: [54, 72, 3.5], oro: [57, 71, 4], diamante: [52, 62, 4] };
const AJUSTE = { bronce: -3, plata: -3, oro: -4, diamante: -5 };

// Diamante: resplandor de puntas detrás del escudo.
function resplandor(relleno) {
  const puntos = Array.from({ length: 24 }, (_, n) => {
    const r = n % 2 ? 41 : (n % 4 ? 46 : 49);
    const a = (n * 15 - 90) * Math.PI / 180;
    return `${f(60 + r * Math.cos(a))},${f(70 + r * Math.sin(a))}`;
  });
  return `<polygon points="${puntos.join(' ')}" fill="${relleno}" opacity=".9"/>`;
}

const svgs = new Map();
// El SVG de la insignia (viewBox de 120 × 120). Devuelve null si la clave no es un nivel.
function svg(clave, tam = 120) {
  if (!PALETAS[clave]) return null;
  const guardado = svgs.get(`${clave}:${tam}`);
  if (guardado) return guardado;
  const p = PALETAS[clave];
  const n = NIVEL[clave];
  const id = (sufijo) => `n${clave}${sufijo}`; // ids únicos por nivel (varias insignias en una página)
  const partes = [`<defs>
    <linearGradient id="${id('aro')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.aro1}"/><stop offset="1" stop-color="${p.aro2}"/></linearGradient>
    <radialGradient id="${id('fondo')}" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#2b3140"/><stop offset="1" stop-color="#141821"/></radialGradient>
    <radialGradient id="${id('brillo')}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${p.medio}" stop-opacity=".55"/><stop offset="1" stop-color="${p.medio}" stop-opacity="0"/></radialGradient>
  </defs>`];
  if (n >= 3) partes.push(resplandor(`url(#${id('aro')})`));
  if (n >= 2) partes.push(`<circle cx="60" cy="72" r="46" fill="url(#${id('brillo')})"/>`);
  partes.push(`<polygon points="${hexagono(60, 72, 40)}" fill="url(#${id('fondo')})" stroke="url(#${id('aro')})" stroke-width="5" stroke-linejoin="round"/>`);
  if (n >= 1) partes.push(`<polygon points="${hexagono(60, 72, 32)}" fill="none" stroke="${p.aro1}" stroke-opacity=".55" stroke-width="1.6" stroke-linejoin="round"/>`);
  partes.push(`<g transform="translate(0 ${AJUSTE[clave]})">${PIEZAS[clave](p)}${destello(...BRILLO[clave], '#ffffff')}</g>`);
  if (n >= 2) {
    partes.push(`<path d="M42 33 L45 17 L53 26 L60 10 L67 26 L75 17 L78 33 Z" fill="url(#${id('aro')})" stroke="${p.aro2}" stroke-width="1" stroke-linejoin="round"/>`,
      `<circle cx="60" cy="13" r="2.6" fill="${p.claro}"/><circle cx="45" cy="19" r="2" fill="${p.claro}"/><circle cx="75" cy="19" r="2" fill="${p.claro}"/>`);
  }
  if (n >= 3) partes.push(destello(18, 40, 5, p.claro), destello(102, 40, 5, p.claro), destello(100, 104, 3.5, p.claro), destello(20, 104, 3.5, p.claro));
  const resultado = `<svg xmlns="http://www.w3.org/2000/svg" width="${tam}" height="${tam}" viewBox="0 0 120 120">${partes.join('')}</svg>`;
  svgs.set(`${clave}:${tam}`, resultado);
  return resultado;
}

// La insignia en PNG de `lado` px (para dibujarla en la franja). Se guarda: hay 4 niveles y pocos tamaños.
const pngs = new Map();
function png(clave, lado) {
  const llave = `${clave}:${lado}`;
  if (!pngs.has(llave)) pngs.set(llave, sharp(Buffer.from(svg(clave, lado))).png().toBuffer());
  return pngs.get(llave);
}

// Dónde va la insignia en la franja (fracciones del ancho y del alto).
//  - columna: centrada a la derecha, en el espacio que le dejan las estampas corridas a la
//    izquierda (imagen.distribuirEstampas con conInsignia: llegan hasta el 82 % del ancho).
//  - esquina: arriba a la derecha y más chica, cuando la franja lleva algo centrado (cashback).
function posicion(ancho, alto, lugar) {
  if (lugar === 'esquina') {
    const lado = Math.round(Math.min(alto * 0.3, ancho * 0.085));
    return { lado, left: Math.round(ancho * 0.988 - lado), top: Math.round(alto * 0.06) };
  }
  const lado = Math.round(Math.min(ancho * 0.13, alto * 0.6));
  return { lado, left: Math.round(ancho * 0.9 - lado / 2), top: Math.round((alto - lado) / 2) };
}

async function enFranja(tira, clave, { lugar = 'columna' } = {}) {
  if (!PALETAS[clave]) return tira;
  const { width: ancho, height: alto } = await sharp(tira).metadata();
  const { lado, left, top } = posicion(ancho, alto, lugar);
  return sharp(tira).composite([{ input: await png(clave, lado), left, top }]).png().toBuffer();
}

module.exports = { svg, png, enFranja, posicion, CLAVES };
