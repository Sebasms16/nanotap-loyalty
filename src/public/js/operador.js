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
    pintarPagos();
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

  // --- Suscripciones y pagos ---------------------------------------------------
  // Las fechas son días (AAAA-MM-DD), sin hora: se cuentan en días del calendario local.
  const DIA_MS = 24 * 60 * 60 * 1000;
  const diaDe = (texto) => {
    const [y, m, d] = texto.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const hoySinHora = () => {
    const h = new Date();
    return new Date(h.getFullYear(), h.getMonth(), h.getDate());
  };
  // Suma (o resta) meses sin desbordar: el 31 de marzo menos 1 mes es el 28 de febrero.
  const sumarMeses = (f, meses) => new Date(f.getFullYear(), f.getMonth() + meses,
    Math.min(f.getDate(), new Date(f.getFullYear(), f.getMonth() + meses + 1, 0).getDate()));
  const diaCorto = (texto) => diaDe(texto).toLocaleDateString('es-CR', { day: 'numeric', month: 'short', year: 'numeric' });
  const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

  // Rojo: falta menos de un mes (o ya venció). Amarillo: menos de dos. Verde: más.
  function cuentaRegresiva(vence) {
    const hoy = hoySinHora();
    const fin = diaDe(vence);
    const dias = Math.round((fin - hoy) / DIA_MS);
    if (dias < 0) return { color: 'no', texto: `Venció hace ${plural(-dias, 'día', 'días')}` };
    if (dias === 0) return { color: 'no', texto: 'Vence hoy' };
    const color = hoy >= sumarMeses(fin, -1) ? 'no' : hoy >= sumarMeses(fin, -2) ? 'aviso' : 'si';
    let meses = 0;
    while (sumarMeses(hoy, meses + 1) <= fin) meses += 1;
    const resto = Math.round((fin - sumarMeses(hoy, meses)) / DIA_MS);
    const partes = [meses && plural(meses, 'mes', 'meses'), resto && plural(resto, 'día', 'días')].filter(Boolean);
    return { color, texto: partes.join(' y '), dias };
  }

  function pintarPagos() {
    // Primero los que vencen antes; los que no tienen suscripción anotada, al final.
    const orden = [...negocios].sort((a, b) => (a.suscripcion_vence || '9999').localeCompare(b.suscripcion_vence || '9999')
      || a.nombre.localeCompare(b.nombre));
    $('#tabla-pagos').replaceChildren(...(orden.length ? orden.map(filaPago)
      : [el('tr', {}, el('td', { colspan: 6, class: 'suave' }, 'Todavía no hay negocios.'))]));
  }

  function filaPago(n) {
    const guardar = async (cuerpo, aviso) => {
      try {
        await llamar(`/api/negocios/${n.id}`, { metodo: 'PATCH', cuerpo });
        toast(aviso, 'exito');
      } catch (e) { toast(e.message, 'error'); }
      await cargarNegocios(); // con error, vuelve a mostrar lo guardado
    };
    const plan = el('select', { 'aria-label': `Plan de ${n.nombre}` },
      el('option', { value: '' }, 'Sin plan'), el('option', { value: 'semestral' }, 'Semestral'), el('option', { value: 'anual' }, 'Anual'));
    plan.value = n.suscripcion_plan || '';
    plan.addEventListener('change', () => guardar({ suscripcion_plan: plan.value || null }, 'Plan guardado'));
    const inicio = el('input', { type: 'date', value: n.suscripcion_inicio || '', 'aria-label': `Inicio del período de ${n.nombre}` });
    inicio.addEventListener('change', () => guardar({ suscripcion_inicio: inicio.value || null }, 'Fecha guardada'));

    let falta;
    if (n.suscripcion_vence) {
      const cuenta = cuentaRegresiva(n.suscripcion_vence);
      falta = el('td', {}, el('span', { class: `insignia ${cuenta.color}` }, cuenta.texto),
        cuenta.dias > 31 ? el('span', { class: 'suave' }, ` (${cuenta.dias} días)`) : null);
    } else {
      falta = el('td', { class: 'suave' }, n.suscripcion_plan ? 'Falta la fecha' : n.suscripcion_inicio ? 'Falta el plan' : '—');
    }
    return el('tr', {},
      el('td', {}, el('strong', {}, n.nombre), n.activo ? null : el('span', { class: 'suave' }, ' (inactivo)')),
      el('td', {}, plan),
      el('td', {}, inicio),
      el('td', {}, n.suscripcion_vence ? diaCorto(n.suscripcion_vence) : '—'),
      falta,
      el('td', {}, n.suscripcion_vence
        ? botonConfirmar('Renovar', `Confirmar: desde el ${diaCorto(n.suscripcion_vence)}`,
          () => guardar({ suscripcion_inicio: n.suscripcion_vence }, `Renovado: nuevo período desde el ${diaCorto(n.suscripcion_vence)}`), '')
        : null));
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
    $('#n-fondo-foto').value = '';
    $('#n-fondo-quitar').checked = false;
    mostrarMiniatura('#n-fondo-actual', n?.fondo_estampas_url);
    $('#n-fondo-quitar-fila').hidden = !n?.fondo_estampas_url;
    $('#n-fondo-efecto').value = n?.fondo_estampas_efecto || 'nitida';
    $('#n-fondo-aviso').hidden = true;
    mostrarFondo();
    $('#n-inactividad-activa').checked = Boolean(n?.inactividad_meses);
    $('#n-inactividad-meses').value = String(n?.inactividad_meses || 3);
    mostrarInactividad();
    $('#n-sellos').value = n?.sellos_para_premio || 10;
    $('#n-premio').value = n?.descripcion_premio || 'Producto gratis';
    $('#n-niveles-activos').checked = Boolean(n?.niveles_activos);
    pintarNiveles(n);
    $('#n-temporada-meses').value = String(n?.temporada_meses || 3);
    $('#n-temporada-inicio').value = n?.temporada_inicio || primerDiaDelMes();
    mostrarNiveles();
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

  // --- Niveles por temporada -----------------------------------------------------
  // Mismos niveles y valores por defecto que el servidor (services/niveles.service.js).
  const NIVELES = [
    { clave: 'bronce', nombre: 'Bronce', emoji: '🥉', tarjetas: 0 },
    { clave: 'plata', nombre: 'Plata', emoji: '🥈', tarjetas: 2 },
    { clave: 'oro', nombre: 'Oro', emoji: '🥇', tarjetas: 4 },
    { clave: 'diamante', nombre: 'Diamante', emoji: '💎', tarjetas: 6 },
  ];
  for (let meses = 1; meses <= 12; meses++) {
    $('#n-temporada-meses').append(el('option', { value: meses }, `${meses} ${meses === 1 ? 'mes' : 'meses'}`));
  }

  function pintarNiveles(n) {
    const propios = Array.isArray(n?.niveles) ? n.niveles : [];
    const filas = NIVELES.map((nivel) => {
      const propio = propios.find((p) => p?.clave === nivel.clave) || {};
      return el('div', { class: 'fila-nivel' },
        el('span', { class: 'nombre-nivel' }, `${nivel.emoji} ${nivel.nombre}`),
        nivel.clave === 'bronce'
          ? el('span', { class: 'desde-inscripcion' }, 'Desde la inscripción')
          : el('input', {
            type: 'number', min: 1, max: 100, value: propio.tarjetas ?? nivel.tarjetas, 'data-tarjetas': nivel.clave,
            'aria-label': `Tarjetas canjeadas para llegar a ${nivel.nombre}`,
          }),
        el('input', {
          class: 'premio-nivel', type: 'text', maxlength: 120, value: propio.premio || '', 'data-premio-nivel': nivel.clave,
          placeholder: 'Igual a la descripción del premio', 'aria-label': `Premio del nivel ${nivel.nombre}`,
        }));
    });
    $('#n-niveles').replaceChildren(
      el('div', { class: 'fila-nivel encabezado' },
        el('span', {}, 'Nivel'), el('span', {}, 'Tarjetas para llegar'), el('span', {}, 'Premio de este nivel')),
      ...filas);
  }

  const nivelesActivos = () => $('#n-niveles-activos').checked;
  const premioDeNivel = (clave) => document.querySelector(`[data-premio-nivel="${clave}"]`)?.value.trim()
    || $('#n-premio').value.trim() || 'Premio';

  function primerDiaDelMes() {
    const hoy = new Date();
    return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-01`;
  }

  // Misma cuenta que el servidor: temporadas de `meses` encadenadas desde `inicio`.
  function temporadaActual(inicio, meses, hoy = new Date()) {
    const [y, m, d] = inicio.split('-').map(Number);
    const fecha = (k) => {
      const total = y * 12 + (m - 1) + k;
      const ny = Math.floor(total / 12);
      const nm = total - ny * 12;
      return new Date(ny, nm, Math.min(d, new Date(ny, nm + 1, 0).getDate()));
    };
    if (hoy < fecha(0)) return { porEmpezar: true, desde: fecha(0) };
    let k = 0;
    while (fecha((k + 1) * meses) <= hoy) k += 1;
    const siguiente = fecha((k + 1) * meses);
    return { desde: fecha(k * meses), hasta: new Date(siguiente.getFullYear(), siguiente.getMonth(), siguiente.getDate() - 1) };
  }

  function mostrarNiveles() {
    $('#n-niveles-config').hidden = !nivelesActivos();
    const inicio = $('#n-temporada-inicio').value;
    const formato = (f) => f.toLocaleDateString('es-CR', { day: 'numeric', month: 'short', year: 'numeric' });
    if (!inicio) {
      $('#n-temporada-actual').textContent = 'Si no elige una fecha, la primera temporada empieza hoy.';
      return;
    }
    const t = temporadaActual(inicio, Number($('#n-temporada-meses').value) || 3);
    $('#n-temporada-actual').textContent = t.porEmpezar
      ? `La primera temporada empieza el ${formato(t.desde)}.`
      : `Temporada actual: del ${formato(t.desde)} al ${formato(t.hasta)}. Después todos vuelven a Bronce.`;
  }
  $('#form-negocio').addEventListener('input', mostrarNiveles);

  // Lo que se envía al guardar (solo si los niveles están activos: si no, se conserva lo anterior).
  function datosDeNiveles() {
    if (!nivelesActivos()) return { niveles_activos: false };
    return {
      niveles_activos: true,
      niveles: NIVELES.map((nivel) => ({
        clave: nivel.clave,
        tarjetas: nivel.clave === 'bronce' ? 0 : Number(document.querySelector(`[data-tarjetas="${nivel.clave}"]`).value),
        premio: document.querySelector(`[data-premio-nivel="${nivel.clave}"]`).value,
      })),
      temporada_meses: Number($('#n-temporada-meses').value),
      temporada_inicio: $('#n-temporada-inicio').value || null,
    };
  }

  // --- Reinicio por inactividad --------------------------------------------------
  for (let meses = 1; meses <= 36; meses++) {
    $('#n-inactividad-meses').append(el('option', { value: meses }, `${meses} ${meses === 1 ? 'mes' : 'meses'}`));
  }
  const mesesInactividad = () => Number($('#n-inactividad-meses').value) || 3;

  function mostrarInactividad() {
    const activa = $('#n-inactividad-activa').checked;
    $('#n-inactividad-config').hidden = !activa;
    if (!activa) return;
    const limite = sumarMeses(hoySinHora(), mesesInactividad())
      .toLocaleDateString('es-CR', { day: 'numeric', month: 'long', year: 'numeric' });
    $('#n-inactividad-resumen').textContent = 'Por ejemplo: si un cliente recibe hoy una estampa y no vuelve, '
      + `sus estampas vuelven a cero el ${limite}.`;
  }
  $('#form-negocio').addEventListener('input', mostrarInactividad);

  // --- Foto de fondo de las estampas ----------------------------------------------
  // El efecto solo se elige si va a haber foto (la nueva o la guardada que no se quita).
  function mostrarFondo() {
    const hayFoto = Boolean($('#n-fondo-foto').files[0] || (editando?.fondo_estampas_url && !$('#n-fondo-quitar').checked));
    $('#n-fondo-efecto-campo').hidden = !hayFoto;
  }
  $('#form-negocio').addEventListener('input', mostrarFondo);

  // Avisa (sin bloquear) si la foto es chica o no es horizontal.
  async function revisarFoto() {
    const archivo = $('#n-fondo-foto').files[0];
    const aviso = $('#n-fondo-aviso');
    aviso.hidden = true;
    if (!archivo) return;
    const url = URL.createObjectURL(archivo);
    const problemas = [];
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const { naturalWidth: ancho, naturalHeight: alto } = img;
      if (ancho < 1000) problemas.push(`La foto mide ${ancho} × ${alto} px; con menos de 1000 px de ancho se verá borrosa en el iPhone.`);
      if (ancho / alto < 1.5) problemas.push('No es horizontal: se recortará bastante arriba y abajo.');
    } catch {
      problemas.push('No se pudo leer la foto. Pruebe con un JPG o PNG.');
    } finally {
      URL.revokeObjectURL(url);
    }
    aviso.textContent = problemas.join(' ');
    aviso.hidden = !problemas.length;
  }
  $('#n-fondo-foto').addEventListener('change', () => { revisarFoto(); mostrarFondo(); actualizarVistaPrevia(); });

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
        // Un logo alargado se usa a lo ancho: basta con que tenga 200 px de alto.
        const logoAlargado = tipo === 'logo' && ancho / alto >= PROPORCION_ANCHO;
        if (logoAlargado ? alto < 200 : Math.min(ancho, alto) < MEDIDAS[tipo]) {
          const minimo = logoAlargado ? '200 px de alto' : `${MEDIDAS[tipo]} × ${MEDIDAS[tipo]} px`;
          problemas.push(`La imagen mide ${ancho} × ${alto} px; se recomienda al menos ${minimo} para que no se vea borrosa.`);
        }
        if (!logoAlargado && Math.abs(ancho - alto) / Math.max(ancho, alto) > 0.1) {
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
    // Con niveles, arriba a la derecha va el nivel (en la vista previa, Bronce: el inicial).
    const conNiveles = nivelesActivos();
    document.querySelectorAll('.vista-tarjeta [data-premio]').forEach((n) => {
      n.textContent = conNiveles ? premioDeNivel('bronce') : premio;
    });
    document.querySelector('.vista-tarjeta [data-etiqueta-contador]').textContent = conNiveles ? 'NIVEL' : 'ESTAMPAS';
    document.querySelector('.vista-tarjeta [data-contador]').textContent = conNiveles ? '🥉 BRONCE' : `${llenos}/${total}`;
    document.querySelector('.vista-tarjeta [data-etiqueta-contador-largo]').textContent = conNiveles ? 'Nivel' : 'Estampas';
    document.querySelector('.vista-tarjeta [data-contador-largo]').textContent = conNiveles ? '🥉 Bronce' : `${llenos} / ${total}`;
    document.querySelector('.vista-tarjeta [data-faltan]').textContent = faltan === 0 ? '¡Listo!' : String(faltan);

    // Logo: el archivo recién elegido, o el guardado, o el ícono genérico.
    const archivoLogo = $('#n-logo').files[0];
    if (urlLogoPrevia) URL.revokeObjectURL(urlLogoPrevia);
    urlLogoPrevia = archivoLogo ? URL.createObjectURL(archivoLogo) : null;
    const logo = urlLogoPrevia || editando?.logo_url || null;
    const logoIos = document.querySelector('.vista-tarjeta [data-logo]');
    logoIos.hidden = !logo;
    if (logo && logoIos.getAttribute('src') !== logo) logoIos.src = logo;
    if (!logo) logoAncho = false;
    document.querySelector('.vista-tarjeta [data-logo-redondo]').src = logo
      || `/img/icono.png?tam=120&fondo=${fondo.slice(1)}&color=${texto.slice(1)}`;
    if (logo) document.querySelector('.vista-tarjeta [data-logo-ancho]').src = logo;
    mostrarCabeza();

    clearTimeout(temporizadorTira);
    temporizadorTira = setTimeout(() => pedirTira({ total, llenos, texto }), 250);
  }

  // --- Logo alargado: mismo criterio que el servidor (estampas.PROPORCION_ANCHO) ---
  // Se mide el dibujo sin su margen transparente: muchos logos anchos vienen
  // dentro de un lienzo cuadrado.
  const PROPORCION_ANCHO = 2;
  let logoAncho = false;

  function proporcionDibujo(img) {
    const escala = Math.min(1, 200 / Math.max(img.naturalWidth, img.naturalHeight));
    const ancho = Math.max(1, Math.round(img.naturalWidth * escala));
    const alto = Math.max(1, Math.round(img.naturalHeight * escala));
    const lienzo = document.createElement('canvas');
    lienzo.width = ancho;
    lienzo.height = alto;
    const ctx = lienzo.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, ancho, alto);
    const { data } = ctx.getImageData(0, 0, ancho, alto);
    let [x0, y0, x1, y1] = [ancho, alto, -1, -1];
    for (let y = 0; y < alto; y++) {
      for (let x = 0; x < ancho; x++) {
        if (data[(y * ancho + x) * 4 + 3] < 10) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    return x1 < 0 ? 1 : (x1 - x0 + 1) / (y1 - y0 + 1);
  }

  document.querySelector('.vista-tarjeta [data-logo]').addEventListener('load', (evento) => {
    try {
      logoAncho = proporcionDibujo(evento.currentTarget) >= PROPORCION_ANCHO;
    } catch {
      logoAncho = false; // imagen de otro dominio sin permiso de lectura: se asume cuadrada
    }
    mostrarCabeza();
  });

  // iPhone: el nombre se oculta si el negocio lo pide o si el logo es alargado.
  // Android: un logo alargado se ve completo en lugar del círculo.
  function mostrarCabeza() {
    document.querySelector('#tarjeta-ios [data-nombre]').style.visibility =
      $('#n-ocultar-nombre').checked || logoAncho ? 'hidden' : '';
    document.querySelector('.vista-tarjeta [data-logo-redondo]').hidden = logoAncho;
    document.querySelector('.vista-tarjeta [data-logo-ancho]').hidden = !logoAncho;
  }

  // Copia pequeña del archivo para la vista previa: a una estampa le bastan 300 px;
  // la foto de fondo ocupa toda la franja (750 px) y va en JPG.
  const reducidas = new WeakMap();
  function reducir(archivo, { maximo = 300, tipo = 'image/png' } = {}) {
    if (!reducidas.has(archivo)) {
      reducidas.set(archivo, (async () => {
        const url = URL.createObjectURL(archivo);
        try {
          const img = new Image();
          img.src = url;
          await img.decode();
          const ancho = img.naturalWidth || 300;
          const alto = img.naturalHeight || 300;
          const escala = Math.min(1, maximo / Math.max(ancho, alto));
          const lienzo = document.createElement('canvas');
          lienzo.width = Math.max(1, Math.round(ancho * escala));
          lienzo.height = Math.max(1, Math.round(alto * escala));
          lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
          return await new Promise((listo) => lienzo.toBlob((copia) => listo(copia || archivo), tipo, 0.85));
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
    const archivos = [['logo', $('#n-logo').files[0]], ['sello', $('#n-sello').files[0]], ['fondo', $('#n-fondo-foto').files[0]],
      ...nuevas.map(([posicion, { archivo }]) => [posicion, archivo])].filter(([, archivo]) => archivo);
    const quitar = [...quitadas];
    if ($('#n-sello-quitar').checked) quitar.push('sello');
    if ($('#n-fondo-quitar').checked) quitar.push('fondo');

    const numero = ++pedidoTira;
    const partes = await Promise.all(archivos.map(async ([nombre, archivo]) => [nombre,
      await (nombre === 'fondo' ? reducir(archivo, { maximo: 1000, tipo: 'image/jpeg' }) : reducir(archivo))]));
    if (numero !== pedidoTira) return;
    const parametros = new URLSearchParams({
      total, llenos, fondo: fondoSellos.slice(1), color: texto.slice(1), tarjeta: $('#n-primario').value.slice(1),
      negocio_id: editando?.id || '',
      pendientes: document.querySelector('input[name="n-pendientes"]:checked').value,
      efecto: $('#n-fondo-efecto').value,
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
      ...datosDeNiveles(),
      inactividad_meses: $('#n-inactividad-activa').checked ? mesesInactividad() : null,
      fondo_estampas_efecto: $('#n-fondo-efecto').value,
    };
    if ($('#n-sello-quitar').checked) cuerpo.sello_url = null;
    const fondo = $('#n-fondo-foto').files[0];
    if ($('#n-fondo-quitar').checked && !fondo) cuerpo.fondo_estampas_url = null;
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
      if (fondo) negocio = await subirImagen(negocio.id, 'fondo', fondo);
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
  function abrirDetalle(n, { conAnalisis = false } = {}) {
    seleccionado = n;
    $('#tabla-clientes').replaceChildren();
    $('#buscar').value = '';
    pintarDetalle();
    cargarStaff();
    $('#analisis-negocio').replaceChildren();
    analisisDe = null;
    $('#analisis-detalle').open = conAnalisis;
    if (conAnalisis) montarAnalisisNegocio();
    $('#detalle').hidden = false;
    $('#detalle').scrollIntoView({ behavior: 'smooth' });
  }

  // --- Análisis ---------------------------------------------------------------
  // Se carga recién cuando se despliega, para no pedir datos que nadie mira.
  let analisisDe = null; // id del negocio cuyo análisis está montado
  function montarAnalisisNegocio() {
    if (!seleccionado || analisisDe === seleccionado.id) return;
    analisisDe = seleccionado.id;
    window.NT.analisis.montar($('#analisis-negocio'), {
      tipo: 'negocio', ruta: `/api/operador/negocios/${seleccionado.id}/analisis`, token, alNoAutorizado: salir,
    });
  }
  $('#analisis-detalle').addEventListener('toggle', () => { if ($('#analisis-detalle').open) montarAnalisisNegocio(); });

  let analisisGeneral = null;
  $('#analisis-general').addEventListener('toggle', () => {
    if (!$('#analisis-general').open) return;
    if (analisisGeneral) return analisisGeneral.recargar();
    analisisGeneral = window.NT.analisis.montar($('#analisis-operador'), {
      tipo: 'operador',
      ruta: '/api/operador/analisis',
      token,
      alNoAutorizado: salir,
      alAbrirNegocio: (n) => abrirDetalle(negocios.find((x) => x.id === n.id) || n, { conAnalisis: true }),
    });
  });
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
    // El administrador (el dueño) además ve el análisis del negocio.
    const esAdmin = s.rol === 'administrador';
    const rol = el('button', { class: 'boton chico secundario', type: 'button' }, esAdmin ? 'Quitar administrador' : 'Hacer administrador');
    rol.addEventListener('click', async () => {
      try {
        await llamar(`/api/staff/${s.id}`, { metodo: 'PATCH', cuerpo: { rol: esAdmin ? 'staff' : 'administrador' } });
        toast(esAdmin ? 'Ya no es administrador' : 'Ahora es administrador: ve el análisis', 'exito');
        cargarStaff();
      } catch (e) { toast(e.message, 'error'); }
    });
    return el('tr', {},
      el('td', { class: 'codigo' }, s.usuario),
      el('td', {}, s.nombre || '—'),
      el('td', {}, esAdmin ? el('span', { class: 'insignia si' }, 'Administrador') : 'Staff'),
      el('td', {}, el('span', { class: `insignia ${s.activo ? 'si' : 'no'}` }, s.activo ? 'Activo' : 'Inactivo')),
      el('td', {}, reset, toggle, rol));
  }

  $('#form-staff').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const form = evento.currentTarget;
    try {
      const r = await llamar(`/api/negocios/${seleccionado.id}/staff`, {
        metodo: 'POST',
        cuerpo: {
          usuario: $('#s-usuario').value, nombre: $('#s-nombre').value, password: $('#s-password').value,
          rol: $('#s-rol').value,
        },
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
