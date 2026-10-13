// Límites de peticiones por IP para las rutas públicas (fuerza bruta, spam).
const rateLimit = require('express-rate-limit');

function limite(minutos, maximo, mensaje) {
  return rateLimit({
    windowMs: minutos * 60 * 1000,
    limit: maximo,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: mensaje },
  });
}

module.exports = {
  // Generoso: en un local muchos clientes comparten el mismo Wi-Fi (misma IP).
  limiteInscripcion: limite(15, 60, 'Demasiadas inscripciones desde esta conexión. Intente en unos minutos.'),
  limiteConsulta: limite(15, 30, 'Demasiadas consultas. Intente en unos minutos.'),
  limiteLogin: limite(15, 10, 'Demasiados intentos de inicio de sesión. Espere 15 minutos.'),
  limiteWallet: limite(15, 60, 'Demasiadas solicitudes. Intente en unos minutos.'),
};
