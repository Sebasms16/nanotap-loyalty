// RF-05 / RF-06: escanear QR → ver cliente → sumar sello o canjear premio.
(function () {
  const { $, api, mensaje, toast, aplicarMarca, circulosSellos, almacen, descargar, el } = window.NT;
  const token = almacen.leer('nt_staff_token');
  if (!token) return location.replace('/staff/login');

  let negocio = null;
  let cliente = null;
  let rol = 'staff'; // el administrador puede registrar compras sobre el tope
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

  // Nivel de la temporada (solo si el negocio usa niveles), en tarjetas o en puntos.
  function pintarNivel() {
    const nivel = cliente.nivel;
    $('#nivel').hidden = !nivel;
    if (!nivel) return;
    const unidad = nivel.unidad === 'puntos'
      ? (nivel.faltan === 1 ? 'punto' : 'puntos') : (nivel.faltan === 1 ? 'tarjeta' : 'tarjetas');
    $('#nivel').replaceChildren(
      el('strong', {}, `${nivel.nivel.emoji} Nivel ${nivel.nivel.nombre}`),
      el('br'),
      el('small', {}, nivel.siguiente
        ? `${nivel.faltan === 1 ? 'Falta' : 'Faltan'} ${numero(nivel.faltan)} ${unidad} para ${nivel.siguiente.emoji} ${nivel.siguiente.nombre} · temporada hasta el ${nivel.fin}`
        : `Nivel máximo · temporada hasta el ${nivel.fin}`),
      ...(nivel.unidad === 'puntos' && nivel.premio ? [el('br'), el('small', {}, `Beneficio: ${nivel.premio}`)] : []));
  }

  const numero = (n) => Number(n).toLocaleString('es-CR');
  // "12 500", "12.500" o "₡12500" → 12500
  const leerMonto = (texto) => Number.parseInt(String(texto).replace(/\D/g, ''), 10) || 0;

  // --- Programa de puntos ------------------------------------------------------
  function pintarPuntos() {
    const p = cliente.puntos;
    for (const id of ['#sellos', '#sumar', '#canjear', '#premio']) $(id).hidden = true;
    $('#bloque-puntos').hidden = false;
    $('#contador').replaceChildren(numero(p.puntos), ' ', el('small', {}, p.puntos === 1 ? 'punto' : 'puntos'));
    $('#factura-opcional').textContent = p.factura_obligatoria ? '(obligatorio)' : '(opcional)';
    $('#factura').required = p.factura_obligatoria;
    $('#canjeados').textContent = `Premios canjeados: ${cliente.premios_canjeados}`;
    pintarNivel();
    calcularVistaPuntos();
    $('#catalogo').replaceChildren(...(p.premios.length ? p.premios.map(filaPremio)
      : [el('p', { class: 'suave' }, 'El negocio todavía no tiene premios en el catálogo.')]));
  }

  // Cuántos puntos daría el monto escrito (el servidor hace la cuenta de verdad).
  function calcularVistaPuntos() {
    const p = cliente?.puntos;
    if (!p) return;
    const monto = leerMonto($('#monto').value);
    const dara = Math.floor(monto / p.colones_por_punto);
    const partes = [`Regla: ${p.regla}.`];
    if (monto) partes.push(dara ? `Esta compra suma ${numero(dara)} ${dara === 1 ? 'punto' : 'puntos'}.` : 'Ese monto no alcanza para un punto.');
    if (p.tope_compra && monto > p.tope_compra) {
      partes.push(rol === 'administrador'
        ? `Supera el tope de ₡${numero(p.tope_compra)}: como administrador puede registrarla.`
        : `Supera el tope de ₡${numero(p.tope_compra)}: solo un administrador puede registrarla.`);
    }
    $('#vista-puntos').textContent = partes.join(' ');
  }
  $('#monto').addEventListener('input', calcularVistaPuntos);

  $('#form-puntos').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const boton = $('#sumar-puntos');
    const monto = leerMonto($('#monto').value);
    if (!monto) return toast('Escriba el monto de la compra.', 'error');
    if (cliente.puntos.factura_obligatoria && !$('#factura').value.trim()) return toast('Escriba el número de factura.', 'error');
    boton.disabled = true; // evita sumar dos veces por un doble toque
    try {
      const r = await llamar(`/api/clientes/${cliente.id}/puntos`, {
        metodo: 'POST', cuerpo: { monto, factura: $('#factura').value.trim() || null },
      });
      cliente = r.cliente;
      $('#monto').value = '';
      $('#factura').value = '';
      pintarPuntos();
      const nivel = r.subio_de_nivel && r.cliente?.nivel?.nivel;
      toast(`+${numero(r.puntos_sumados)} puntos ✓ (lleva ${numero(r.puntos_actuales)})${nivel ? ` · ¡Subió a ${nivel.emoji} ${nivel.nombre}!` : ''}`, 'exito');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setTimeout(() => { boton.disabled = false; }, 1200);
    }
  });

  // Cada premio con su botón; el canje pide confirmación con un segundo toque.
  function filaPremio(premio) {
    const boton = el('button', { class: 'boton chico', type: 'button' }, 'Canjear');
    boton.disabled = !premio.alcanza;
    let armado = false;
    boton.addEventListener('click', async () => {
      if (!armado) {
        armado = true;
        boton.textContent = 'Confirmar';
        boton.className = 'boton chico exito';
        setTimeout(() => { if (armado) { armado = false; boton.textContent = 'Canjear'; boton.className = 'boton chico'; } }, 5000);
        return;
      }
      boton.disabled = true;
      try {
        const r = await llamar(`/api/clientes/${cliente.id}/canje-puntos`, { metodo: 'POST', cuerpo: { premio_id: premio.id } });
        cliente = r.cliente;
        pintarPuntos();
        toast(`Entregue: ${r.premio} ✓ (quedan ${numero(r.puntos_actuales)} puntos)`, 'exito');
      } catch (e) {
        toast(e.message, 'error');
        boton.disabled = false;
      }
    });
    return el('div', { class: `fila-premio${premio.alcanza ? '' : ' no-alcanza'}` },
      el('span', {}, el('strong', {}, premio.nombre), el('br'), el('small', { class: 'suave' }, `${numero(premio.puntos)} puntos`)),
      boton);
  }

  function pintarSellos() {
    if (cliente.puntos) return pintarPuntos();
    $('#bloque-puntos').hidden = true;
    for (const id of ['#sellos', '#sumar']) $(id).hidden = false;
    const meta = cliente.sellos_para_premio;
    $('#contador').replaceChildren(String(cliente.sellos_actuales), ' ', el('small', {}, `de ${meta} sellos`));
    $('#sellos').replaceChildren(circulosSellos(Math.min(cliente.sellos_actuales, meta), meta));
    const disponible = cliente.sellos_actuales >= meta;
    $('#premio').hidden = !disponible;
    $('#premio').textContent = disponible ? `🎉 Premio disponible: ${cliente.descripcion_premio}` : '';
    $('#canjear').hidden = !disponible;
    reiniciarCanje();
    $('#canjeados').textContent = `Premios canjeados: ${cliente.premios_canjeados}`;
    pintarNivel();
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

  // Aplica la respuesta de sumar/canjear a la vista (trae el cliente al día, con su nivel).
  function actualizar(r) {
    if (r.cliente) cliente = r.cliente;
    else Object.assign(cliente, {
      sellos_actuales: r.sellos_actuales, premios_canjeados: r.premios_canjeados, sellos_para_premio: r.sellos_para_premio,
    });
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
      const nivel = r.subio_de_nivel && r.cliente?.nivel?.nivel;
      toast(nivel ? `Premio canjeado ✓ ¡Subió a ${nivel.emoji} ${nivel.nombre}!` : 'Premio canjeado ✓', 'exito');
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
      rol = r.staff.rol;
      $('#ir-analisis').hidden = rol !== 'administrador'; // solo el dueño ve el análisis
      if (negocio.tipo_programa === 'puntos') {
        document.title = `Staff · ${negocio.nombre} · Puntos`;
        $('#exportar-eventos').textContent = 'Historial de puntos';
      }
      iniciarCamara();
    })
    .catch((e) => mensaje($('#error'), e.message));
})();
