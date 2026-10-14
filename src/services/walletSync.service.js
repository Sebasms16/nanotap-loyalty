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
const niveles = require('./niveles.service');
const log = require('../utils/logger');
const { errorDb } = require('../utils/errores');

const MAX_INTENTOS = 12;
const INTERVALO_WORKER_MS = 30 * 1000;
const INTERVALO_TEMPORADAS_MS = 10 * 60 * 1000;

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

// ---------------------------------------------------------------------------
// Cambio de temporada: el nivel se calcula al vuelo, pero las tarjetas que ya
// están en los teléfonos hay que refrescarlas para que muestren Bronce.
// ---------------------------------------------------------------------------
async function revisarTemporadas(ahora = new Date()) {
  const { data, error } = await supabase
    .from('negocios')
    .select('id, temporada_meses, temporada_inicio, temporada_sincronizada')
    .eq('niveles_activos', true);
  if (error) throw errorDb(error, 'leer temporadas');

  for (const negocio of data) {
    const { clave } = niveles.temporadaActual(negocio, ahora);
    if (clave === negocio.temporada_sincronizada) continue;
    const contexto = { negocio_id: negocio.id, operacion: 'temporada', temporada: clave };
    const { data: enCola, error: errorCola } = await supabase.rpc('encolar_sync_negocio', { p_negocio_id: negocio.id });
    if (errorCola) {
      log.error('no se pudieron refrescar las tarjetas por cambio de temporada', { ...contexto, error: errorDb(errorCola, 'encolar') });
      continue; // se reintenta en la próxima revisión
    }
    const { error: errorMarca } = await supabase.from('negocios').update({ temporada_sincronizada: clave }).eq('id', negocio.id);
    if (errorMarca) log.error('no se pudo marcar la temporada', { ...contexto, error: errorDb(errorMarca, 'marcar temporada') });
    log.info('temporada nueva: tarjetas en cola', { ...contexto, tarjetas_en_cola: enCola });
  }
}

function cadaCierto(intervalo, nombre, tarea) {
  let ocupado = false;
  const correr = async () => {
    if (ocupado) return;
    ocupado = true;
    try {
      await tarea();
    } catch (error) {
      log.error(`${nombre} falló`, { operacion: 'worker', error });
    } finally {
      ocupado = false;
    }
  };
  setInterval(correr, intervalo).unref();
  return correr;
}

function iniciarWorker() {
  cadaCierto(INTERVALO_TEMPORADAS_MS, 'revisión de temporadas', revisarTemporadas)();
  cadaCierto(INTERVALO_WORKER_MS, 'worker de wallets', procesarPendientes);
}

module.exports = { sincronizarCliente, iniciarWorker, procesarPendientes, revisarTemporadas };
