// /api/wallet/google — crea (o actualiza) la clase y el objeto de lealtad y
// devuelve el link firmado del botón "Guardar en Google Wallet" (RF-03).
const express = require('express');
const supabase = require('../db/supabaseClient');
const env = require('../config/env');
const googleWallet = require('../services/googleWallet.service');
const clientes = require('../services/clientes.service');
const log = require('../utils/logger');
const v = require('../utils/validacion');
const { HttpError, errorDb } = require('../utils/errores');
const { limiteWallet } = require('../middlewares/limites.middleware');

const router = express.Router();

// El id del cliente (uuid aleatorio) solo lo recibe el propio cliente al inscribirse.
router.post('/clientes/:id', limiteWallet, async (req, res) => {
  if (!env.google.habilitado) throw new HttpError(404, 'Google Wallet no está configurado.');
  if (!v.esUuid(req.params.id)) throw new HttpError(404, 'Cliente no encontrado.');
  const cliente = await clientes.clienteConNegocio(req.params.id);
  if (!cliente || !cliente.negocio.activo) throw new HttpError(404, 'Cliente no encontrado.');

  let objectId;
  try {
    objectId = await googleWallet.asegurarObjeto(cliente, cliente.negocio);
  } catch (error) {
    log.error('no se pudo crear la tarjeta de Google Wallet', {
      operacion: 'google.emitir', negocio_id: cliente.negocio_id, cliente_id: cliente.id, error,
    });
    throw new HttpError(503, 'No se pudo generar la tarjeta de Google Wallet. Intente de nuevo en un momento.');
  }

  const { error } = await supabase.from('wallet_passes').upsert(
    { cliente_id: cliente.id, plataforma: 'google', serial_number: objectId },
    { onConflict: 'cliente_id,plataforma', ignoreDuplicates: true }
  );
  if (error) throw errorDb(error, 'registrar pass Google');
  res.json({ url: googleWallet.linkGuardar(objectId) });
});

module.exports = router;
