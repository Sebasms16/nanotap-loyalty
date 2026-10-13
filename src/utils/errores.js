// Error con código HTTP y mensaje listo para mostrar al usuario (en español).
class HttpError extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

// Supabase devuelve errores como objeto; los convertimos en Error para el logger.
function errorDb(error, operacion) {
  const e = new Error(`${operacion}: ${error.message}`);
  e.code = error.code;
  e.details = error.details;
  return e;
}

module.exports = { HttpError, errorDb };
