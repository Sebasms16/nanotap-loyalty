// Push silencioso a APNs para avisarle al iPhone que su pass cambió (RF-07).
//
// Implementado directo sobre HTTP/2 nativo de Node (node-apn está sin mantenimiento).
// Para Wallet el push lleva un payload vacío y el topic es el Pass Type ID;
// el iPhone responde pidiendo los passes actualizados a nuestro web service.
// Las tarjetas de Wallet siempre usan el APNs de producción.
//
// Autenticación:
//  - Por defecto, el certificado del Pass Type ID (el mismo que firma el pass).
//  - Si APPLE_APNS_KEY_BASE64 y APPLE_APNS_KEY_ID están definidas, token JWT (.p8).
const http2 = require('node:http2');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const supabase = require('../db/supabaseClient');
const log = require('../utils/logger');
const { errorDb } = require('../utils/errores');

const APNS_HOST = 'https://api.push.apple.com';
const usaToken = Boolean(env.apple.apnsKey && env.apple.apnsKeyId);
let sesion = null;
let tokenApns = null;

function conexion() {
  if (sesion && !sesion.closed && !sesion.destroyed) return sesion;
  const opciones = usaToken
    ? {}
    : { cert: env.apple.signerCert, key: env.apple.signerKey, passphrase: env.apple.signerKeyPassphrase };
  sesion = http2.connect(APNS_HOST, opciones);
  sesion.on('error', (error) => {
    log.error('conexión con APNs falló', { operacion: 'apns.conexion', error });
    sesion = null;
  });
  sesion.on('goaway', () => { sesion = null; });
  sesion.setTimeout(5 * 60 * 1000, () => sesion?.close());
  sesion.unref();
  return sesion;
}

// Apple pide renovar el token entre 20 y 60 minutos.
function bearer() {
  if (!tokenApns || Date.now() - tokenApns.en > 40 * 60 * 1000) {
    const valor = jwt.sign({ iss: env.apple.teamIdentifier }, env.apple.apnsKey, {
      algorithm: 'ES256',
      keyid: env.apple.apnsKeyId,
    });
    tokenApns = { valor, en: Date.now() };
  }
  return `bearer ${tokenApns.valor}`;
}

function enviar(pushToken) {
  return new Promise((resolve, reject) => {
    const cabeceras = {
      ':method': 'POST',
      ':path': `/3/device/${pushToken}`,
      'apns-topic': env.apple.passTypeIdentifier,
      'content-type': 'application/json',
    };
    if (usaToken) cabeceras.authorization = bearer();

    const req = conexion().request(cabeceras);
    let status = 0;
    let cuerpo = '';
    req.setEncoding('utf8');
    req.setTimeout(10000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (d) => { cuerpo += d; });
    req.on('end', () => {
      let razon = null;
      try { razon = cuerpo ? JSON.parse(cuerpo).reason : null; } catch { /* cuerpo no JSON */ }
      resolve({ status, razon });
    });
    req.on('error', reject);
    req.on('close', () => { if (!status) reject(new Error('APNs cerró la conexión sin responder')); });
    req.end('{}');
  });
}

// Notifica a todos los dispositivos registrados para un serial.
// Tokens inválidos se borran; cualquier otro error se lanza para reintentar.
async function notificarSerial(serialNumber, contexto = {}) {
  const { data: registros, error } = await supabase
    .from('apple_device_registrations')
    .select('id, push_token')
    .eq('serial_number', serialNumber)
    .eq('pass_type_identifier', env.apple.passTypeIdentifier);
  if (error) throw errorDb(error, 'leer registros Apple');
  if (!registros.length) return 0;

  const fallos = [];
  for (const registro of registros) {
    const ctx = { ...contexto, operacion: 'apns.push', serial: serialNumber, registro_id: registro.id };
    try {
      const { status, razon } = await enviar(registro.push_token);
      if (status === 200) {
        log.info('push APNs enviado', ctx);
      } else if (status === 410 || (status === 400 && razon === 'BadDeviceToken')) {
        log.info('push token inactivo; se elimina el registro', { ...ctx, status, razon });
        await supabase.from('apple_device_registrations').delete().eq('id', registro.id);
      } else {
        log.error('APNs rechazó el push', { ...ctx, status, razon });
        fallos.push(`${status} ${razon}`);
      }
    } catch (e) {
      log.error('error enviando push APNs', { ...ctx, error: e });
      fallos.push(e.message);
    }
  }
  if (fallos.length) throw new Error(`APNs: ${fallos.join('; ')}`);
  return registros.length;
}

module.exports = { notificarSerial };
