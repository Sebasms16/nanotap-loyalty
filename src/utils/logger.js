// Logger estructurado (una línea JSON por evento) para RNF-07.
// Siempre pasar contexto: { negocio_id, cliente_id, operacion, ... }.
function escribir(nivel, mensaje, contexto = {}) {
  const linea = { t: new Date().toISOString(), nivel, mensaje, ...contexto };
  if (contexto.error instanceof Error) {
    linea.error = contexto.error.message;
    const detalle = contexto.error.response?.data?.error || contexto.error.details;
    if (detalle) linea.error_detalle = detalle;
    if (nivel === 'error') linea.stack = contexto.error.stack;
  }
  const salida = nivel === 'error' || nivel === 'warn' ? console.error : console.log;
  salida(JSON.stringify(linea));
}

module.exports = {
  info: (mensaje, contexto) => escribir('info', mensaje, contexto),
  warn: (mensaje, contexto) => escribir('warn', mensaje, contexto),
  error: (mensaje, contexto) => escribir('error', mensaje, contexto),
};
