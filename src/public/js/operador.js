// RF-01, RF-08, RF-09 y Ley 8968: panel del operador.
(function () {
  const { $, api, el, mensaje, toast, almacen, descargar } = window.NT;
  let token = almacen.leer('nt_operador_token');
  let negocios = [];
  let baseUrl = location.origin;
  let editando = null; // negocio en edición (null = alta)
  let seleccionado = null; // negocio abierto en el detalle

  const fecha = (iso) => (iso ? new Date(iso).toLocaleString('es-CR', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  async function llamar(ruta, opciones = {}) {
    try {
      return await api(ruta, { ...opciones, token });
    } catch (e) {
      if (e.status === 401) salir();
      throw e;
    }
  }

  function salir() {
    almacen.borrar('nt_operador_token');
    token = null;
    $('#vista-panel').hidden = true;
    $('#vista-login').hidden = false;
  }
  $('#salir').addEventListener('click', salir);

  $('#form-login').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    try {
      const r = await api('/api/operador/login', { metodo: 'POST', cuerpo: { password: $('#password').value } });
      token = r.token;
      almacen.guardar('nt_operador_token', token);
      $('#password').value = '';
      mensaje($('#error-login'), '');
      abrirPanel();
    } catch (e) {
      mensaje($('#error-login'), e.message);
    }
  });

  // Botón de confirmación en dos pasos (sin diálogos del navegador).
  function botonConfirmar(texto, textoConfirmar, accion, clase = 'peligro') {
    let armado = false;
    const boton = el('button', { class: `boton chico secundario`, type: 'button' }, texto);
    boton.addEventListener('click', async () => {
      if (!armado) {
        armado = true;
        boton.textContent = textoConfirmar;
        boton.className = `boton chico ${clase}`;
        setTimeout(() => {
          if (!armado) return;
          armado = false;
          boton.textContent = texto;
          boton.className = 'boton chico secundario';
        }, 4000);
        return;
      }
      armado = false;
      boton.disabled = true;
      try { await accion(); } finally { boton.disabled = false; }
    });
    return boton;
  }

  // --- Estado del sistema (RNF-10) -------------------------------------------
  async function cargarEstado() {
    const r = await llamar('/api/operador/estado');
    const insignia = (ok, si, no) => el('span', { class: `insignia ${ok ? 'si' : 'no'}` }, ok ? si : no);
    const certificados = r.apple.certificados.map((c) => el('li', {},
      `${c.nombre}: vence ${fecha(c.vence)} `,
      el('span', { class: `insignia ${c.dias < 30 ? 'no' : 'si'}` }, c.dias < 0 ? 'VENCIDO' : `${c.dias} días`)));
    $('#estado').replaceChildren(
      el('h2', {}, 'Estado'),
      el('p', {}, 'Apple Wallet: ', insignia(r.apple.habilitado, 'configurado', 'sin configurar'),
        '  Google Wallet: ', insignia(r.google.habilitado, 'configurado', 'sin configurar'),
        '  Actualizaciones de tarjetas pendientes: ', el('strong', {}, String(r.sincronizaciones_pendientes))),
      certificados.length ? el('ul', { class: 'suave' }, certificados) : null
    );
  }

  // --- Negocios ----------------------------------------------------------
  async function cargarNegocios() {
    const r = await llamar('/api/operador/negocios');
    negocios = r.negocios;
    baseUrl = r.base_url || baseUrl;
    $('#tabla-negocios').replaceChildren(...(negocios.length ? negocios.map(filaNegocio)
      : [el('tr', {}, el('td', { colspan: 7, class: 'suave' }, 'Todavía no hay negocios. Cree el primero.'))]));
    if (seleccionado) {
      seleccionado = negocios.find((n) => n.id === seleccionado.id) || null;
      if (seleccionado) pintarDetalle();
    }
  }

  function filaNegocio(n) {
    const toggle = el('button', { class: 'boton chico secundario', type: 'button' }, n.activo ? 'Desactivar' : 'Activar');
    toggle.addEventListener('click', async () => {
      try {
        await llamar(`/api/negocios/${n.id}`, { metodo: 'PATCH', cuerpo: { activo: !n.activo } });
        toast(n.activo ? 'Negocio desactivado' : 'Negocio activado', 'exito');
        await cargarNegocios();
      } catch (e) { toast(e.message, 'error'); }
    });
    return el('tr', {},
      el('td', {}, el('strong', {}, n.nombre)),
      el('td', { class: 'codigo' }, n.slug),
      el('td', {}, String(n.total_clientes)),
      el('td', {}, String(n.total_staff)),
      el('td', {}, `${n.sellos_para_premio} sellos → ${n.descripcion_premio}`),
      el('td', {}, el('span', { class: `insignia ${n.activo ? 'si' : 'no'}` }, n.activo ? 'Activo' : 'Inactivo')),
      el('td', {},
        el('button', { class: 'boton chico', type: 'button', onclick: () => abrirDetalle(n) }, 'Abrir'),
        el('button', { class: 'boton chico secundario', type: 'button', onclick: () => abrirFormNegocio(n) }, 'Editar'),
        toggle));
  }

  function mostrarMiniatura(selector, url) {
    $(selector).hidden = !url;
    if (url) $(selector).src = url;
  }

  function abrirFormNegocio(n = null, { desplazar = true } = {}) {
    editando = n;
    $('#titulo-form-negocio').textContent = n ? `Editar ${n.nombre}` : 'Nuevo negocio';
    $('#n-nombre').value = n?.nombre || '';
    $('#n-slug').value = n?.slug || '';
    $('#n-slug').disabled = Boolean(n); // el slug no cambia: rompería los enlaces y QR impresos
    $('#n-logo').value = '';
    $('#n-sello').value = '';
    $('#n-sello-quitar').checked = false;
    mostrarMiniatura('#n-logo-actual', n?.logo_url);
    $('#n-ocultar-nombre').checked = Boolean(n?.ocultar_nombre);
    mostrarMiniatura('#n-sello-actual', n?.sello_url);
    $('#n-sello-quitar-fila').hidden = !n?.sello_url;
    $('#n-primario').value = n?.color_primario || '#1a1a2e';
    $('#n-secundario').value = n?.color_secundario || '#ffffff';
    $('#n-fondo-igual').checked = !n?.color_fondo_sellos;
    $('#n-fondo-sellos').value = n?.color_fondo_sellos || n?.color_primario || '#1a1a2e';
    $('#n-fondo-sellos').disabled = $('#n-fondo-igual').checked;
    $('#n-sellos').value = n?.sellos_para_premio || 10;
    $('#n-premio').value = n?.descripcion_premio || 'Producto gratis';
    $('#n-reglas').value = (n?.reglas_lista || []).join('\n');
    reglasAlAbrir = $('#n-reglas').value;
    $('#n-logo-aviso').hidden = true;
    $('#n-sello-aviso').hidden = true;
    const pendientes = n?.estampas_pendientes === 'ocultas' ? 'ocultas' : 'gris';
    document.querySelector(`input[name="n-pendientes"][value="${pendientes}"]`).checked = true;
    reiniciarEstampas();
    $('#n-prev-llenos').value = 3;
    actualizarVistaPrevia();
    mensaje($('#error-negocio'), '');
    $('#form-negocio').hidden = false;
    if (desplazar) {
      $('#form-negocio').scrollIntoView({ behavior: 'smooth' });
      $('#n-nombre').focus();
    }
  }
  // Las reglas solo se envían si se tocaron: así un negocio con las sugeridas las
  // sigue teniendo al día aunque cambie el premio o la cantidad de estampas.
  let reglasAlAbrir = '';
  $('#n-reglas-sugeridas').addEventListener('click', () => {
    $('#n-reglas').value = '';
    toast('Al guardar se usarán las reglas sugeridas.');
  });

  $('#nuevo-negocio').addEventListener('click', () => abrirFormNegocio());
  $('#cancelar-negocio').addEventListener('click', () => { $('#form-negocio').hidden = true; });
  $('#n-fondo-igual').addEventListener('change', () => {
    $('#n-fondo-sellos').disabled = $('#n-fondo-igual').checked;
    if ($('#n-fondo-igual').checked) $('#n-fondo-sellos').value = $('#n-primario').value;
  });
  $('#n-primario').addEventListener('input', () => {
    if ($('#n-fondo-igual').checked) $('#n-fondo-sellos').value = $('#n-primario').value;
  });
  $('#n-nombre').addEventListener('input', () => {
    if (editando) return;
    $('#n-slug').value = $('#n-nombre').value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  });

  // Sube el archivo tal cual; el servidor lo valida y lo convierte a PNG.
  async function subirArchivo(ruta, archivo) {
    const r = await fetch(ruta, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': archivo.type || 'application/octet-stream' },
      body: archivo,
    });
    const datos = await r.json().catch(() => ({}));
    if (r.status === 401) salir();
    if (!r.ok) throw new Error(datos.error || 'No se pudo subir la imagen.');
    return datos.negocio;
  }
  const subirImagen = (negocioId, tipo, archivo) => subirArchivo(`/api/negocios/${negocioId}/imagenes/${tipo}`, archivo);

  // --- Una imagen distinta por estampa -----------------------------------------
  // Los cambios quedan aquí hasta Guardar, como el resto del formulario.
  const estampasNuevas = new Map(); // posición → { archivo, url } elegido y sin guardar
  const estampasQuitadas = new Set(); // posiciones con imagen guardada que se quitan al guardar
  let posicionElegida = 0;
  const totalEstampas = () => Math.min(30, Math.max(1, Number($('#n-sellos').value) || 10));

  // Posiciones con imagen propia guardada (1 = primera estampa).
  const estampasGuardadas = () => (editando?.estampas_urls || []).flatMap((url, i) => (url ? [i + 1] : []));
  const modoDistintas = () => document.querySelector('input[name="n-modo-estampas"]:checked').value === 'distintas';

  function reiniciarEstampas() {
    for (const { url } of estampasNuevas.values()) URL.revokeObjectURL(url);
    estampasNuevas.clear();
    estampasQuitadas.clear();
    const modo = estampasGuardadas().length ? 'distintas' : 'misma';
    document.querySelector(`input[name="n-modo-estampas"][value="${modo}"]`).checked = true;
    mostrarModo();
    pintarEstampas();
  }

  // Muestra solo lo que corresponde al modo elegido. Volver a "la misma para todas"
  // no borra nada hasta Guardar; si había imágenes por estampa, se avisa.
  function mostrarModo() {
    const distintas = modoDistintas();
    $('#n-campo-misma').hidden = distintas;
    $('#n-campo-distintas').hidden = !distintas;
    $('#n-modo-aviso').hidden = distintas || !estampasGuardadas().length;
  }
  document.querySelectorAll('input[name="n-modo-estampas"]').forEach((opcion) => {
    opcion.addEventListener('change', mostrarModo);
  });

  // Lo que hay que subir y quitar al guardar. Con "la misma para todas" se quitan
  // todas las imágenes por estampa guardadas; si no, solo las posiciones visibles.
  function cambiosEstampas() {
    if (!modoDistintas()) return { nuevas: [], quitadas: estampasGuardadas() };
    const total = totalEstampas();
    return {
      nuevas: [...estampasNuevas].filter(([posicion]) => posicion <= total),
      quitadas: [...estampasQuitadas].filter((posicion) => posicion <= total),
    };
  }

  // Imagen propia que tendrá la posición al guardar (null = usa la general).
  function imagenDeEstampa(posicion) {
    if (estampasNuevas.has(posicion)) return estampasNuevas.get(posicion).url;
    if (estampasQuitadas.has(posicion)) return null;
    return editando?.estampas_urls?.[posicion - 1] || null;
  }

  function pintarEstampas() {
    const casillas = [];
    for (let posicion = 1; posicion <= totalEstampas(); posicion++) {
      const imagen = imagenDeEstampa(posicion);
      casillas.push(el('div', { class: `estampa-propia${imagen ? ' con-imagen' : ''}` },
        el('button', {
          type: 'button',
          'aria-label': `${imagen ? 'Cambiar' : 'Elegir'} la imagen de la estampa ${posicion}`,
          onclick: () => { posicionElegida = posicion; $('#n-estampa-archivo').click(); },
        }, imagen ? el('img', { src: imagen, alt: '' }) : '+'),
        imagen
          ? el('button', {
            type: 'button', class: 'quitar', 'aria-label': `Quitar la imagen de la estampa ${posicion}`,
            onclick: () => quitarEstampa(posicion),
          }, `${posicion} · quitar`)
          : el('span', {}, String(posicion))));
    }
    $('#n-estampas').replaceChildren(...casillas);
  }

  function quitarEstampa(posicion) {
    const nueva = estampasNuevas.get(posicion);
    if (nueva) URL.revokeObjectURL(nueva.url);
    estampasNuevas.delete(posicion);
    if (editando?.estampas_urls?.[posicion - 1]) estampasQuitadas.add(posicion);
    pintarEstampas();
    actualizarVistaPrevia();
  }

  $('#n-estampa-archivo').addEventListener('change', () => {
    const archivo = $('#n-estampa-archivo').files[0];
    $('#n-estampa-archivo').value = '';
    if (!archivo || !posicionElegida) return;
    const anterior = estampasNuevas.get(posicionElegida);
    if (anterior) URL.revokeObjectURL(anterior.url);
    estampasNuevas.set(posicionElegida, { archivo, url: URL.createObjectURL(archivo) });
    estampasQuitadas.delete(posicionElegida);
    pintarEstampas();
    actualizarVistaPrevia();
  });
  $('#n-sellos').addEventListener('input', pintarEstampas);

  async function guardarEstampas(negocio) {
    const { nuevas, quitadas } = cambiosEstampas();
    for (const [posicion, { archivo }] of nuevas) {
      negocio = await subirArchivo(`/api/negocios/${negocio.id}/estampas/${posicion}`, archivo);
    }
    for (const posicion of quitadas) {
      negocio = (await llamar(`/api/negocios/${negocio.id}/estampas/${posicion}`, { metodo: 'DELETE' })).negocio;
    }
    return negocio;
  }

  // --- Medidas recomendadas: avisa (sin bloquear) si la imagen no es ideal ---
  const MEDIDAS = { logo: 660, sello: 300 };
  async function revisarImagen(tipo) {
    const archivo = $(`#n-${tipo}`).files[0];
    const aviso = $(`#n-${tipo}-aviso`);
    aviso.hidden = true;
    if (!archivo) return;
    const problemas = [];
    if (archivo.type === 'image/jpeg') {
      problemas.push('Los JPG no tienen fondo transparente: el fondo de la imagen se verá como un cuadro. Use PNG si puede.');
    }
    if (archivo.type !== 'image/svg+xml') {
      const url = URL.createObjectURL(archivo);
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
        const { naturalWidth: ancho, naturalHeight: alto } = img;
        if (Math.min(ancho, alto) < MEDIDAS[tipo]) {
          problemas.push(`La imagen mide ${ancho} × ${alto} px; se recomienda al menos ${MEDIDAS[tipo]} × ${MEDIDAS[tipo]} px para que no se vea borrosa.`);
        }
        if (Math.abs(ancho - alto) / Math.max(ancho, alto) > 0.1) {
          problemas.push(`No es cuadrada (${ancho} × ${alto} px): quedará con espacio vacío a los lados.`);
        }
      } catch {
        problemas.push('No se pudo leer la imagen. Pruebe con otro archivo PNG.');
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    aviso.textContent = problemas.join(' ');
    aviso.hidden = !problemas.length;
  }

  // --- Vista previa de la tarjeta (iPhone / Android) -------------------------
  let urlLogoPrevia = null;
  let urlTiraPrevia = null;
  let temporizadorTira = null;
  let pedidoTira = 0;

  // Blanco o negro: Google elige el color del texto según el fondo.
  function textoSobre(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1f1f1f' : '#ffffff';
  }

  function actualizarVistaPrevia() {
    const nombre = $('#n-nombre').value.trim() || 'Nombre del negocio';
    const total = Math.min(30, Math.max(1, Number($('#n-sellos').value) || 10));
    const rango = $('#n-prev-llenos');
    rango.max = total;
    const llenos = Math.min(Number(rango.value), total);
    $('#n-prev-llenos-valor').textContent = `${llenos} de ${total}`;
    const premio = $('#n-premio').value.trim() || 'Premio';
    const fondo = $('#n-primario').value;
    const texto = $('#n-secundario').value;
    const faltan = total - llenos;

    const ios = $('#tarjeta-ios');
    ios.style.background = fondo;
    ios.style.color = texto;
    const android = $('#tarjeta-android');
    android.style.background = fondo;
    android.style.color = textoSobre(fondo);

    document.querySelectorAll('.vista-tarjeta [data-nombre]').forEach((n) => { n.textContent = nombre; });
    // En iPhone el nombre se puede ocultar; Google lo muestra siempre.
    document.querySelector('#tarjeta-ios [data-nombre]').style.visibility = $('#n-ocultar-nombre').checked ? 'hidden' : '';
    document.querySelectorAll('.vista-tarjeta [data-premio]').forEach((n) => { n.textContent = premio; });
    document.querySelector('.vista-tarjeta [data-contador]').textContent = `${llenos}/${total}`;
    document.querySelector('.vista-tarjeta [data-contador-largo]').textContent = `${llenos} / ${total}`;
    document.querySelector('.vista-tarjeta [data-faltan]').textContent = faltan === 0 ? '¡Listo!' : String(faltan);

    // Logo: el archivo recién elegido, o el guardado, o el ícono genérico.
    const archivoLogo = $('#n-logo').files[0];
    if (urlLogoPrevia) URL.revokeObjectURL(urlLogoPrevia);
    urlLogoPrevia = archivoLogo ? URL.createObjectURL(archivoLogo) : null;
    const logo = urlLogoPrevia || editando?.logo_url || null;
    const logoIos = document.querySelector('.vista-tarjeta [data-logo]');
    logoIos.hidden = !logo;
    if (logo) logoIos.src = logo;
    document.querySelector('.vista-tarjeta [data-logo-redondo]').src = logo
      || `/img/icono.png?tam=120&fondo=${fondo.slice(1)}&color=${texto.slice(1)}`;

    clearTimeout(temporizadorTira);
    temporizadorTira = setTimeout(() => pedirTira({ total, llenos, texto }), 250);
  }

  // Copia pequeña del archivo para la vista previa: la tira no necesita más de 300 px.
  const reducidas = new WeakMap();
  function reducir(archivo) {
    if (!reducidas.has(archivo)) {
      reducidas.set(archivo, (async () => {
        const url = URL.createObjectURL(archivo);
        try {
          const img = new Image();
          img.src = url;
          await img.decode();
          const ancho = img.naturalWidth || 300;
          const alto = img.naturalHeight || 300;
          const escala = Math.min(1, 300 / Math.max(ancho, alto));
          const lienzo = document.createElement('canvas');
          lienzo.width = Math.max(1, Math.round(ancho * escala));
          lienzo.height = Math.max(1, Math.round(alto * escala));
          lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
          return await new Promise((listo) => lienzo.toBlob((png) => listo(png || archivo), 'image/png'));
        } catch {
          return archivo; // el servidor decide si es una imagen válida
        } finally {
          URL.revokeObjectURL(url);
        }
      })());
    }
    return reducidas.get(archivo);
  }

  // La zona de estampas la dibuja el servidor, igual que en las tarjetas reales.
  // Se le mandan solo los cambios sin guardar; lo demás lo toma del negocio guardado.
  async function pedirTira({ total, llenos, texto }) {
    const fondoSellos = $('#n-fondo-igual').checked ? $('#n-primario').value : $('#n-fondo-sellos').value;
    const { nuevas, quitadas } = cambiosEstampas();
    const archivos = [['logo', $('#n-logo').files[0]], ['sello', $('#n-sello').files[0]],
      ...nuevas.map(([posicion, { archivo }]) => [posicion, archivo])].filter(([, archivo]) => archivo);
    const quitar = [...quitadas];
    if ($('#n-sello-quitar').checked) quitar.push('sello');

    const numero = ++pedidoTira;
    const partes = await Promise.all(archivos.map(async ([nombre, archivo]) => [nombre, await reducir(archivo)]));
    if (numero !== pedidoTira) return;
    const parametros = new URLSearchParams({
      total, llenos, fondo: fondoSellos.slice(1), color: texto.slice(1), negocio_id: editando?.id || '',
      pendientes: document.querySelector('input[name="n-pendientes"]:checked').value,
      quitar: quitar.join(','),
      partes: partes.map(([nombre, png]) => `${nombre}:${png.size}`).join(','),
    });
    try {
      const r = await fetch(`/api/operador/vista-previa/estampas?${parametros}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        body: new Blob(partes.map(([, png]) => png)),
      });
      if (r.status === 401) return salir();
      if (!r.ok || numero !== pedidoTira) return; // llegó tarde: ya hay un pedido más nuevo
      if (urlTiraPrevia) URL.revokeObjectURL(urlTiraPrevia);
      urlTiraPrevia = URL.createObjectURL(await r.blob());
      document.querySelectorAll('.vista-tarjeta [data-tira]').forEach((img) => { img.src = urlTiraPrevia; });
    } catch { /* sin conexión: se mantiene la vista anterior */ }
  }

  $('#form-negocio').addEventListener('input', actualizarVistaPrevia);
  $('#n-logo').addEventListener('change', () => { revisarImagen('logo'); actualizarVistaPrevia(); });
  $('#n-sello').addEventListener('change', () => { revisarImagen('sello'); actualizarVistaPrevia(); });
  for (const [boton, mostrar] of [['#ver-ios', '#tarjeta-ios'], ['#ver-android', '#tarjeta-android']]) {
    $(boton).addEventListener('click', () => {
      for (const [b, t] of [['#ver-ios', '#tarjeta-ios'], ['#ver-android', '#tarjeta-android']]) {
        $(b).setAttribute('aria-pressed', String(b === boton));
        $(t).hidden = t !== mostrar;
      }
    });
  }

  $('#form-negocio').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const boton = evento.submitter;
    const cuerpo = {
      nombre: $('#n-nombre').value,
      color_primario: $('#n-primario').value,
      color_secundario: $('#n-secundario').value,
      color_fondo_sellos: $('#n-fondo-igual').checked ? null : $('#n-fondo-sellos').value,
      sellos_para_premio: Number($('#n-sellos').value),
      descripcion_premio: $('#n-premio').value,
      estampas_pendientes: document.querySelector('input[name="n-pendientes"]:checked').value,
      ocultar_nombre: $('#n-ocultar-nombre').checked,
    };
    if ($('#n-sello-quitar').checked) cuerpo.sello_url = null;
    if ($('#n-reglas').value !== reglasAlAbrir) cuerpo.reglas = $('#n-reglas').value;
    if (boton) boton.disabled = true;
    try {
      const r = editando
        ? await llamar(`/api/negocios/${editando.id}`, { metodo: 'PATCH', cuerpo })
        : await llamar('/api/negocios', { metodo: 'POST', cuerpo: { ...cuerpo, slug: $('#n-slug').value } });
      let negocio = r.negocio;
      const logo = $('#n-logo').files[0];
      const sello = $('#n-sello').files[0];
      if (logo) negocio = await subirImagen(negocio.id, 'logo', logo);
      if (sello) negocio = await subirImagen(negocio.id, 'sello', sello);
      negocio = await guardarEstampas(negocio);
      toast(editando ? 'Guardado. Las tarjetas se actualizan en unos minutos.' : `Negocio creado. Inscripción: ${r.url_inscripcion}`, 'exito');
      await cargarNegocios();
      // Queda abierto con la vista previa nueva (la lista trae las reglas vigentes).
      abrirFormNegocio(negocios.find((x) => x.id === negocio.id) || negocio, { desplazar: false });
    } catch (e) {
      mensaje($('#error-negocio'), e.message);
    } finally {
      if (boton) boton.disabled = false;
    }
  });

  // --- Detalle: staff y clientes -------------------------------------------
  function abrirDetalle(n) {
    seleccionado = n;
    $('#tabla-clientes').replaceChildren();
    $('#buscar').value = '';
    pintarDetalle();
    cargarStaff();
    $('#detalle').hidden = false;
    $('#detalle').scrollIntoView({ behavior: 'smooth' });
  }
  $('#cerrar-detalle').addEventListener('click', () => { seleccionado = null; $('#detalle').hidden = true; });

  function pintarDetalle() {
    const n = seleccionado;
    $('#detalle-titulo').textContent = n.nombre;
    const enlace = (ruta, texto) => el('a', { href: `${baseUrl}${ruta}`, target: '_blank', rel: 'noopener' }, texto);
    $('#detalle-links').replaceChildren(
      'Inscripción: ', enlace(`/${n.slug}/inscripcion`, `${baseUrl}/${n.slug}/inscripcion`), el('br'),
      'Staff: ', enlace(`/${n.slug}/staff`, `${baseUrl}/${n.slug}/staff`), el('br'),
      'Consulta de saldo: ', enlace(`/${n.slug}/consulta`, `${baseUrl}/${n.slug}/consulta`));
  }

  async function exportar(tipo) {
    try {
      await descargar(`/api/negocios/${encodeURIComponent(seleccionado.slug)}/clientes/export?tipo=${tipo}`, token);
    } catch (e) { toast(e.message, 'error'); }
  }
  $('#exportar-clientes').addEventListener('click', () => exportar('clientes'));
  $('#exportar-eventos').addEventListener('click', () => exportar('eventos'));

  async function cargarStaff() {
    try {
      const r = await llamar(`/api/negocios/${seleccionado.id}/staff`);
      $('#tabla-staff').replaceChildren(...(r.staff.length ? r.staff.map(filaStaff)
        : [el('tr', {}, el('td', { colspan: 4, class: 'suave' }, 'Sin usuarios. Cree uno abajo.'))]));
    } catch (e) { mensaje($('#error-staff'), e.message); }
  }

  function filaStaff(s) {
    const reset = el('button', { class: 'boton chico secundario', type: 'button' }, 'Nueva contraseña');
    reset.addEventListener('click', () => {
      const campo = el('input', { type: 'text', placeholder: 'mín. 8 caracteres', autocomplete: 'off' });
      const guardar = el('button', { class: 'boton chico', type: 'button' }, 'Guardar');
      guardar.addEventListener('click', async () => {
        try {
          await llamar(`/api/staff/${s.id}`, { metodo: 'PATCH', cuerpo: { password: campo.value } });
          toast('Contraseña actualizada', 'exito');
          cargarStaff();
        } catch (e) { toast(e.message, 'error'); }
      });
      reset.replaceWith(campo, guardar);
      campo.focus();
    });
    const toggle = el('button', { class: 'boton chico secundario', type: 'button' }, s.activo ? 'Desactivar' : 'Activar');
    toggle.addEventListener('click', async () => {
      try {
        await llamar(`/api/staff/${s.id}`, { metodo: 'PATCH', cuerpo: { activo: !s.activo } });
        cargarStaff();
        cargarNegocios();
      } catch (e) { toast(e.message, 'error'); }
    });
    return el('tr', {},
      el('td', { class: 'codigo' }, s.usuario),
      el('td', {}, s.nombre || '—'),
      el('td', {}, el('span', { class: `insignia ${s.activo ? 'si' : 'no'}` }, s.activo ? 'Activo' : 'Inactivo')),
      el('td', {}, reset, toggle));
  }

  $('#form-staff').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const form = evento.currentTarget;
    try {
      const r = await llamar(`/api/negocios/${seleccionado.id}/staff`, {
        metodo: 'POST',
        cuerpo: { usuario: $('#s-usuario').value, nombre: $('#s-nombre').value, password: $('#s-password').value },
      });
      toast('Usuario creado', 'exito');
      form.reset();
      // El usuario se guarda en minúsculas; se muestra tal cual debe escribirse.
      mensaje($('#error-staff'), `Para entrar: ${baseUrl}/${seleccionado.slug}/staff · `
        + `código del negocio "${seleccionado.slug}", usuario "${r.staff.usuario}".`, 'exito');
      cargarStaff();
      cargarNegocios();
    } catch (e) { mensaje($('#error-staff'), e.message); }
  });

  $('#form-buscar').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    try {
      const r = await llamar(`/api/operador/clientes?negocio_id=${seleccionado.id}&q=${encodeURIComponent($('#buscar').value)}`);
      $('#tabla-clientes').replaceChildren(...(r.clientes.length ? r.clientes.map(filaCliente)
        : [el('tr', {}, el('td', { colspan: 6, class: 'suave' }, 'Sin resultados.'))]));
    } catch (e) { toast(e.message, 'error'); }
  });

  function filaCliente(c) {
    const fila = el('tr', {},
      el('td', {}, [c.nombre, c.primer_apellido, c.segundo_apellido].filter(Boolean).join(' '), el('br'),
        el('span', { class: 'suave codigo' }, c.codigo_qr)),
      el('td', {}, c.telefono),
      el('td', {}, c.correo),
      el('td', {}, `${c.sellos_actuales} (${c.premios_canjeados} canjes)`),
      el('td', { class: 'suave' }, fecha(c.acepto_terminos_en)),
      el('td', {}, botonConfirmar('Eliminar', 'Confirmar eliminación', async () => {
        try {
          await llamar(`/api/clientes/${c.id}`, { metodo: 'DELETE' });
          fila.remove();
          toast('Datos del cliente eliminados', 'exito');
          cargarNegocios();
        } catch (e) { toast(e.message, 'error'); }
      })));
    return fila;
  }

  // --- Inicio --------------------------------------------------------------
  async function abrirPanel() {
    $('#vista-login').hidden = true;
    $('#vista-panel').hidden = false;
    try {
      await Promise.all([cargarEstado(), cargarNegocios()]);
    } catch (e) {
      mensaje($('#error'), e.message);
    }
  }

  if (token) abrirPanel();
  else $('#vista-login').hidden = false;
})();
