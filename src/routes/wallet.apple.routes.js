// /api/wallet/apple — descarga del .pkpass y "PassKit Web Service" de Apple.
//
// Las rutas /v1/... y su comportamiento los define Apple (no son negociables):
// https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes
//
// Flujo de actualización (RF-07):
//   1. Al agregar el pass, el iPhone hace POST .../registrations/... con su pushToken.
//   2. Al cambiar los sellos, mandamos un push vacío a ese token (apnsPush).
//   3. El iPhone hace GET .../registrations/<passType>?passesUpdatedSince=<tag>
//      y le devolvemos los seriales modificados desde ese tag.
//   4. Por cada serial hace GET /v1/passes/<passType>/<serial> y descarga la versión nueva.
// Las rutas que traen serial se autentican con "Authorization: ApplePass <authenticationToken>".
const crypto = require('node:crypto');
const express = require('express');
const supabase = require('../db/supabaseClient');
const env = require('../config/env');
const appleWallet = require('../services/appleWallet.service');
const log = require('../utils/logger');
const { errorDb } = require('../utils/errores');
const { limiteWallet } = require('../middlewares/limites.middleware');

const router = express.Router();

router.use((req, res, next) => {
  if (!env.apple.habilitado) return res.status(404).json({ error: 'Apple Wallet no está configurado.' });
  next();
});

async function passConCliente(serialNumber) {
  const { data, error } = await supabase
    .from('wallet_passes')
    .select('*, cliente:clientes(*, negocio:negocios(*))')
    .eq('serial_number', serialNumber)
    .eq('plataforma', 'apple')
    .maybeSingle();
  if (error) throw errorDb(error, 'buscar pass Apple');
  return data;
}

function tokenValido(req, pass) {
  const [esquema, token] = (req.get('authorization') || '').split(' ');
  if (esquema !== 'ApplePass' || !token || !pass?.auth_token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(pass.auth_token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function enviarPass(res, pass) {
  const buffer = await appleWallet.generarPass({ cliente: pass.cliente, negocio: pass.cliente.negocio, pass });
  res.set({
    'Content-Type': 'application/vnd.apple.pkpass',
    'Content-Disposition': `attachment; filename="tarjeta-${pass.cliente.negocio.slug}.pkpass"`,
    'Last-Modified': new Date(pass.ultima_actualizacion).toUTCString(),
    'Cache-Control': 'no-store',
  });
  res.send(buffer);
}

// Descarga inicial (botón "Agregar a Apple Wallet"). El serial es aleatorio
// y solo lo conoce el cliente, así que funciona como enlace privado.
router.get('/passes/:archivo', limiteWallet, async (req, res) => {
  const serial = req.params.archivo.replace(/\.pkpass$/, '');
  const pass = await passConCliente(serial);
  if (!pass || !pass.cliente.negocio.activo) return res.status(404).json({ error: 'Tarjeta no encontrada.' });
  await enviarPass(res, pass);
});

// 1. Registrar un dispositivo para recibir actualizaciones de un pass.
router.post('/v1/devices/:device/registrations/:passType/:serial', async (req, res) => {
  const { device, passType, serial } = req.params;
  const contexto = { operacion: 'apple.registrar', serial, device };
  if (passType !== env.apple.passTypeIdentifier) return res.sendStatus(404);
  const pass = await passConCliente(serial);
  if (!tokenValido(req, pass)) {
    log.warn('registro Apple con token inválido', contexto);
    return res.sendStatus(401);
  }
  const pushToken = req.body?.pushToken;
  if (!pushToken || typeof pushToken !== 'string') return res.sendStatus(400);

  const { data: previo, error } = await supabase
    .from('apple_device_registrations').select('id')
    .match({ device_library_identifier: device, pass_type_identifier: passType, serial_number: serial })
    .maybeSingle();
  if (error) throw errorDb(error, 'buscar registro Apple');

  const ctx = { ...contexto, cliente_id: pass.cliente_id, negocio_id: pass.cliente.negocio_id };
  if (previo) {
    const r = await supabase.from('apple_device_registrations').update({ push_token: pushToken }).eq('id', previo.id);
    if (r.error) throw errorDb(r.error, 'actualizar registro Apple');
    log.info('dispositivo Apple ya registrado; token actualizado', ctx);
    return res.sendStatus(200);
  }
  const r = await supabase.from('apple_device_registrations').insert({
    device_library_identifier: device, pass_type_identifier: passType, serial_number: serial, push_token: pushToken,
  });
  if (r.error?.code === '23505') return res.sendStatus(200); // registro concurrente
  if (r.error) throw errorDb(r.error, 'crear registro Apple');
  log.info('dispositivo Apple registrado', ctx);
  res.sendStatus(201);
});

// Des-registrar (el cliente borró el pass o desactivó las actualizaciones).
router.delete('/v1/devices/:device/registrations/:passType/:serial', async (req, res) => {
  const { device, passType, serial } = req.params;
  const pass = await passConCliente(serial);
  if (!tokenValido(req, pass)) return res.sendStatus(401);
  const { error } = await supabase.from('apple_device_registrations').delete()
    .match({ device_library_identifier: device, pass_type_identifier: passType, serial_number: serial });
  if (error) throw errorDb(error, 'borrar registro Apple');
  log.info('dispositivo Apple des-registrado', { operacion: 'apple.desregistrar', serial, device, cliente_id: pass.cliente_id });
  res.sendStatus(200);
});

// 3. Qué passes de este dispositivo cambiaron desde `passesUpdatedSince`.
// El "tag" es opaco para Apple: usamos el timestamp exacto de Postgres.
router.get('/v1/devices/:device/registrations/:passType', async (req, res) => {
  const { device, passType } = req.params;
  const { data: registros, error } = await supabase
    .from('apple_device_registrations').select('serial_number')
    .eq('device_library_identifier', device).eq('pass_type_identifier', passType);
  if (error) throw errorDb(error, 'listar registros Apple');
  if (!registros.length) return res.sendStatus(204);

  let consulta = supabase.from('wallet_passes').select('serial_number, ultima_actualizacion')
    .eq('plataforma', 'apple')
    .in('serial_number', registros.map((r) => r.serial_number))
    .order('ultima_actualizacion', { ascending: false });
  const desde = req.query.passesUpdatedSince;
  if (desde && !Number.isNaN(new Date(desde).getTime())) consulta = consulta.gt('ultima_actualizacion', desde);
  const { data: passes, error: e } = await consulta;
  if (e) throw errorDb(e, 'listar passes actualizados');
  if (!passes.length) return res.sendStatus(204);

  res.json({ lastUpdated: passes[0].ultima_actualizacion, serialNumbers: passes.map((p) => p.serial_number) });
});

// 4. Última versión de un pass. Soporta If-Modified-Since (304 si no cambió).
router.get('/v1/passes/:passType/:serial', async (req, res) => {
  const { passType, serial } = req.params;
  if (passType !== env.apple.passTypeIdentifier) return res.sendStatus(404);
  const pass = await passConCliente(serial);
  if (!tokenValido(req, pass)) return res.sendStatus(401);
  if (!pass.cliente.negocio.activo) return res.sendStatus(404);

  const desde = new Date(req.get('if-modified-since') || '');
  const modificado = Math.floor(new Date(pass.ultima_actualizacion).getTime() / 1000) * 1000; // HTTP: precisión de segundos
  if (!Number.isNaN(desde.getTime()) && modificado <= desde.getTime()) return res.sendStatus(304);
  await enviarPass(res, pass);
});

// Logs que el iPhone envía cuando algo falla en su lado (muy útil para depurar).
router.post('/v1/log', (req, res) => {
  const logs = Array.isArray(req.body?.logs) ? req.body.logs.slice(0, 50) : [];
  for (const mensaje of logs) log.warn('log de Apple Wallet', { operacion: 'apple.log', mensaje: String(mensaje).slice(0, 1000) });
  res.sendStatus(200);
});

module.exports = router;
