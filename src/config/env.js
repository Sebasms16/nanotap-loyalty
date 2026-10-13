// Carga y valida las variables de entorno una sola vez al arrancar.
// Los certificados y llaves llegan en base64 y se decodifican en memoria (RNF-01).
require('dotenv').config({ quiet: true });
const { X509Certificate } = require('node:crypto');

function requerida(nombre) {
  const valor = process.env[nombre];
  if (!valor || !valor.trim()) {
    throw new Error(`Falta la variable de entorno obligatoria ${nombre} (ver .env.example)`);
  }
  return valor.trim();
}

function opcional(nombre, porDefecto = '') {
  const valor = process.env[nombre];
  return valor && valor.trim() ? valor.trim() : porDefecto;
}

function desdeBase64(nombre) {
  const valor = opcional(nombre);
  return valor ? Buffer.from(valor, 'base64') : null;
}

// Apple entrega el WWDR como .cer (DER). passkit-generator necesita PEM,
// así que aceptamos cualquiera de los dos formatos.
function certificadoPem(buffer) {
  if (!buffer) return null;
  const texto = buffer.toString('utf8');
  if (texto.includes('-----BEGIN')) return texto;
  return new X509Certificate(buffer).toString();
}

const baseUrl = requerida('BASE_URL').replace(/\/+$/, '');
const jwtSecret = requerida('JWT_SECRET');
if (jwtSecret.length < 32) {
  throw new Error('JWT_SECRET debe tener al menos 32 caracteres');
}

const apple = {
  passTypeIdentifier: opcional('APPLE_PASS_TYPE_IDENTIFIER'),
  teamIdentifier: opcional('APPLE_TEAM_IDENTIFIER'),
  wwdr: certificadoPem(desdeBase64('APPLE_WWDR_CERT_BASE64')),
  signerCert: certificadoPem(desdeBase64('APPLE_SIGNER_CERT_BASE64')),
  signerKey: desdeBase64('APPLE_SIGNER_KEY_BASE64')?.toString('utf8') || null,
  signerKeyPassphrase: opcional('APPLE_SIGNER_KEY_PASSPHRASE') || undefined,
  apnsKey: desdeBase64('APPLE_APNS_KEY_BASE64')?.toString('utf8') || null,
  apnsKeyId: opcional('APPLE_APNS_KEY_ID'),
};
apple.habilitado = Boolean(
  apple.passTypeIdentifier && apple.teamIdentifier && apple.wwdr && apple.signerCert && apple.signerKey
);

let googleServiceAccount = null;
const googleJson = desdeBase64('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64');
if (googleJson) {
  try {
    googleServiceAccount = JSON.parse(googleJson.toString('utf8'));
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 no contiene un JSON válido');
  }
}
const google = {
  issuerId: opcional('GOOGLE_WALLET_ISSUER_ID'),
  serviceAccount: googleServiceAccount,
};
google.habilitado = Boolean(google.issuerId && google.serviceAccount);

module.exports = {
  port: Number(opcional('PORT', '3000')),
  baseUrl,
  produccion: opcional('NODE_ENV') === 'production',
  supabaseUrl: requerida('SUPABASE_URL'),
  supabaseServiceRoleKey: requerida('SUPABASE_SERVICE_ROLE_KEY'),
  jwtSecret,
  operadorPassword: requerida('OPERADOR_PASSWORD'),
  contactoPrivacidad: opcional('CONTACTO_PRIVACIDAD', 'soporte@nanotap.app'),
  apple,
  google,
};
