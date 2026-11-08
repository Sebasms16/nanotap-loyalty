// Google Wallet: una LoyaltyClass por negocio y un LoyaltyObject por cliente.
//  - La clase lleva la marca (nombre, logo, color).
//  - El objeto lleva los datos del cliente (sellos, QR).
// Al actualizar el objeto (update), Google actualiza la tarjeta en el teléfono
// por su cuenta: no hace falta lógica de push propia (RF-07).
const jwt = require('jsonwebtoken');
const { walletobjects, auth } = require('@googleapis/walletobjects');
const env = require('../config/env');
const marca = require('./marca.service');
const niveles = require('./niveles.service');
const inactividad = require('./inactividad.service');
const puntosSvc = require('./puntos.service');
const cashback = require('./cashback.service');
const log = require('../utils/logger');
const { reglasComoTexto } = require('../utils/reglas');

const IDIOMA = 'es-419';
let api = null;

function cliente() {
  if (!env.google.habilitado) throw new Error('Google Wallet no está configurado');
  if (!api) {
    const googleAuth = new auth.GoogleAuth({
      credentials: env.google.serviceAccount,
      scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
    });
    api = walletobjects({ version: 'v1', auth: googleAuth });
  }
  return api;
}

const statusDe = (e) => e?.response?.status ?? e?.status ?? Number(e?.code);
const texto = (valor) => ({ defaultValue: { language: IDIOMA, value: valor } });

// Envuelve cada llamada a la API para dejarla en el log con contexto (RNF-07).
async function llamar(operacion, contexto, fn) {
  const inicio = Date.now();
  try {
    const r = await fn();
    log.info(`google ${operacion}`, { ...contexto, operacion: `google.${operacion}`, ms: Date.now() - inicio });
    return r;
  } catch (error) {
    const nivel = statusDe(error) === 409 || statusDe(error) === 404 ? 'info' : 'error';
    log[nivel](`google ${operacion} falló`, {
      ...contexto, operacion: `google.${operacion}`, status: statusDe(error), ms: Date.now() - inicio, error,
    });
    throw error;
  }
}

const idClase = (negocio) => `${env.google.issuerId}.negocio-${negocio.id}`;
const idObjeto = (clienteId) => `${env.google.issuerId}.cliente-${clienteId}`;
const sinNumeral = (hex) => String(hex || '').replace('#', '');

function urlLogo(negocio) {
  // Google recorta el logo en círculo: se sirve una versión con margen.
  if (negocio.logo_url) return `${env.baseUrl}/img/negocios/${negocio.id}/logo.png?v=${marca.versionLogo(negocio)}`;
  return `${env.baseUrl}/img/icono.png?fondo=${sinNumeral(negocio.color_primario)}&color=${sinNumeral(negocio.color_secundario)}&tam=660`;
}

// logoAncho: el logo es alargado. Además del logo en círculo (obligatorio), se
// manda la versión ancha (wideProgramLogo), que Google muestra en lugar del círculo.
function construirClase(negocio, { logoAncho = false } = {}) {
  const descripcionLogo = texto(`Logo de ${negocio.nombre}`);
  return {
    id: idClase(negocio),
    issuerName: negocio.nombre,
    programName: cashback.esCashback(negocio) ? 'Tarjeta de cashback' : puntosSvc.esPuntos(negocio) ? 'Tarjeta de puntos' : 'Tarjeta de estampas',
    programLogo: { sourceUri: { uri: urlLogo(negocio) }, contentDescription: descripcionLogo },
    ...(logoAncho && negocio.logo_url ? {
      wideProgramLogo: {
        sourceUri: { uri: `${env.baseUrl}/img/negocios/${negocio.id}/logo-ancho.png?v=${marca.versionLogo(negocio)}` },
        contentDescription: descripcionLogo,
      },
    } : {}),
    hexBackgroundColor: negocio.color_primario || '#1a1a2e',
    countryCode: 'CR',
    reviewStatus: 'UNDER_REVIEW',
    multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
  };
}

// Con programa de puntos: el saldo va en el campo de puntos que Google muestra
// grande, y la franja es una barra de avance hacia los premios.
function objetoConPuntos(cliente, negocio, estado, base) {
  const saldo = cliente.puntos || 0;
  const sig = puntosSvc.proximo(negocio, saldo);
  const catalogo = puntosSvc.catalogo(negocio);
  const enPuntos = { label: 'Puntos', balance: { int: saldo } };
  const tira = `${env.baseUrl}/img/negocios/${negocio.id}/estampas.png?puntos=${saldo}&v=${marca.versionTira(negocio)}`;
  return {
    ...base,
    loyaltyPoints: estado ? { label: 'Nivel', balance: { string: `${estado.nivel.emoji} ${estado.nivel.nombre}` } } : enPuntos,
    secondaryLoyaltyPoints: estado ? enPuntos : { label: 'Próximo premio', balance: { string: sig ? sig.premio.nombre : '—' } },
    heroImage: { sourceUri: { uri: tira }, contentDescription: texto(`${saldo} puntos`) },
    textModulesData: [
      ...(sig ? [sig.faltan === 0
        ? { id: 'premio', header: '¡Premio disponible!', body: `Ya le alcanza para: ${sig.premio.nombre}.` }
        : { id: 'premio', header: 'Faltan', body: `${puntosSvc.formatoPuntos(sig.faltan)} puntos para su próximo premio: ${sig.premio.nombre}.` }] : []),
      ...(catalogo.length ? [{
        id: 'catalogo', header: 'Premios',
        body: catalogo.map((p) => `${p.nombre}: ${puntosSvc.formatoPuntos(p.puntos)} puntos`).join('\n'),
      }] : []),
      ...(estado ? [{ id: 'nivel', header: 'Nivel y temporada', body: niveles.resumen(estado) }] : []),
      ...(estado?.premio ? [{ id: 'beneficio', header: 'Beneficio de su nivel', body: estado.premio }] : []),
      ...base.textModulesData,
    ],
  };
}

// Con cashback: el saldo en colones va en el campo grande; la franja es la foto del negocio
// con el porcentaje, igual para todos (por eso su URL no lleva el saldo).
function objetoConCashback(cliente, negocio, estado, base) {
  const saldo = cliente.puntos || 0;
  const min = cashback.minimo(negocio);
  const puede = cashback.puedeUsar(negocio, saldo);
  const enColones = { label: 'Saldo', balance: { string: cashback.formatoColones(saldo) } };
  const tira = `${env.baseUrl}/img/negocios/${negocio.id}/estampas.png?v=${marca.versionTira(negocio)}`;
  return {
    ...base,
    loyaltyPoints: estado ? { label: 'Nivel', balance: { string: `${estado.nivel.emoji} ${estado.nivel.nombre}` } } : enColones,
    secondaryLoyaltyPoints: estado ? enColones : { label: 'Cashback', balance: { string: cashback.regla(negocio) } },
    heroImage: { sourceUri: { uri: tira }, contentDescription: texto(`${cashback.regla(negocio)} de cashback`) },
    textModulesData: [
      puede
        ? { id: 'saldo', header: 'Puede usar su saldo', body: `Tiene ${cashback.formatoColones(saldo)} para pagar parte o el total de una compra.` }
        : min
          ? { id: 'saldo', header: 'Faltan', body: `${cashback.formatoColones(min - saldo)} de saldo para poder usarlo (desde ${cashback.formatoColones(min)}).` }
          : { id: 'saldo', header: 'Cashback', body: `Reciba el ${cashback.regla(negocio)} como saldo.` },
      ...(estado ? [{ id: 'nivel', header: 'Nivel y temporada', body: niveles.resumen(estado) }] : []),
      ...(estado?.premio ? [{ id: 'beneficio', header: 'Beneficio de su nivel', body: estado.premio }] : []),
      ...base.textModulesData,
    ],
  };
}

// estado: nivel del cliente (niveles.estadoDelCliente), null si el negocio no usa niveles.
function construirObjeto(cliente, negocio, estado = null) {
  if (puntosSvc.esPuntos(negocio) || cashback.esCashback(negocio)) {
    const conCashback = cashback.esCashback(negocio);
    const vigencia = inactividad.aviso(cliente, negocio);
    return (conCashback ? objetoConCashback : objetoConPuntos)(cliente, negocio, estado, {
      id: idObjeto(cliente.id),
      classId: idClase(negocio),
      state: 'ACTIVE',
      accountId: cliente.codigo_qr,
      accountName: [cliente.nombre, cliente.primer_apellido].filter(Boolean).join(' '),
      barcode: { type: 'QR_CODE', value: cliente.codigo_qr, alternateText: cliente.codigo_qr },
      textModulesData: [
        ...(vigencia ? [{ id: 'vigencia', header: conCashback ? 'Vigencia del saldo' : 'Vigencia de los puntos', body: vigencia }] : []),
        { id: 'canjeados', header: conCashback ? 'Veces que usó su saldo' : 'Premios canjeados', body: String(cliente.premios_canjeados) },
        { id: 'reglas', header: 'Reglas del programa', body: reglasComoTexto(negocio) },
      ],
      linksModuleData: {
        uris: [
          { id: 'consulta', uri: `${env.baseUrl}/${negocio.slug}/consulta`, description: conCashback ? 'Consultar mi saldo' : 'Consultar mis puntos' },
          { id: 'privacidad', uri: `${env.baseUrl}/${negocio.slug}/privacidad`, description: 'Aviso de privacidad' },
        ],
      },
    });
  }
  const meta = negocio.sellos_para_premio;
  const sellos = cliente.sellos_actuales;
  const disponible = sellos >= meta;
  const premio = niveles.premioActual(negocio, estado);
  const vigencia = inactividad.aviso(cliente, negocio);
  const estampas ={ label: 'Estampas', balance: { string: `${sellos} / ${meta}` } };
  // La imagen de estampas se genera en /img/negocios/... con el logo del negocio.
  // `v` cambia si cambia la marca, para que Google no use una versión vieja de su caché.
  const tira = `${env.baseUrl}/img/negocios/${negocio.id}/estampas.png`
    + `?llenos=${Math.min(sellos, meta)}&v=${marca.versionTira(negocio)}`;

  return {
    id: idObjeto(cliente.id),
    classId: idClase(negocio),
    state: 'ACTIVE',
    accountId: cliente.codigo_qr,
    accountName: [cliente.nombre, cliente.primer_apellido].filter(Boolean).join(' '),
    barcode: { type: 'QR_CODE', value: cliente.codigo_qr, alternateText: cliente.codigo_qr },
    // Con niveles, el nivel va en el campo principal y las estampas en el secundario.
    loyaltyPoints: estado
      ? { label: 'Nivel', balance: { string: `${estado.nivel.emoji} ${estado.nivel.nombre}` } }
      : estampas,
    secondaryLoyaltyPoints: estado ? estampas : { label: 'Premio', balance: { string: premio } },
    heroImage: { sourceUri: { uri: tira }, contentDescription: texto(`${sellos} de ${meta} estampas`) },
    textModulesData: [
      // Premio sorpresa pendiente: lo primero que se ve en el detalle.
      ...(cliente.sorpresa_pendiente
        ? [{ id: 'sorpresa', header: '🎁 ¡Ganó un premio sorpresa!', body: `${cliente.sorpresa_pendiente}. Pídalo en caja mostrando esta tarjeta.` }]
        : []),
      disponible
        ? { id: 'premio', header: '¡Premio disponible!', body: `Muestre esta tarjeta para canjear: ${premio}.` }
        : { id: 'premio', header: 'Faltan', body: `${meta - sellos} estampa${meta - sellos === 1 ? '' : 's'} para su premio: ${premio}.` },
      ...(estado ? [{ id: 'nivel', header: 'Nivel y temporada', body: niveles.resumen(estado) }] : []),
      ...(vigencia ? [{ id: 'vigencia', header: 'Vigencia de las estampas', body: vigencia }] : []),
      { id: 'canjeados', header: 'Premios canjeados', body: String(cliente.premios_canjeados) },
      { id: 'reglas', header: 'Reglas del programa', body: reglasComoTexto(negocio) },
    ],
    linksModuleData: {
      uris: [
        { id: 'consulta', uri: `${env.baseUrl}/${negocio.slug}/consulta`, description: 'Consultar mis estampas' },
        { id: 'privacidad', uri: `${env.baseUrl}/${negocio.slug}/privacidad`, description: 'Aviso de privacidad' },
      ],
    },
  };
}

// La clase se crea una vez y se actualiza solo si cambió la marca. La caché es
// por proceso (el backend sigue siendo stateless: perderla solo cuesta un patch).
const clasesSincronizadas = new Map();

async function asegurarClase(negocio) {
  const clase = construirClase(negocio, { logoAncho: await marca.logoEsAncho(negocio) });
  const huella = JSON.stringify(clase);
  if (clasesSincronizadas.get(clase.id) === huella) return;
  const contexto = { negocio_id: negocio.id };
  try {
    await llamar('loyaltyclass.insert', contexto, () => cliente().loyaltyclass.insert({ requestBody: clase }));
  } catch (error) {
    if (statusDe(error) !== 409) throw error;
    await llamar('loyaltyclass.update', contexto, () =>
      cliente().loyaltyclass.update({ resourceId: clase.id, requestBody: clase }));
  }
  clasesSincronizadas.set(clase.id, huella);
}

// Crea el objeto o, si ya existe, lo actualiza. Devuelve su id.
async function asegurarObjeto(clienteDb, negocio) {
  await asegurarClase(negocio);
  const objeto = construirObjeto(clienteDb, negocio, await niveles.estadoDelCliente(clienteDb, negocio));
  const contexto = { negocio_id: negocio.id, cliente_id: clienteDb.id };
  try {
    await llamar('loyaltyobject.insert', contexto, () => cliente().loyaltyobject.insert({ requestBody: objeto }));
  } catch (error) {
    if (statusDe(error) !== 409) throw error;
    await llamar('loyaltyobject.update', contexto, () =>
      cliente().loyaltyobject.update({ resourceId: objeto.id, requestBody: objeto }));
  }
  return objeto.id;
}

// RF-07: refleja los sellos actuales. Si el objeto no existiera (404), lo crea.
async function actualizarObjeto(clienteDb, negocio) {
  await asegurarClase(negocio);
  const objeto = construirObjeto(clienteDb, negocio, await niveles.estadoDelCliente(clienteDb, negocio));
  const contexto = { negocio_id: negocio.id, cliente_id: clienteDb.id };
  try {
    await llamar('loyaltyobject.update', contexto, () =>
      cliente().loyaltyobject.update({ resourceId: objeto.id, requestBody: objeto }));
  } catch (error) {
    if (statusDe(error) !== 404) throw error;
    await asegurarObjeto(clienteDb, negocio);
  }
}

// Ley 8968: al eliminar un cliente, la tarjeta queda inactiva y sin su nombre.
async function inactivarObjeto(objectId, contexto) {
  await llamar('loyaltyobject.patch', contexto, () =>
    cliente().loyaltyobject.patch({
      resourceId: objectId,
      requestBody: { state: 'INACTIVE', accountName: '—', textModulesData: [] },
    }));
}

// Link del botón "Guardar en Google Wallet": un JWT firmado con la cuenta de servicio
// que referencia el objeto ya creado por API.
function linkGuardar(objectId) {
  const sa = env.google.serviceAccount;
  const token = jwt.sign(
    {
      iss: sa.client_email,
      aud: 'google',
      typ: 'savetowallet',
      origins: [env.baseUrl],
      payload: { loyaltyObjects: [{ id: objectId }] },
    },
    sa.private_key,
    { algorithm: 'RS256' }
  );
  return `https://pay.google.com/gp/v/save/${token}`;
}

module.exports = {
  asegurarObjeto, actualizarObjeto, inactivarObjeto, linkGuardar, idObjeto, construirObjeto, construirClase,
};
