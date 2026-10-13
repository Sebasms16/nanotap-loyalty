const crypto = require('node:crypto');
const QRCode = require('qrcode');

// Código que va dentro del QR de la tarjeta: PREFIJO-AÑO-8HEX (ej. "POD-2026-D5471AC9").
// El prefijo sale del slug del negocio para que el staff lo reconozca a simple vista.
// 32 bits aleatorios: la unicidad la garantiza la restricción unique de la BD
// (si choca, quien inserta reintenta con otro código).
function generarCodigo(slug) {
  const prefijo = (String(slug).replace(/[^a-z]/gi, '').slice(0, 3) || 'NAN').toUpperCase().padEnd(3, 'X');
  const aleatorio = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefijo}-${new Date().getFullYear()}-${aleatorio}`;
}

// Imagen del QR como data URL, para mostrarla en pantalla tras la inscripción.
function imagenDataUrl(codigo) {
  return QRCode.toDataURL(codigo, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
}

module.exports = { generarCodigo, imagenDataUrl };
