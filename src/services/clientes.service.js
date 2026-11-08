// Consultas y operaciones de clientes compartidas entre rutas.
const crypto = require('node:crypto');
const supabase = require('../db/supabaseClient');
const env = require('../config/env');
const qrcode = require('./qrcode.service');
const googleWallet = require('./googleWallet.service');
const log = require('../utils/logger');
const { reglasDelNegocio } = require('../utils/reglas');
const niveles = require('./niveles.service');
const puntos = require('./puntos.service');
const cashback = require('./cashback.service');
const correo = require('./correo.service');
const v = require('../utils/validacion');
const { HttpError, errorDb } = require('../utils/errores');

const CAMPOS_PUBLICOS_NEGOCIO = 'id, nombre, slug, logo_url, color_primario, color_secundario, sellos_para_premio, descripcion_premio, reglas, activo, '
  + 'niveles_activos, niveles, temporada_meses, temporada_inicio, inactividad_meses, '
  + 'tipo_programa, colones_por_punto, premios_puntos, puntos_factura_obligatoria, cashback_porcentaje, cashback_minimo, '
  + 'sorpresas_activas, sorpresas_premios';

async function negocioActivoPorSlug(slug) {
  const { data, error } = await supabase
    .from('negocios').select(CAMPOS_PUBLICOS_NEGOCIO).eq('slug', String(slug).toLowerCase()).maybeSingle();
  if (error) throw errorDb(error, 'buscar negocio');
  if (!data || !data.activo) throw new HttpError(404, 'Este programa de lealtad no existe o no está disponible.');
  return data;
}

function negocioPublico(n) {
  return {
    nombre: n.nombre, slug: n.slug, logo_url: n.logo_url,
    color_primario: n.color_primario, color_secundario: n.color_secundario,
    sellos_para_premio: n.sellos_para_premio,
    // Con niveles, quien se inscribe empieza en Bronce: ve el premio de ese nivel.
    descripcion_premio: niveles.activos(n) ? niveles.configuracion(n)[0].premio : n.descripcion_premio,
    niveles_activos: niveles.activos(n),
    reglas: reglasDelNegocio(n),
    tipo_programa: n.tipo_programa || 'estampas',
    puntos: puntos.paraMostrar(n, 0), // regla y catálogo; null si no usa puntos
    cashback: cashback.paraMostrar(n, 0), // % y saldo mínimo; null si no usa cashback
  };
}

// Busca por id (uuid) o por el código del QR, que es lo que lee el escáner del staff.
async function clienteConNegocio(idOCodigo) {
  const consulta = supabase.from('clientes').select('*, negocio:negocios(*)');
  const { data, error } = v.esUuid(idOCodigo)
    ? await consulta.eq('id', idOCodigo).maybeSingle()
    : await consulta.eq('codigo_qr', String(idOCodigo).trim().toUpperCase()).maybeSingle();
  if (error) throw errorDb(error, 'buscar cliente');
  return data;
}

// RF-04: el staff solo ve clientes de su negocio.
async function clienteDelStaff(idOCodigo, staff) {
  const cliente = await clienteConNegocio(idOCodigo);
  if (!cliente) throw new HttpError(404, 'No se encontró ningún cliente con ese código.');
  if (cliente.negocio_id !== staff.negocio_id) throw new HttpError(403, 'Este cliente pertenece a otro negocio.');
  return cliente;
}

// El pass de Apple se crea al inscribirse para poder mostrar el botón con su
// serial; el iPhone lo descarga cuando el cliente toca "Agregar a Apple Wallet".
async function asegurarPassApple(clienteId) {
  const { data: existente, error } = await supabase
    .from('wallet_passes').select('*').eq('cliente_id', clienteId).eq('plataforma', 'apple').maybeSingle();
  if (error) throw errorDb(error, 'buscar pass Apple');
  if (existente) return existente;
  const { data, error: errorInsert } = await supabase
    .from('wallet_passes')
    .upsert(
      {
        cliente_id: clienteId,
        plataforma: 'apple',
        serial_number: crypto.randomUUID(),
        auth_token: crypto.randomBytes(24).toString('hex'),
      },
      { onConflict: 'cliente_id,plataforma', ignoreDuplicates: true }
    )
    .select()
    .maybeSingle();
  if (errorInsert) throw errorDb(errorInsert, 'crear pass Apple');
  return data || asegurarPassApple(clienteId); // si otra request lo creó primero
}

// Lo que ve el cliente tras inscribirse (o al volver a inscribirse con su teléfono).
async function tarjetaParaCliente(cliente, negocio, existente) {
  let apple = null;
  if (env.apple.habilitado) {
    const pass = await asegurarPassApple(cliente.id);
    apple = `/api/wallet/apple/passes/${pass.serial_number}.pkpass`;
  }
  return {
    existente,
    cliente: {
      id: cliente.id,
      nombre: cliente.nombre,
      codigo_qr: cliente.codigo_qr,
      sellos_actuales: cliente.sellos_actuales,
      puntos: cliente.puntos || 0,
      premios_canjeados: cliente.premios_canjeados,
    },
    negocio: negocioPublico(negocio),
    wallets: { apple, google: env.google.habilitado },
    qr: await qrcode.imagenDataUrl(cliente.codigo_qr),
  };
}

// ---------------------------------------------------------------------------
// Teléfono ya inscrito: la tarjeta NO se muestra en la página, porque cualquiera que
// sepa el número podría verla y usarla (y con puntos o cashback, gastar el saldo).
// Se envía un enlace al correo con que el cliente se inscribió; abre la tarjeta 24 horas.
// ---------------------------------------------------------------------------
const HORAS_ENLACE = 24;
const MINUTOS_ENTRE_CORREOS = 2;
const CORREOS_POR_DIA = 5;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function enviarEnlaceTarjeta(cliente, negocio) {
  const contexto = { negocio_id: negocio.id, cliente_id: cliente.id, operacion: 'enlace_tarjeta' };
  const respuesta = (enviado, motivo = null) => ({
    existente: true,
    verificacion: { enviado, motivo, correo: enviado ? correo.ocultarCorreo(cliente.correo) : null, horas: HORAS_ENLACE },
  });
  if (!env.correo.habilitado) {
    log.warn('teléfono ya inscrito, pero el envío de correos no está configurado', contexto);
    return respuesta(false, 'sin_correo');
  }
  // Para no llenarle el buzón a nadie: uno cada pocos minutos y unos pocos al día.
  const { data: recientes, error } = await supabase
    .from('enlaces_tarjeta').select('creado_en')
    .eq('cliente_id', cliente.id).gte('creado_en', new Date(Date.now() - 86400000).toISOString());
  if (error) throw errorDb(error, 'leer enlaces de tarjeta');
  const ultimo = Math.max(0, ...recientes.map((r) => Date.parse(r.creado_en)));
  if (Date.now() - ultimo < MINUTOS_ENTRE_CORREOS * 60000 || recientes.length >= CORREOS_POR_DIA) {
    log.info('ya se envió un enlace hace poco; no se repite', contexto);
    return respuesta(true);
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const { data: fila, error: errorInsert } = await supabase.from('enlaces_tarjeta').insert({
    cliente_id: cliente.id, token_hash: hashToken(token), expira_en: new Date(Date.now() + HORAS_ENLACE * 3600000).toISOString(),
  }).select('id').single();
  if (errorInsert) throw errorDb(errorInsert, 'crear enlace de tarjeta');
  // En el fragmento (#), que el navegador no envía al servidor: el token no queda en ningún registro.
  const enlace = `${env.baseUrl}/${negocio.slug}/inscripcion#t=${token}`;
  const enviado = await correo.enviar({
    para: cliente.correo, ...correo.correoEnlaceTarjeta({ nombre: cliente.nombre, negocio, enlace, horas: HORAS_ENLACE }),
  }, contexto);
  if (!enviado) {
    // Que no cuente para el límite: el cliente puede reintentar enseguida.
    await supabase.from('enlaces_tarjeta').delete().eq('id', fila.id);
    return respuesta(false, 'fallo');
  }
  log.info('enlace a la tarjeta enviado por correo', contexto);
  return respuesta(true);
}

// La tarjeta que abre el enlace del correo (el mismo contenido que al inscribirse).
async function tarjetaPorEnlace(slug, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new HttpError(400, 'Este enlace no es válido. Escriba sus datos de nuevo para recibir otro.');
  }
  const negocio = await negocioActivoPorSlug(slug);
  const { data, error } = await supabase
    .from('enlaces_tarjeta').select('expira_en, cliente:clientes(*)').eq('token_hash', hashToken(token)).maybeSingle();
  if (error) throw errorDb(error, 'buscar enlace de tarjeta');
  if (!data?.cliente || data.cliente.negocio_id !== negocio.id) {
    throw new HttpError(404, 'Este enlace no es válido. Escriba sus datos de nuevo para recibir otro.');
  }
  if (Date.parse(data.expira_en) < Date.now()) {
    throw new HttpError(410, 'Este enlace ya venció. Escriba sus datos de nuevo para recibir otro.');
  }
  log.info('tarjeta abierta desde el enlace del correo', { negocio_id: negocio.id, cliente_id: data.cliente.id, operacion: 'enlace_tarjeta' });
  return tarjetaParaCliente(data.cliente, negocio, true);
}

// RF-02. Si el teléfono ya existe en este negocio, no se duplica ni se muestra la tarjeta:
// se envía el enlace a su correo (enviarEnlaceTarjeta).
async function inscribir(negocio, cuerpo) {
  if (cuerpo.acepto_terminos !== true) {
    throw new HttpError(400, 'Debe aceptar los términos y el tratamiento de sus datos para continuar.');
  }
  const datos = {
    negocio_id: negocio.id,
    nombre: v.texto(cuerpo.nombre, 'nombre', { requerido: true }),
    primer_apellido: v.texto(cuerpo.primer_apellido, 'primer apellido', { requerido: true }),
    segundo_apellido: v.texto(cuerpo.segundo_apellido, 'segundo apellido'),
    telefono: v.telefono(cuerpo.telefono),
    correo: v.correo(cuerpo.correo),
    fecha_nacimiento: v.fecha(cuerpo.fecha_nacimiento, 'fecha de nacimiento'),
    identificacion: v.texto(cuerpo.identificacion, 'identificación', { max: 30 }),
    acepto_terminos: true,
    acepto_terminos_en: new Date().toISOString(),
  };
  const contexto = { negocio_id: negocio.id, operacion: 'inscripcion' };

  const buscarExistente = async () => {
    const { data, error } = await supabase
      .from('clientes').select('*').eq('negocio_id', negocio.id).eq('telefono', datos.telefono).maybeSingle();
    if (error) throw errorDb(error, 'buscar cliente por teléfono');
    return data;
  };

  const previo = await buscarExistente();
  if (previo) {
    log.info('inscripción con teléfono existente; se envía el enlace al correo', { ...contexto, cliente_id: previo.id });
    return enviarEnlaceTarjeta(previo, negocio);
  }

  for (let intento = 0; intento < 3; intento++) {
    const { data, error } = await supabase
      .from('clientes').insert({ ...datos, codigo_qr: qrcode.generarCodigo(negocio.slug) }).select().single();
    if (!error) {
      log.info('cliente inscrito', { ...contexto, cliente_id: data.id });
      return tarjetaParaCliente(data, negocio, false);
    }
    if (error.code !== '23505') throw errorDb(error, 'insertar cliente');
    // Violación de unicidad: o chocó el código QR (reintentar) o el mismo
    // teléfono se inscribió en paralelo (devolver ese cliente).
    const carrera = await buscarExistente();
    if (carrera) return enviarEnlaceTarjeta(carrera, negocio);
  }
  throw new Error('no se pudo generar un código QR único');
}

// RNF-02 / sección 12: eliminación completa de los datos de un cliente (Ley 8968).
async function eliminarCliente(clienteId) {
  const { data: passes, error } = await supabase
    .from('wallet_passes').select('plataforma, serial_number').eq('cliente_id', clienteId);
  if (error) throw errorDb(error, 'leer passes del cliente');
  const contexto = { cliente_id: clienteId, operacion: 'eliminar_cliente' };

  for (const pass of passes) {
    if (pass.plataforma === 'google' && env.google.habilitado) {
      // Best effort: si falla, igual se borran los datos en nuestra BD.
      await googleWallet.inactivarObjeto(pass.serial_number, contexto).catch(() => {});
    }
    if (pass.plataforma === 'apple') {
      const { error: e } = await supabase
        .from('apple_device_registrations').delete().eq('serial_number', pass.serial_number);
      if (e) throw errorDb(e, 'borrar registros Apple');
    }
  }
  // on delete cascade borra eventos, passes y reintentos pendientes.
  const { data, error: errorDelete } = await supabase.from('clientes').delete().eq('id', clienteId).select('id');
  if (errorDelete) throw errorDb(errorDelete, 'eliminar cliente');
  if (!data.length) throw new HttpError(404, 'Cliente no encontrado.');
  log.info('cliente eliminado a solicitud (Ley 8968)', contexto);
}

module.exports = {
  negocioActivoPorSlug, negocioPublico, clienteConNegocio, clienteDelStaff, inscribir, tarjetaPorEnlace, eliminarCliente,
};
