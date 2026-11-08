// RF-10: consulta de saldo sin tarjeta.
(function () {
  const { $, api, mensaje, aplicarMarca, circulosSellos, slugDeRuta, insigniaNivel } = window.NT;
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
      const pequeno = (texto) => Object.assign(document.createElement('small'), { textContent: texto });
      if (r.cashback) {
        // Cashback: saldo en colones y si ya lo puede usar.
        const c = r.cashback;
        $('#contador').replaceChildren(`₡${c.saldo.toLocaleString('es-CR')}`, ' ', pequeno('de saldo'));
        $('#sellos').replaceChildren();
        mensaje($('#estado'), c.puede_usar
          ? `Puede usar su saldo para pagar parte o el total de su próxima compra. Recibe el ${c.regla}.`
          : c.minimo
            ? `Le faltan ₡${c.faltan_para_usar.toLocaleString('es-CR')} de saldo para poder usarlo. Recibe el ${c.regla}.`
            : `Recibe el ${c.regla} como saldo.`,
          c.puede_usar ? 'exito' : 'aviso');
      } else if (r.puntos) {
        // Programa de puntos: saldo y el próximo premio del catálogo.
        const sig = r.puntos.proximo;
        $('#contador').replaceChildren(r.puntos.puntos.toLocaleString('es-CR'), ' ', pequeno('puntos'));
        $('#sellos').replaceChildren();
        mensaje($('#estado'), !sig ? ''
          : sig.faltan === 0 ? `¡Ya le alcanza para un premio! Pídalo en caja: ${sig.nombre}.`
          : `Le faltan ${sig.faltan.toLocaleString('es-CR')} puntos para: ${sig.nombre}.`,
          sig?.faltan === 0 ? 'exito' : 'aviso');
      } else {
        $('#contador').replaceChildren(String(r.sellos_actuales), ' ', pequeno(`de ${r.sellos_para_premio} sellos`));
        $('#sellos').replaceChildren(circulosSellos(Math.min(r.sellos_actuales, r.sellos_para_premio), r.sellos_para_premio));
        const faltan = r.sellos_para_premio - r.sellos_actuales;
        mensaje($('#estado'), r.premio_disponible
          ? `¡Tiene un premio disponible! Pídalo en caja: ${r.descripcion_premio}.`
          : `Le falta${faltan === 1 ? '' : 'n'} ${faltan} sello${faltan === 1 ? '' : 's'} para: ${r.descripcion_premio}.`,
          r.premio_disponible ? 'exito' : 'aviso');
      }
      mensaje($('#sorpresa'), r.sorpresa ? `🎁 ¡Ganó un premio sorpresa! Pídalo en caja: ${r.sorpresa}.` : '', 'exito');
      $('#canjeados').textContent = !r.premios_canjeados ? ''
        : r.cashback ? `Veces que usó su saldo: ${r.premios_canjeados}` : `Premios canjeados: ${r.premios_canjeados}`;
      // Nivel de la temporada (si el negocio usa niveles).
      $('#nivel').hidden = !r.nivel;
      $('#nivel').replaceChildren(...(r.nivel ? [insigniaNivel(r.nivel.nivel.clave, 28), r.nivel.resumen] : []));
      // Fecha límite si el negocio reinicia las tarjetas por inactividad.
      $('#vigencia').hidden = !r.vigencia;
      $('#vigencia').textContent = r.vigencia || '';
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
