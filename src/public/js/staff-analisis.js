// Análisis del negocio para su administrador (el dueño). Otro staff vuelve al escáner.
(function () {
  const { $, api, mensaje, aplicarMarca, almacen } = window.NT;
  const token = almacen.leer('nt_staff_token');
  if (!token) return location.replace('/staff/login');

  function salir() {
    almacen.borrar('nt_staff_token');
    location.replace('/staff/login');
  }
  $('#salir').addEventListener('click', salir);

  api('/api/staff/yo', { token })
    .then((r) => {
      if (r.staff.rol !== 'administrador') return location.replace('/staff/panel');
      aplicarMarca(r.negocio);
      $('#titulo').textContent = `Análisis · ${r.negocio.nombre}`;
      document.title = `Análisis · ${r.negocio.nombre}`;
      window.NT.analisis.montar($('#analisis'), {
        tipo: 'negocio', ruta: '/api/staff/analisis', token, alNoAutorizado: salir,
      });
    })
    .catch((e) => {
      if (e.status === 401) return salir();
      mensaje($('#error'), e.message);
    });
})();
