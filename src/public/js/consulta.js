// RF-10: consulta de saldo sin tarjeta.
(function () {
  const { $, api, mensaje, aplicarMarca, circulosSellos, slugDeRuta } = window.NT;
  const slug = slugDeRuta();
  $('#link-recuperar').href = `/${slug}/inscripcion`;

  $('#formulario').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const telefono = $('#telefono').value.trim();
    if (!telefono) return mensaje($('#error'), 'Escriba su número de teléfono.');
    const boton = $('#enviar');
    boton.disabled = true;
    try {
      const r = await api(`/api/clientes/consulta?slug=${encodeURIComponent(slug)}&telefono=${encodeURIComponent(telefono)}`);
      mensaje($('#error'), '');
      $('#resultado').hidden = false;
      $('#saludo').textContent = `Hola, ${r.nombre}`;
      $('#contador').replaceChildren(String(r.sellos_actuales), ' ', Object.assign(document.createElement('small'), { textContent: `de ${r.sellos_para_premio} sellos` }));
      $('#sellos').replaceChildren(circulosSellos(Math.min(r.sellos_actuales, r.sellos_para_premio), r.sellos_para_premio));
      const faltan = r.sellos_para_premio - r.sellos_actuales;
      mensaje($('#estado'), r.premio_disponible
        ? `¡Tiene un premio disponible! Pídalo en caja: ${r.descripcion_premio}.`
        : `Le falta${faltan === 1 ? '' : 'n'} ${faltan} sello${faltan === 1 ? '' : 's'} para: ${r.descripcion_premio}.`,
        r.premio_disponible ? 'exito' : 'aviso');
      $('#canjeados').textContent = r.premios_canjeados ? `Premios canjeados: ${r.premios_canjeados}` : '';
      // Nivel de la temporada (si el negocio usa niveles).
      $('#nivel').hidden = !r.nivel;
      $('#nivel').textContent = r.nivel ? r.nivel.resumen : '';
    } catch (e) {
      $('#resultado').hidden = true;
      mensaje($('#error'), e.message);
    } finally {
      boton.disabled = false;
    }
  });

  api(`/api/negocios/${encodeURIComponent(slug)}`)
    .then(({ negocio }) => {
      aplicarMarca(negocio);
      document.title = `Consultar mis sellos · ${negocio.nombre}`;
      $('#nombre-negocio').textContent = negocio.nombre;
      if (negocio.logo_url) {
        $('#logo').src = negocio.logo_url;
        $('#logo').hidden = false;
      }
      $('#formulario').hidden = false;
    })
    .catch((e) => mensaje($('#error-carga'), e.message));
})();
