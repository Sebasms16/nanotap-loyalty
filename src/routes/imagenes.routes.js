// /img — imágenes generadas para las tarjetas. Son públicas porque Google
// las descarga desde sus servidores. Están acotadas en tamaño.
const express = require('express');
const QRCode = require('qrcode');
const imagen = require('../services/imagen.service');
const estampas = require('../services/estampas.service');
const marca = require('../services/marca.service');
const supabase = require('../db/supabaseClient');
const { esUuid } = require('../utils/validacion');
const { errorDb } = require('../utils/errores');

const router = express.Router();
const hex = (valor, porDefecto) => (/^[0-9a-f]{6}$/i.test(valor || '') ? `#${valor}` : porDefecto);
const entre = (valor, min, max, porDefecto) => {
  const n = Number.parseInt(valor, 10);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : porDefecto;
};

function enviarPng(res, png) {
  res.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.send(png);
}

router.get('/sellos.png', (req, res) => {
  const total = entre(req.query.total, 1, 30, 10);
  enviarPng(res, imagen.tiraSellos({
    total,
    llenos: entre(req.query.llenos, 0, total, 0),
    fondo: hex(req.query.fondo, '#1a1a2e'),
    sello: hex(req.query.sello, '#ffffff'),
  }));
});

// Zona de estampas de un negocio con su logo (hero image de Google Wallet).
// El negocio se lee de la BD con una caché corta; `v` en la URL solo sirve
// para que Google descargue de nuevo cuando cambia la marca.
const negocios = new Map();
async function negocioParaImagen(id, version, calcularVersion = marca.versionTira) {
  const guardado = negocios.get(id);
  // Si la URL pide otra versión de la marca, la caché está vieja: se relee.
  const vigente = guardado?.negocio && calcularVersion(guardado.negocio) === version;
  if (guardado && Date.now() - guardado.en < 60 * 1000 && (vigente || !version)) return guardado.negocio;
  const { data, error } = await supabase
    .from('negocios')
    .select('id, logo_url, sello_url, color_primario, color_secundario, color_fondo_sellos, sellos_para_premio, '
      + 'estampas_urls, estampa_final_url, estampas_pendientes, fondo_estampas_url, fondo_estampas_efecto')
    .eq('id', id).maybeSingle();
  if (error) throw errorDb(error, 'leer negocio para imagen');
  if (negocios.size >= 100) negocios.delete(negocios.keys().next().value);
  negocios.set(id, { negocio: data, en: Date.now() });
  return data;
}

router.get('/negocios/:id/estampas.png', async (req, res) => {
  if (!esUuid(req.params.id)) return res.sendStatus(404);
  const negocio = await negocioParaImagen(req.params.id, req.query.v);
  if (!negocio) return res.sendStatus(404);
  const llenos = entre(req.query.llenos, 0, negocio.sellos_para_premio, 0);
  enviarPng(res, await marca.tiraDelNegocio(negocio, llenos));
});

// Logo para Google Wallet, con margen para que no se corte en el círculo.
router.get('/negocios/:id/logo.png', async (req, res) => {
  if (!esUuid(req.params.id)) return res.sendStatus(404);
  const negocio = await negocioParaImagen(req.params.id, req.query.v, marca.versionLogo);
  const logo = negocio && await marca.cargarImagen(negocio.logo_url, { negocio_id: negocio.id });
  if (!logo) return res.sendStatus(404);
  enviarPng(res, await estampas.logoParaGoogle(logo, negocio.color_primario || '#1a1a2e'));
});

// Logo ancho para Google Wallet (wideProgramLogo), cuando el logo es alargado.
router.get('/negocios/:id/logo-ancho.png', async (req, res) => {
  if (!esUuid(req.params.id)) return res.sendStatus(404);
  const negocio = await negocioParaImagen(req.params.id, req.query.v, marca.versionLogo);
  const logo = negocio && await marca.cargarImagen(negocio.logo_url, { negocio_id: negocio.id });
  if (!logo) return res.sendStatus(404);
  enviarPng(res, await estampas.logoAnchoParaGoogle(logo));
});

// QR de muestra para la vista previa de la tarjeta en el panel del operador.
let qrEjemplo = null;
router.get('/qr-ejemplo.png', async (req, res) => {
  qrEjemplo ??= await QRCode.toBuffer('NAN-2026-EJEMPLO', { margin: 1, width: 240 });
  enviarPng(res, qrEjemplo);
});

router.get('/icono.png', (req, res) => {
  enviarPng(res, imagen.icono({
    tam: entre(req.query.tam, 29, 660, 660),
    fondo: hex(req.query.fondo, '#1a1a2e'),
    color: hex(req.query.color, '#ffffff'),
  }));
});

module.exports = router;
