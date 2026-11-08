// Apple Wallet: genera el .pkpass firmado (storeCard) con passkit-generator.
//
// Cómo encaja con el protocolo de Apple (ver wallet.apple.routes.js):
//  1. El pass lleva `webServiceURL` + `authenticationToken`. Al agregarlo, el
//     iPhone se registra en nuestro web service y nos manda su push token.
//  2. Cuando cambian los sellos, marcamos el pass como modificado
//     (wallet_passes.ultima_actualizacion) y mandamos un push vacío (apnsPush).
//  3. El iPhone pregunta qué passes cambiaron y descarga la versión nueva,
//     que se genera aquí al vuelo a partir del estado actual en la BD.
const { X509Certificate } = require('node:crypto');
const { PKPass } = require('passkit-generator');
const env = require('../config/env');
const imagen = require('./imagen.service');
const estampas = require('./estampas.service');
const marca = require('./marca.service');
const niveles = require('./niveles.service');
const inactividad = require('./inactividad.service');
const puntos = require('./puntos.service');
const cashback = require('./cashback.service');
const sorpresas = require('./sorpresas.service');
const log = require('../utils/logger');
const { reglasComoTexto } = require('../utils/reglas');

function rgb(hex) {
  const [r, g, b] = imagen.hexARgb(hex);
  return `rgb(${r}, ${g}, ${b})`;
}

// Diseño minimalista: arriba logo + nombre del negocio y el contador; al centro
// la zona de estampas (strip); abajo el premio, cuántas faltan y el QR.
// Los datos del cliente van al reverso.
async function generarPass({ cliente, negocio, pass }) {
  const contexto = { negocio_id: negocio.id, cliente_id: cliente.id, operacion: 'apple.generarPass' };
  const meta = negocio.sellos_para_premio;
  const sellos = cliente.sellos_actuales;
  const faltan = Math.max(0, meta - sellos);
  const fondo = negocio.color_primario || '#1a1a2e';
  const frente = negocio.color_secundario || '#ffffff';
  const logo = await marca.cargarImagen(negocio.logo_url, contexto);
  const estado = await niveles.estadoDelCliente(cliente, negocio);
  const premio = niveles.premioActual(negocio, estado);
  const vigencia = inactividad.aviso(cliente, negocio);
  const conPuntos = puntos.esPuntos(negocio);
  const conCashback = cashback.esCashback(negocio);
  const saldo = cliente.puntos || 0;
  // Cómo se llama lo que junta el cliente, para los textos.
  const queJunta = conCashback ? 'saldo' : conPuntos ? 'puntos' : 'estampas';

  // Con puntos o cashback, la franja depende del saldo; con estampas, de las estampas.
  const tiras = await Promise.all([1, 2, 3].map((escala) =>
    marca.tiraDelNegocio(negocio, conPuntos || conCashback ? saldo : sellos, { ancho: 375 * escala, alto: 123 * escala })));
  const archivos = {
    'strip.png': tiras[0],
    'strip@2x.png': tiras[1],
    'strip@3x.png': tiras[2],
  };
  for (const [sufijo, escala] of [['', 1], ['@2x', 2], ['@3x', 3]]) {
    // icon.png es el que aparece en las notificaciones de la pantalla bloqueada.
    archivos[`icon${sufijo}.png`] = logo
      ? await estampas.iconoDesdeLogo(logo, 29 * escala, fondo)
      : imagen.icono({ tam: 29 * escala, fondo, color: frente });
    if (logo) archivos[`logo${sufijo}.png`] = await estampas.logoEncabezado(logo, escala);
  }

  const pkpass = new PKPass(
    archivos,
    {
      wwdr: env.apple.wwdr,
      signerCert: env.apple.signerCert,
      signerKey: env.apple.signerKey,
      signerKeyPassphrase: env.apple.signerKeyPassphrase,
    },
    {
      formatVersion: 1,
      passTypeIdentifier: env.apple.passTypeIdentifier,
      teamIdentifier: env.apple.teamIdentifier,
      serialNumber: pass.serial_number,
      authenticationToken: pass.auth_token,
      webServiceURL: `${env.baseUrl}/api/wallet/apple`,
      organizationName: negocio.nombre,
      description: `Tarjeta de ${conCashback ? 'cashback' : conPuntos ? 'puntos' : 'estampas'} ${negocio.nombre}`,
      // Sin logoText si el logo ya trae el nombre (lo indica el negocio, o el logo es
      // alargado): así el logo usa todo el ancho en vez de compartirlo con el nombre.
      ...(negocio.ocultar_nombre || await marca.logoEsAncho(negocio) ? {} : { logoText: negocio.nombre }),
      backgroundColor: rgb(fondo),
      foregroundColor: rgb(frente),
      labelColor: rgb(frente),
      sharingProhibited: true,
    }
  );

  pkpass.type = 'storeCard';
  // Arriba a la derecha: el nivel si el negocio usa niveles; si no, el contador.
  // changeMessage solo al subir: volver a Bronce al cambiar de temporada no avisa.
  const campoNivel = estado && {
    key: 'nivel',
    label: 'NIVEL',
    value: niveles.etiqueta(estado.nivel),
    textAlignment: 'PKTextAlignmentRight',
    ...(estado.nivel.clave === 'bronce' ? {} : { changeMessage: '¡Subió a nivel %@!' }),
  };
  const campoSaldo = { key: 'puntos', label: 'PUNTOS', value: saldo, numberStyle: 'PKNumberStyleDecimal' };
  if (conCashback) {
    // Saldo en colones arriba (o abajo, si arriba va el nivel), el % y, si hay mínimo, cuánto falta para usarlo.
    const enColones = {
      key: 'saldo', label: 'SALDO', value: cashback.formatoColones(saldo), changeMessage: 'Su saldo de cashback ahora es %@',
    };
    const min = cashback.minimo(negocio);
    const puede = cashback.puedeUsar(negocio, saldo);
    pkpass.headerFields.push(campoNivel || { ...enColones, textAlignment: 'PKTextAlignmentRight' });
    pkpass.secondaryFields.push(
      ...(campoNivel ? [enColones] : []),
      { key: 'cashback', label: 'CASHBACK', value: cashback.regla(negocio) },
      ...(min ? [{
        key: 'faltan',
        label: puede ? 'PUEDE USARLO' : 'FALTAN',
        value: puede ? '¡Listo!' : cashback.formatoColones(min - saldo),
        textAlignment: 'PKTextAlignmentRight',
        ...(puede ? { changeMessage: '¡Ya puede usar su saldo de cashback!' } : {}),
      }] : [])
    );
  } else if (conPuntos) {
    // Saldo arriba (o abajo, si arriba va el nivel), el próximo premio y cuánto falta.
    const sig = puntos.proximo(negocio, saldo);
    pkpass.headerFields.push(campoNivel || { ...campoSaldo, textAlignment: 'PKTextAlignmentRight' });
    pkpass.secondaryFields.push(
      ...(campoNivel ? [campoSaldo] : []),
      { key: 'premio', label: sig?.faltan === 0 ? 'PUEDE CANJEAR' : 'PRÓXIMO PREMIO', value: sig ? sig.premio.nombre : '—' },
      {
        key: 'faltan',
        label: 'FALTAN',
        value: !sig ? '—' : sig.faltan === 0 ? '¡Listo!' : sig.faltan,
        textAlignment: 'PKTextAlignmentRight',
        changeMessage: sig?.faltan === 0 ? '¡Ya le alcanza para un premio!' : 'Le faltan %@ puntos para su próximo premio',
      }
    );
  } else {
    pkpass.headerFields.push(campoNivel || { key: 'estampas', label: 'ESTAMPAS', value: `${sellos}/${meta}` });
    pkpass.secondaryFields.push(
      { key: 'premio', label: 'PREMIO', value: premio },
      {
        key: 'faltan',
        label: 'FALTAN',
        value: faltan === 0 ? '¡Listo!' : faltan,
        textAlignment: 'PKTextAlignmentRight',
        // changeMessage hace que el iPhone muestre una notificación al cambiar el valor.
        changeMessage: faltan === 0 ? '¡Su premio está listo para canjear!' : 'Le faltan %@ estampas para su premio',
      }
    );
    // Premio sorpresa pendiente: visible al frente, junto al premio.
    if (cliente.sorpresa_pendiente) {
      pkpass.auxiliaryFields.push({ key: 'sorpresa', label: '🎁 PREMIO SORPRESA', value: cliente.sorpresa_pendiente });
    }
  }
  const catalogo = conPuntos && puntos.catalogo(negocio);
  pkpass.backFields.push(
    { key: 'cliente', label: 'Cliente', value: [cliente.nombre, cliente.primer_apellido].filter(Boolean).join(' ') },
    ...(catalogo?.length ? [{
      key: 'catalogo',
      label: 'Premios',
      value: catalogo.map((p) => `• ${p.nombre}: ${puntos.formatoPuntos(p.puntos)} puntos`).join('\n'),
    }] : []),
    // El aviso al ganar sale de aquí: el campo existe siempre que el negocio tenga sorpresas,
    // así el iPhone ve el cambio de valor. Sin changeMessage al entregarlo (no avisa nada).
    ...(sorpresas.activas(negocio) || cliente.sorpresa_pendiente ? [{
      key: 'sorpresa_detalle',
      label: 'Premio sorpresa (pídalo en caja)',
      value: cliente.sorpresa_pendiente || 'Ninguno por ahora',
      ...(cliente.sorpresa_pendiente ? { changeMessage: '🎁 ¡Ganó un premio sorpresa: %@! Pídalo en caja.' } : {}),
    }] : []),
    ...(estado ? [{ key: 'nivel_detalle', label: 'Nivel y temporada', value: niveles.resumen(estado) }] : []),
    ...((conPuntos || conCashback) && estado?.premio ? [{ key: 'beneficio', label: 'Beneficio de su nivel', value: estado.premio }] : []),
    ...(vigencia ? [{ key: 'vigencia', label: `Vigencia ${{ saldo: 'del saldo', puntos: 'de los puntos', estampas: 'de las estampas' }[queJunta]}`, value: vigencia }] : []),
    { key: 'canjeados', label: conCashback ? 'Veces que usó su saldo' : 'Premios canjeados', value: cliente.premios_canjeados },
    { key: 'reglas', label: 'Reglas del programa', value: reglasComoTexto(negocio) },
    { key: 'consulta', label: conCashback ? 'Consultar mi saldo' : `Consultar mis ${queJunta}`, value: `${env.baseUrl}/${negocio.slug}/consulta` },
    { key: 'privacidad', label: 'Privacidad', value: `${env.baseUrl}/${negocio.slug}/privacidad` },
    { key: 'codigo', label: 'Código', value: cliente.codigo_qr }
  );
  pkpass.setBarcodes({
    message: cliente.codigo_qr,
    format: 'PKBarcodeFormatQR',
    messageEncoding: 'iso-8859-1',
    altText: cliente.codigo_qr,
  });

  const buffer = pkpass.getAsBuffer();
  log.info('pass Apple generado', { ...contexto, serial: pass.serial_number, bytes: buffer.length });
  return buffer;
}

// RNF-10: un certificado vencido rompe en silencio todas las tarjetas Apple.
function estadoCertificados() {
  if (!env.apple.habilitado) return [];
  return [
    ['Pass Type ID (firma y push)', env.apple.signerCert],
    ['Apple WWDR (intermedio)', env.apple.wwdr],
  ].map(([nombre, pem]) => {
    const vence = new Date(new X509Certificate(pem).validTo);
    return { nombre, vence: vence.toISOString(), dias: Math.floor((vence - Date.now()) / 86400000) };
  });
}

function revisarCertificados() {
  for (const cert of estadoCertificados()) {
    const contexto = { operacion: 'apple.certificados', certificado: cert.nombre, vence: cert.vence, dias: cert.dias };
    if (cert.dias < 0) log.error('CERTIFICADO DE APPLE VENCIDO: las tarjetas Apple ya no se actualizan', contexto);
    else if (cert.dias < 30) log.warn(`El certificado de Apple vence en ${cert.dias} días: renovarlo ya`, contexto);
    else log.info('certificado de Apple vigente', contexto);
  }
}

function iniciarRevisionCertificados() {
  if (!env.apple.habilitado) return;
  revisarCertificados();
  setInterval(revisarCertificados, 24 * 60 * 60 * 1000).unref();
}

module.exports = { generarPass, estadoCertificados, iniciarRevisionCertificados };
