// /api/operador — panel del operador (RF-08): login, resumen de negocios,
// búsqueda de clientes (para solicitudes de la Ley 8968) y estado del sistema.
const express = require('express');
const supabase = require('../db/supabaseClient');
const env = require('../config/env');
const appleWallet = require('../services/appleWallet.service');
const marca = require('../services/marca.service');
const { reglasDelNegocio } = require('../utils/reglas');
const log = require('../utils/logger');
const v = require('../utils/validacion');
const { HttpError, errorDb } = require('../utils/errores');
const { firmarOperador, passwordOperadorValida, requiereOperador } = require('../middlewares/auth.middleware');
const { limiteLogin } = require('../middlewares/limites.middleware');

const router = express.Router();

router.post('/login', limiteLogin, (req, res) => {
  if (!passwordOperadorValida(req.body.password)) {
    log.warn('login de operador fallido', { operacion: 'login_operador' });
    throw new HttpError(401, 'Contraseña incorrecta.');
  }
  log.info('login de operador', { operacion: 'login_operador' });
  res.json({ token: firmarOperador() });
});

router.get('/negocios', requiereOperador, async (req, res) => {
  const { data, error } = await supabase.from('negocios_resumen').select('*').order('creado_en');
  if (error) throw errorDb(error, 'listar negocios');
  res.json({ negocios: data.map((n) => ({ ...n, reglas_lista: reglasDelNegocio(n) })), base_url: env.baseUrl });
});

// Busca clientes de un negocio por teléfono, correo o nombre.
router.get('/clientes', requiereOperador, async (req, res) => {
  if (!v.esUuid(req.query.negocio_id)) throw new HttpError(400, 'Indique el negocio.');
  const q = String(req.query.q || '').trim().replace(/[,()%*\\]/g, ' ').trim();
  if (q.length < 3) throw new HttpError(400, 'Escriba al menos 3 caracteres para buscar.');
  const telefono = v.normalizarTelefono(q);
  const filtros = [`correo.ilike.%${q}%`, `nombre.ilike.%${q}%`, `primer_apellido.ilike.%${q}%`];
  if (telefono.length >= 4) filtros.push(`telefono.like.%${telefono}%`);
  const { data, error } = await supabase
    .from('clientes')
    .select('id, nombre, primer_apellido, segundo_apellido, telefono, correo, codigo_qr, sellos_actuales, premios_canjeados, acepto_terminos_en, creado_en')
    .eq('negocio_id', req.query.negocio_id)
    .or(filtros.join(','))
    .order('creado_en', { ascending: false })
    .limit(25);
  if (error) throw errorDb(error, 'buscar clientes');
  res.json({ clientes: data });
});

router.get('/estado', requiereOperador, async (req, res) => {
  const { count, error } = await supabase
    .from('wallet_sync_pendientes').select('id', { count: 'exact', head: true });
  if (error) throw errorDb(error, 'contar pendientes');
  res.json({
    apple: { habilitado: env.apple.habilitado, certificados: appleWallet.estadoCertificados() },
    google: { habilitado: env.google.habilitado },
    sincronizaciones_pendientes: count,
  });
});

// Vista previa de la zona de estampas mientras se edita un negocio, antes de guardar.
// El cuerpo puede traer la imagen elegida (aún sin subir); si no, se usa la imagen
// guardada del negocio indicada en ?fuente=sello|logo. Mismo dibujo que en las tarjetas.
router.post('/vista-previa/estampas', requiereOperador, express.raw({ type: 'image/*', limit: '5mb' }), async (req, res) => {
  const color = (valor, porDefecto) => (/^[0-9a-f]{6}$/i.test(valor || '') ? `#${valor}` : porDefecto);
  const total = Math.min(30, Math.max(1, Number.parseInt(req.query.total, 10) || 10));
  const negocio = {
    id: req.query.negocio_id,
    sellos_para_premio: total,
    color_primario: color(req.query.fondo, '#1a1a2e'),
    color_secundario: color(req.query.color, '#ffffff'),
    logo_url: null,
    sello_url: null,
  };
  const archivo = Buffer.isBuffer(req.body) && req.body.length ? req.body : null;
  if (!archivo && v.esUuid(req.query.negocio_id) && ['sello', 'logo'].includes(req.query.fuente)) {
    const campo = marca.TIPOS[req.query.fuente];
    const { data, error } = await supabase.from('negocios').select(campo).eq('id', req.query.negocio_id).maybeSingle();
    if (error) throw errorDb(error, 'leer imagen para vista previa');
    negocio[campo] = data?.[campo] || null;
  }
  const llenos = Math.min(total, Math.max(0, Number.parseInt(req.query.llenos, 10) || 0));
  const png = await marca.tiraDelNegocio(negocio, llenos, { imagenEstampa: archivo });
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).send(png);
});

module.exports = router;
