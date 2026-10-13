// RF-05 / RF-06: escanear QR → ver cliente → sumar sello o canjear premio.
(function () {
  const { $, api, mensaje, toast, aplicarMarca, circulosSellos, almacen, descargar, el } = window.NT;
  const token = almacen.leer('nt_staff_token');
  if (!token) return location.replace('/staff/login');

  let negocio = null;
  let cliente = null;
  let lector = null;
  let ocupado = false;

  function salir() {
    almacen.borrar('nt_staff_token');
    location.replace('/staff/login');
  }
  $('#salir').addEventListener('click', salir);

  async function llamar(ruta, opciones = {}) {
    try {
      return await api(ruta, { ...opciones, token });
    } catch (e) {
      if (e.status === 401) salir();
      throw e;
    }
  }

  // --- Escáner -------------------------------------------------------------
  async function iniciarCamara() {
    mensaje($('#error-camara'), '');
    $('#activar-camara').hidden = true;
    if (!window.Html5Qrcode) return;
    try {
      lector = lector || new window.Html5Qrcode('lector', { verbose: false });
      await lector.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: (ancho, alto) => { const lado = Math.floor(Math.min(ancho, alto) * 0.7); return { width: lado, height: lado }; } },
        (texto) => alLeer(texto),
        () => {} // cada cuadro sin QR llama aquí; se ignora
      );
    } catch (e) {
      const sinHttps = !window.isSecureContext;
      mensaje($('#error-camara'), sinHttps
        ? 'La cámara solo funciona con HTTPS. Escriba el código manualmente.'
        : 'No se pudo usar la cámara. Revise el permiso del navegador o escriba el código.', 'aviso');
      $('#activar-camara').hidden = false;
    }
  }
  $('#activar-camara').addEventListener('click', iniciarCamara);

  function pausarCamara() {
    try { if (lector?.isScanning) lector.pause(true); } catch { /* ya pausado */ }
  }
  function reanudarCamara() {
    try { lector?.resume(); } catch { /* no estaba pausado */ }
  }

  async function alLeer(texto) {
    if (ocupado) return;
    ocupado = true;
    pausarCamara();
    if (navigator.vibrate) navigator.vibrate(60);
    await buscar(texto.trim());
    ocupado = false;
  }

  $('#form-manual').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const codigo = $('#codigo').value.trim().toUpperCase();
    if (!codigo) return;
    pausarCamara();
    await buscar(codigo);
  });

  // --- Cliente -------------------------------------------------------------
  async function buscar(codigo) {
    mensaje($('#error'), '');
    try {
      const r = await llamar(`/api/clientes/${encodeURIComponent(codigo)}`);
      mostrarCliente(r.cliente);
    } catch (e) {
      mensaje($('#error'), e.message);
      toast(e.message, 'error');
      setTimeout(reanudarCamara, 1500);
    }
  }

  function pintarSellos() {
    const meta = cliente.sellos_para_premio;
    $('#contador').replaceChildren(String(cliente.sellos_actuales), ' ', el('small', {}, `de ${meta} sellos`));
    $('#sellos').replaceChildren(circulosSellos(Math.min(cliente.sellos_actuales, meta), meta));
    const disponible = cliente.sellos_actuales >= meta;
    $('#premio').hidden = !disponible;
    $('#premio').textContent = disponible ? `🎉 Premio disponible: ${cliente.descripcion_premio}` : '';
    $('#canjear').hidden = !disponible;
    reiniciarCanje();
    $('#canjeados').textContent = `Premios canjeados: ${cliente.premios_canjeados}`;
  }

  function mostrarCliente(datos) {
    cliente = datos;
    $('#seccion-escaner').hidden = true;
    $('#seccion-cliente').hidden = false;
    $('#cliente-codigo').textContent = cliente.codigo_qr;
    $('#cliente-nombre').textContent = cliente.nombre;
    $('#codigo').value = '';
    pintarSellos();
    window.scrollTo({ top: 0 });
  }

  $('#otro').addEventListener('click', () => {
    cliente = null;
    mensaje($('#error'), '');
    $('#seccion-cliente').hidden = true;
    $('#seccion-escaner').hidden = false;
    reanudarCamara();
  });

  // Aplica la respuesta de sumar/canjear a la vista.
  function actualizar(r) {
    cliente.sellos_actuales = r.sellos_actuales;
    cliente.premios_canjeados = r.premios_canjeados;
    cliente.sellos_para_premio = r.sellos_para_premio;
    pintarSellos();
  }

  $('#sumar').addEventListener('click', async () => {
    const boton = $('#sumar');
    boton.disabled = true; // evita sumar dos sellos por un doble toque
    try {
      const r = await llamar(`/api/clientes/${cliente.id}/sello`, { metodo: 'POST' });
      actualizar(r);
      toast(r.premio_disponible ? '¡Sello sumado! Premio disponible 🎉' : `Sello sumado ✓ (${r.sellos_actuales}/${r.sellos_para_premio})`, 'exito');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setTimeout(() => { boton.disabled = false; }, 1200);
    }
  });

  // Canje en dos pasos: el primer toque pide confirmación.
  let confirmando = false;
  function reiniciarCanje() {
    confirmando = false;
    $('#canjear').textContent = 'Canjear premio';
  }
  $('#canjear').addEventListener('click', async () => {
    const boton = $('#canjear');
    if (!confirmando) {
      confirmando = true;
      boton.textContent = `Confirmar: entregar ${cliente.descripcion_premio}`;
      setTimeout(() => { if (confirmando) reiniciarCanje(); }, 5000);
      return;
    }
    boton.disabled = true;
    try {
      const r = await llamar(`/api/clientes/${cliente.id}/canje`, { metodo: 'POST' });
      actualizar(r);
      toast('Premio canjeado ✓', 'exito');
    } catch (e) {
      toast(e.message, 'error');
      reiniciarCanje();
    } finally {
      boton.disabled = false;
    }
  });

  // --- Exportación ---------------------------------------------------------
  async function exportar(tipo) {
    try {
      await descargar(`/api/negocios/${encodeURIComponent(negocio.slug)}/clientes/export?tipo=${tipo}`, token);
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  $('#exportar-clientes').addEventListener('click', () => exportar('clientes'));
  $('#exportar-eventos').addEventListener('click', () => exportar('eventos'));

  // --- Inicio --------------------------------------------------------------
  llamar('/api/staff/yo')
    .then((r) => {
      negocio = r.negocio;
      aplicarMarca(negocio);
      $('#titulo').textContent = negocio.nombre;
      document.title = `Staff · ${negocio.nombre}`;
      iniciarCamara();
    })
    .catch((e) => mensaje($('#error'), e.message));
})();
