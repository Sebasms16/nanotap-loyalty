// Propaga los cambios de sellos a los wallets (RF-07) sin bloquear el negocio (RNF-03).
//
// sincronizarCliente() nunca lanza: si Apple o Google fallan, deja una fila en
// wallet_sync_pendientes y el worker la reintenta con backoff exponencial.
// Como cada intento lee el estado actual de la BD, reintentar es idempotente
// (aunque varias instancias del servidor procesen la misma fila).
const supabase = require('../db/supabaseClient');
const env = require('../config/env');
const googleWallet = require('./googleWallet.service');
const apnsPush = require('./apnsPush.service');
const log = require('../utils/logger');
const { errorDb } = require('../utils/errores');

const MAX_INTENTOS = 12;
const INTERVALO_WORKER_MS = 30 * 1000;

async function cargar(clienteId) {
  const { data, error } = await supabase
    .from('clientes')
    .select('*, negocio:negocios(*), wallet_passes(plataforma, serial_number)')
    .eq('id', clienteId)
    .maybeSingle();
  if (error) throw errorDb(error, 'cargar cliente para sync');
  return data;
}

async function sincronizarPlataforma(cliente, plataforma, contexto) {
  const pass = cliente.wallet_passes.find((p) => p.plataforma === plataforma);
  if (!pass) return; // el cliente no tiene tarjeta en esta plataforma
  if (plataforma === 'google' && env.google.habilitado) {
    await googleWallet.actualizarObjeto(cliente, cliente.negocio);
  }
  if (plataforma === 'apple' && env.apple.habilitado) {
    await apnsPush.notificarSerial(pass.serial_number, contexto);
  }
}

async function encolar(clienteId, plataforma, error) {
  const { error: errorCola } = await supabase.from('wallet_sync_pendientes').upsert(
    { cliente_id: clienteId, plataforma, ultimo_error: String(error?.message || error).slice(0, 500) },
    { onConflict: 'cliente_id,plataforma', ignoreDuplicates: true }
  );
  if (errorCola) log.error('no se pudo encolar el reintento', { cliente_id: clienteId, plataforma, error: errorDb(errorCola, 'encolar') });
}

async function sincronizarCliente(clienteId, { operacion = 'sync', plataformas = ['apple', 'google'] } = {}) {
  let cliente;
  try {
    cliente = await cargar(clienteId);
  } catch (error) {
    log.error('sync de wallets: no se pudo leer el cliente', { cliente_id: clienteId, operacion, error });
    for (const p of plataformas) await encolar(clienteId, p, error);
    return;
  }
  if (!cliente) return;
  const contexto = { negocio_id: cliente.negocio_id, cliente_id: clienteId, operacion };
  for (const plataforma of plataformas) {
    try {
      await sincronizarPlataforma(cliente, plataforma, contexto);
    } catch (error) {
      log.error(`sync ${plataforma} falló; se reintentará`, { ...contexto, plataforma, error });
      await encolar(clienteId, plataforma, error);
    }
  }
}

// ---------------------------------------------------------------------------
// Worker de reintentos
// ---------------------------------------------------------------------------
function proximoIntento(intentos) {
  const segundos = Math.min(30 * 2 ** intentos, 6 * 60 * 60); // 1 min, 2, 4... hasta 6 h
  return new Date(Date.now() + segundos * 1000).toISOString();
}

async function procesarPendientes() {
  const { data: filas, error } = await supabase
    .from('wallet_sync_pendientes')
    .select('*')
    .lte('proximo_intento', new Date().toISOString())
    .order('proximo_intento')
    .limit(50);
  if (error) throw errorDb(error, 'leer cola de wallets');

  for (const fila of filas) {
    const contexto = { cliente_id: fila.cliente_id, plataforma: fila.plataforma, intento: fila.intentos + 1, operacion: 'reintento' };
    try {
      const cliente = await cargar(fila.cliente_id);
      if (cliente) await sincronizarPlataforma(cliente, fila.plataforma, { ...contexto, negocio_id: cliente.negocio_id });
      await supabase.from('wallet_sync_pendientes').delete().eq('id', fila.id);
      log.info('reintento de wallet exitoso', contexto);
    } catch (e) {
      const intentos = fila.intentos + 1;
      if (intentos >= MAX_INTENTOS) {
        log.error('reintentos de wallet agotados; se descarta', { ...contexto, error: e });
        await supabase.from('wallet_sync_pendientes').delete().eq('id', fila.id);
      } else {
        log.warn('reintento de wallet falló', { ...contexto, error: e });
        await supabase.from('wallet_sync_pendientes').update({
          intentos, proximo_intento: proximoIntento(intentos), ultimo_error: e.message.slice(0, 500),
        }).eq('id', fila.id);
      }
    }
  }
}

function iniciarWorker() {
  let ocupado = false;
  setInterval(async () => {
    if (ocupado) return;
    ocupado = true;
    try {
      await procesarPendientes();
    } catch (error) {
      log.error('worker de wallets falló', { operacion: 'worker', error });
    } finally {
      ocupado = false;
    }
  }, INTERVALO_WORKER_MS).unref();
}

module.exports = { sincronizarCliente, iniciarWorker, procesarPendientes };
