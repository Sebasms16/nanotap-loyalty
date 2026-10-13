// RF-04: login del staff. El token se guarda en este navegador (12 h).
(function () {
  const { $, api, mensaje, almacen } = window.NT;
  const parametros = new URLSearchParams(location.search);
  const negocioGuardado = parametros.get('negocio') || almacen.leer('nt_staff_negocio') || '';
  $('#negocio').value = negocioGuardado;
  (negocioGuardado ? $('#usuario') : $('#negocio')).focus();

  if (almacen.leer('nt_staff_token')) location.replace('/staff/panel');

  $('#formulario').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const negocio = $('#negocio').value.trim().toLowerCase();
    const usuario = $('#usuario').value.trim();
    const password = $('#password').value;
    if (!negocio || !usuario || !password) return mensaje($('#error'), 'Complete los tres campos.');
    const boton = $('#enviar');
    boton.disabled = true;
    try {
      const r = await api('/api/staff/login', { metodo: 'POST', cuerpo: { negocio, usuario, password } });
      almacen.guardar('nt_staff_token', r.token);
      almacen.guardar('nt_staff_negocio', negocio);
      location.replace('/staff/panel');
    } catch (e) {
      mensaje($('#error'), e.message);
      boton.disabled = false;
    }
  });
})();
