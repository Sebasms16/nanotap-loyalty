// Variables de entorno de prueba: Supabase apunta a un puerto cerrado y los
// certificados de Apple / la cuenta de Google se generan al vuelo (autofirmados).
// Debe requerirse ANTES que cualquier módulo de src/.
const crypto = require('node:crypto');
const forge = require('node-forge');

function certificadoAutofirmado(nombre) {
  const llaves = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = llaves.publicKey;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 20 * 86400000); // vence en 20 días (prueba RNF-10)
  const atributos = [{ name: 'commonName', value: nombre }];
  cert.setSubject(atributos);
  cert.setIssuer(atributos);
  cert.sign(llaves.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), llave: forge.pki.privateKeyToPem(llaves.privateKey) };
}

const b64 = (texto) => Buffer.from(texto).toString('base64');

function configurar({ wallets = true } = {}) {
  Object.assign(process.env, {
    PORT: '0',
    BASE_URL: 'https://loyalty.test',
    NODE_ENV: 'test',
    SUPABASE_URL: 'http://127.0.0.1:9',
    SUPABASE_SERVICE_ROLE_KEY: 'clave-de-prueba',
    JWT_SECRET: 'secreto-de-prueba-con-mas-de-32-caracteres',
    OPERADOR_PASSWORD: 'operador-prueba',
  });
  if (!wallets) return;

  const firmante = certificadoAutofirmado('Pass Type ID de prueba');
  const wwdr = certificadoAutofirmado('WWDR de prueba');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(process.env, {
    APPLE_PASS_TYPE_IDENTIFIER: 'pass.cr.nanotap.prueba',
    APPLE_TEAM_IDENTIFIER: 'ABCDE12345',
    APPLE_WWDR_CERT_BASE64: b64(wwdr.cert),
    APPLE_SIGNER_CERT_BASE64: b64(firmante.cert),
    APPLE_SIGNER_KEY_BASE64: b64(firmante.llave),
    GOOGLE_WALLET_ISSUER_ID: '3388000000012345678',
    GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: b64(JSON.stringify({
      type: 'service_account',
      client_email: 'wallet@prueba.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    })),
  });
}

module.exports = { configurar };
