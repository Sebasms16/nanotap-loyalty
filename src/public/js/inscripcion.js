// RF-02 / RF-03: formulario de inscripción y botones de wallet.
(function () {
  const { $, api, el, mensaje, aplicarMarca, circulosSellos, slugDeRuta } = window.NT;
  const slug = slugDeRuta();
  const esIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const esAndroid = /Android/.test(navigator.userAgent);

  $('#link-privacidad').href = `/${slug}/privacidad`;
  $('#link-consulta').href = `/${slug}/consulta`;

  function pintarNegocio(negocio) {
    aplicarMarca(negocio);
    document.title = `Tarjeta de lealtad · ${negocio.nombre}`;
    $('#nombre-negocio').textContent = negocio.nombre;
    // Con puntos: la regla de acumulación y el premio más barato del catálogo.
    const premioMasBarato = negocio.puntos?.premios?.[0];
    $('#regla').textContent = negocio.cashback
      ? `Reciba el ${negocio.cashback.regla} como saldo, para pagar en sus próximas compras.`
      : negocio.puntos
        ? `Gane ${negocio.puntos.regla} y cámbielos por premios${premioMasBarato ? ` desde ${premioMasBarato.puntos} puntos` : ''}.`
        : `Junte ${negocio.sellos_para_premio} sellos y reciba: ${negocio.descripcion_premio}`;
    if (negocio.logo_url) {
      $('#logo').src = negocio.logo_url;
      $('#logo').alt = negocio.nombre;
      $('#logo').hidden = false;
    }
    if (negocio.reglas?.length) {
      $('#lista-reglas').replaceChildren(...negocio.reglas.map((regla) => el('li', {}, regla)));
      $('#reglas').hidden = false;
    }
  }

  // La insignia oficial no se puede modificar: mientras se prepara el enlace se
  // ve atenuada, y si falla se explica abajo y un toque la reintenta.
  async function prepararGoogle(clienteId) {
    const boton = $('#boton-google');
    boton.hidden = false;
    boton.disabled = true;
    boton.setAttribute('aria-busy', 'true');
    try {
      const { url } = await api(`/api/wallet/google/clientes/${clienteId}`, { metodo: 'POST' });
      boton.onclick = () => { location.href = url; };
      mensaje($('#error-wallet'), '');
    } catch (e) {
      boton.onclick = () => prepararGoogle(clienteId);
      mensaje($('#error-wallet'), `${e.message} Toque el botón de Google para reintentar.`);
    } finally {
      boton.disabled = false;
      boton.removeAttribute('aria-busy');
    }
  }

  function mostrarTarjeta(r) {
    $('#formulario').hidden = true;
    $('#resultado').hidden = false;
    $('#saludo').textContent = r.existente ? `¡Hola de nuevo, ${r.cliente.nombre}!` : `¡Listo, ${r.cliente.nombre}!`;
    const conCashback = Boolean(r.negocio.cashback);
    const conPuntos = Boolean(r.negocio.puntos);
    $('#subtitulo').textContent = r.existente
      ? (conCashback ? `Ya tenía una tarjeta con nosotros. Tiene ₡${Number(r.cliente.puntos || 0).toLocaleString('es-CR')} de saldo.`
        : conPuntos ? `Ya tenía una tarjeta con nosotros. Lleva ${r.cliente.puntos} puntos.`
          : `Ya tenía una tarjeta con nosotros. Lleva ${r.cliente.sellos_actuales} de ${r.negocio.sellos_para_premio} sellos.`)
      : `Guarde su tarjeta en el teléfono para empezar a sumar ${conCashback ? 'cashback' : conPuntos ? 'puntos' : 'sellos'}.`;
    $('#sellos').replaceChildren(...(conPuntos || conCashback ? []
      : [circulosSellos(Math.min(r.cliente.sellos_actuales, r.negocio.sellos_para_premio), r.negocio.sellos_para_premio)]));
    $('#qr').src = r.qr;
    $('#codigo').textContent = r.cliente.codigo_qr;

    const apple = $('#boton-apple');
    if (r.wallets.apple) {
      apple.href = r.wallets.apple;
      apple.hidden = false;
    }
    if (r.wallets.google) prepararGoogle(r.cliente.id);
    // El botón de la plataforma del teléfono va primero.
    if (esAndroid) $('#botones-wallet').prepend($('#boton-google'));
    if (esIOS) $('#botones-wallet').prepend(apple);
    if (!r.wallets.apple && !r.wallets.google) $('#botones-wallet').hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // El teléfono ya tenía tarjeta: se le envió el enlace al correo con que se inscribió.
  function mostrarVerificacion({ enviado, motivo, correo, horas }) {
    if (motivo === 'fallo') {
      // No se pudo enviar: el formulario sigue ahí para reintentar.
      return mensaje($('#error-form'), 'Este teléfono ya tiene una tarjeta, pero no pudimos enviarle el correo para abrirla. Intente de nuevo en unos minutos.');
    }
    $('#formulario').hidden = true;
    $('#verificacion').hidden = false;
    $('#verificacion-titulo').textContent = enviado ? 'Revise su correo' : 'Este teléfono ya tiene una tarjeta';
    $('#verificacion-texto').textContent = enviado
      ? `Ya existe una tarjeta con este número de teléfono. Por seguridad no la mostramos aquí: le enviamos un enlace para abrirla a ${correo}.`
      : `Por seguridad no podemos mostrarla aquí. Pídale ayuda al personal de ${$('#nombre-negocio').textContent}.`;
    $('#verificacion-nota').textContent = enviado
      ? `Si no lo ve en unos minutos, revise la carpeta de correo no deseado o de promociones. El enlace sirve durante ${horas} horas.`
      : '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $('#formulario').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const form = evento.currentTarget;
    const error = $('#error-form');
    const campo = (nombre) => form.elements[nombre].value.trim();

    if (!campo('nombre') || !campo('primer_apellido') || !campo('telefono') || !campo('correo')) {
      return mensaje(error, 'Complete nombre, primer apellido, teléfono y correo.');
    }
    if (!form.elements.correo.checkValidity()) return mensaje(error, 'Revise el correo electrónico.');
    if (!form.elements.acepto_terminos.checked) {
      return mensaje(error, 'Debe aceptar los términos y el aviso de privacidad para continuar.');
    }
    mensaje(error, '');

    const boton = $('#enviar');
    boton.disabled = true;
    boton.textContent = 'Creando su tarjeta…';
    try {
      const r = await api(`/api/negocios/${encodeURIComponent(slug)}/clientes`, {
        metodo: 'POST',
        cuerpo: {
          nombre: campo('nombre'),
          primer_apellido: campo('primer_apellido'),
          segundo_apellido: campo('segundo_apellido'),
          telefono: campo('telefono'),
          correo: campo('correo'),
          fecha_nacimiento: campo('fecha_nacimiento'),
          identificacion: campo('identificacion'),
          acepto_terminos: true,
        },
      });
      if (r.verificacion) mostrarVerificacion(r.verificacion);
      else mostrarTarjeta(r);
    } catch (e) {
      mensaje(error, e.message);
    } finally {
      boton.disabled = false;
      boton.textContent = 'Obtener mi tarjeta';
    }
  });

  // Enlace del correo: /{slug}/inscripcion#t=TOKEN. Se quita de la barra de direcciones
  // enseguida, para que no quede en el historial ni se comparta por error.
  const token = new URLSearchParams(location.hash.slice(1)).get('t');
  if (token) history.replaceState(null, '', location.pathname);

  api(`/api/negocios/${encodeURIComponent(slug)}`)
    .then(async ({ negocio }) => {
      pintarNegocio(negocio);
      if (token) {
        try {
          return mostrarTarjeta(await api(`/api/negocios/${encodeURIComponent(slug)}/tarjeta`, { metodo: 'POST', cuerpo: { token } }));
        } catch (e) {
          mensaje($('#error-form'), e.message);
        }
      }
      $('#formulario').hidden = false;
    })
    .catch((e) => {
      $('#regla').textContent = '';
      mensaje($('#error-carga'), e.message);
    });
})();
