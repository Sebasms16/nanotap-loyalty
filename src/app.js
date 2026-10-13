// Nanotap Loyalty — entrypoint de Express.
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const env = require('./config/env');
const log = require('./utils/logger');
const { HttpError } = require('./utils/errores');
const { slug: validarSlug } = require('./utils/validacion');
const appleWallet = require('./services/appleWallet.service');
const walletSync = require('./services/walletSync.service');

const app = express();
const PUBLICO = path.join(__dirname, 'public');

app.disable('x-powered-by');
app.set('trust proxy', 1); // detrás del proxy del hosting (Railway, Render, Nginx)

// RNF-01: en producción todo va por HTTPS.
if (env.produccion) {
  app.use((req, res, next) => {
    if (req.secure || req.path === '/salud') return next();
    res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
  });
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"], // html5-qrcode pone estilos inline
      'img-src': ["'self'", 'data:', 'blob:', 'https:'], // logos de negocios en otros dominios
      'media-src': ["'self'", 'blob:'],
      'connect-src': ["'self'"],
      // En local se prueba por http (ej. desde el teléfono en la red Wi-Fi).
      'upgrade-insecure-requests': env.produccion ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  req.body ??= {}; // Express 5 deja body undefined si la petición no trae JSON
  next();
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get('/salud', (req, res) => res.json({ ok: true }));
app.use('/api/negocios', require('./routes/negocios.routes'));
app.use('/api/clientes', require('./routes/clientes.routes'));
app.use('/api/staff', require('./routes/staff.routes'));
app.use('/api/operador', require('./routes/operador.routes'));
app.use('/api/wallet/apple', require('./routes/wallet.apple.routes'));
app.use('/api/wallet/google', require('./routes/wallet.google.routes'));
app.use('/img', require('./routes/imagenes.routes'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

// ---------------------------------------------------------------------------
// Páginas
// ---------------------------------------------------------------------------
app.get('/vendor/html5-qrcode.min.js', (req, res) => {
  res.sendFile(require.resolve('html5-qrcode/html5-qrcode.min.js'), { maxAge: '7d' });
});
app.get(['/staff', '/staff/'], (req, res) => {
  const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(`/staff/login${q}`);
});
app.use(express.static(PUBLICO, { extensions: ['html'], index: 'index.html' }));

// Páginas por negocio: /{slug}/inscripcion, /{slug}/consulta, /{slug}/privacidad, /{slug}/staff
const paginaNegocio = (archivo) => (req, res, next) => {
  try { validarSlug(req.params.slug); } catch { return next(); }
  res.sendFile(path.join(PUBLICO, archivo));
};
app.get('/:slug/inscripcion', paginaNegocio('inscripcion.html'));
app.get('/:slug/consulta', paginaNegocio('consulta.html'));
app.get('/:slug/privacidad', paginaNegocio('privacidad.html'));
app.get('/:slug/staff', (req, res) => res.redirect(`/staff/?negocio=${encodeURIComponent(req.params.slug)}`));
app.get('/:slug', (req, res, next) => {
  try { validarSlug(req.params.slug); } catch { return next(); }
  res.redirect(`/${req.params.slug}/inscripcion`);
});

app.use((req, res) => res.status(404).sendFile(path.join(PUBLICO, '404.html')));

// ---------------------------------------------------------------------------
// Errores: mensaje en español para el usuario, detalle completo en el log.
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'El cuerpo de la solicitud no es JSON válido.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'La solicitud es demasiado grande.' });
  log.error('error no controlado', { operacion: `${req.method} ${req.path}`, error: err });
  res.status(500).json({ error: 'Ocurrió un error inesperado. Intente de nuevo.' });
});

function iniciar() {
  app.listen(env.port, () => {
    log.info('Nanotap Loyalty escuchando', {
      puerto: env.port, base_url: env.baseUrl, apple: env.apple.habilitado, google: env.google.habilitado,
    });
    if (!env.apple.habilitado) log.warn('Apple Wallet deshabilitado: faltan variables APPLE_* (ver .env.example)');
    if (!env.google.habilitado) log.warn('Google Wallet deshabilitado: faltan variables GOOGLE_* (ver .env.example)');
  });
  walletSync.iniciarWorker();
  appleWallet.iniciarRevisionCertificados();
}

if (require.main === module) iniciar();

module.exports = app;
