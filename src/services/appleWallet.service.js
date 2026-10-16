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

  const tiras = await Promise.all([1, 2, 3].map((escala) =>
    marca.tiraDelNegocio(negocio, sellos, { ancho: 375 * escala, alto: 123 * escala })));
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
      description: `Tarjeta de estampas ${negocio.nombre}`,
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
  pkpass.headerFields.push(estado
    ? {
      key: 'nivel',
      label: 'NIVEL',
      value: niveles.etiqueta(estado.nivel),
      textAlignment: 'PKTextAlignmentRight',
      ...(estado.nivel.clave === 'bronce' ? {} : { changeMessage: '¡Subió a nivel %@!' }),
    }
    : { key: 'estampas', label: 'ESTAMPAS', value: `${sellos}/${meta}` });
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
  pkpass.backFields.push(
    { key: 'cliente', label: 'Cliente', value: [cliente.nombre, cliente.primer_apellido].filter(Boolean).join(' ') },
    ...(estado ? [{ key: 'nivel_detalle', label: 'Nivel y temporada', value: niveles.resumen(estado) }] : []),
    ...(vigencia ? [{ key: 'vigencia', label: 'Vigencia de las estampas', value: vigencia }] : []),
    { key: 'canjeados', label: 'Premios canjeados', value: cliente.premios_canjeados },
    { key: 'reglas', label: 'Reglas del programa', value: reglasComoTexto(negocio) },
    { key: 'consulta', label: 'Consultar mis estampas', value: `${env.baseUrl}/${negocio.slug}/consulta` },
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
