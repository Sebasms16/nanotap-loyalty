// Página de soporte: muestra el correo de contacto configurado en el servidor.
(function () {
  const { $, api } = window.NT;
  api('/api/contacto')
    .then(({ correo }) => {
      if (!correo) return;
      $('#correo').textContent = correo;
      $('#correo').href = `mailto:${correo}`;
    })
    .catch(() => { /* queda el correo por defecto */ });
})();
