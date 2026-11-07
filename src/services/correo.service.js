// Correos a los clientes, enviados con la API de Resend (resend.com).
// Hoy hay uno solo: el enlace para abrir una tarjeta que ya existe, cuando alguien se
// inscribe con un teléfono que ya está registrado (ver clientes.service).
const env = require('../config/env');
const log = require('../utils/logger');

const escaparHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// "sebastian@gmail.com" → "s•••@gmail.com": para decirle al cliente adónde se envió sin revelarlo.
function ocultarCorreo(correo) {
  const [usuario, dominio] = String(correo || '').split('@');
  if (!usuario || !dominio) return '';
  return `${usuario[0]}•••@${dominio}`;
}

const colorValido = (c, porDefecto) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : porDefecto);

// Asunto, HTML y texto del correo con el enlace a la tarjeta.
function correoEnlaceTarjeta({ nombre, negocio, enlace, horas }) {
  const fondo = colorValido(negocio.color_primario, '#1a1a2e');
  const letra = colorValido(negocio.color_secundario, '#ffffff');
  const n = escaparHtml(negocio.nombre);
  const logo = /^https:\/\//.test(negocio.logo_url || '')
    ? `<img src="${escaparHtml(negocio.logo_url)}" alt="${n}" width="72" height="72" style="display:block;margin:0 auto 12px;width:72px;height:72px;object-fit:contain">`
    : '';
  const asunto = `Su tarjeta de lealtad de ${negocio.nombre}`;
  const html = `<!doctype html><html lang="es"><body style="margin:0;padding:24px 12px;background:#f2f2f5;font-family:Arial,Helvetica,sans-serif;color:#1f1f1f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:${fondo};color:${letra};padding:24px;text-align:center">${logo}<div style="font-size:20px;font-weight:bold">${n}</div></td></tr>
<tr><td style="padding:24px 24px 8px;font-size:16px;line-height:1.5">
<p style="margin:0 0 12px">Hola, ${escaparHtml(nombre)}:</p>
<p style="margin:0 0 20px">Alguien pidió abrir su tarjeta de lealtad de ${n} con su número de teléfono. Para verla y guardarla en su teléfono, toque el botón:</p>
<p style="margin:0 0 20px;text-align:center"><a href="${escaparHtml(enlace)}" style="display:inline-block;background:${fondo};color:${letra};text-decoration:none;font-weight:bold;padding:14px 28px;border-radius:10px">Abrir mi tarjeta</a></p>
<p style="margin:0 0 12px;font-size:14px;color:#555">El enlace sirve durante ${horas} horas. Si usted no lo pidió, ignore este correo: su tarjeta sigue segura y nadie más puede abrirla sin este enlace.</p>
</td></tr>
<tr><td style="padding:8px 24px 24px;font-size:12px;color:#888;text-align:center">Tarjetas de lealtad por Nanotap</td></tr>
</table></td></tr></table></body></html>`;
  const texto = `Hola, ${nombre}:\n\n`
    + `Alguien pidió abrir su tarjeta de lealtad de ${negocio.nombre} con su número de teléfono. `
    + `Para verla y guardarla en su teléfono, abra este enlace:\n\n${enlace}\n\n`
    + `El enlace sirve durante ${horas} horas. Si usted no lo pidió, ignore este correo: su tarjeta sigue segura.\n\n`
    + 'Tarjetas de lealtad por Nanotap';
  return { asunto, html, texto };
}

// Envía un correo. Devuelve true si Resend lo aceptó; nunca lanza (quien llama decide qué decir).
async function enviar({ para, asunto, html, texto }, contexto = {}) {
  if (!env.correo.habilitado) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.correo.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.correo.remitente, to: [para], subject: asunto, html, text: texto }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) return true;
    log.error('Resend rechazó el correo', { ...contexto, status: r.status, respuesta: (await r.text()).slice(0, 300) });
  } catch (error) {
    log.error('no se pudo enviar el correo', { ...contexto, error });
  }
  return false;
}

module.exports = { ocultarCorreo, correoEnlaceTarjeta, enviar, escaparHtml };
