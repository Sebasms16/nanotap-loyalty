(function () {
  const { $, api, aplicarMarca, slugDeRuta } = window.NT;
  api(`/api/negocios/${encodeURIComponent(slugDeRuta())}`)
    .then(({ negocio, contacto_privacidad: contacto }) => {
      aplicarMarca(negocio);
      document.title = `Aviso de privacidad · ${negocio.nombre}`;
      document.querySelectorAll('[data-negocio]').forEach((n) => { n.textContent = negocio.nombre; });
      if (contacto) $('#contacto').textContent = contacto;
    })
    .catch(() => { /* se muestra el texto genérico */ });
})();
