// Panel de análisis (dueño del negocio y operador). Sin dependencias: los
// gráficos son HTML + CSS (estilos .viz-* en app.css).
//   NT.analisis.montar(contenedor, { tipo: 'negocio'|'operador', ruta, token, alNoAutorizado, alAbrirNegocio })
// Todo texto que viene de la base de datos se inserta como texto (el() de comun.js).
(function () {
  const { el, api, mensaje } = window.NT;

  const PERIODOS = [['7d', '7 días'], ['30d', '30 días'], ['90d', '90 días'], ['12m', '12 meses']];
  const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
  const numero = new Intl.NumberFormat('es-CR');
  const compacto = new Intl.NumberFormat('es-CR', { notation: 'compact', maximumFractionDigits: 1 });
  const cifra = (n) => (n >= 10000 ? compacto.format(n) : numero.format(n));
  const UN_DIA = 24 * 60 * 60 * 1000;

  // --- Fechas ---------------------------------------------------------------
  function etiquetaPeriodo(iso, unidad, corta = false) {
    const [y, m, d] = iso.split('-').map(Number);
    if (unidad === 'month') return `${MESES[m - 1]} ${corta ? String(y).slice(2) : y}`;
    if (unidad === 'week') return corta ? `${d} ${MESES[m - 1]}` : `Semana del ${d} ${MESES[m - 1]}`;
    return `${d} ${MESES[m - 1]}`;
  }

  function haceDias(iso) {
    if (!iso) return 'nunca';
    const dias = Math.floor((Date.now() - new Date(iso).getTime()) / UN_DIA);
    if (dias <= 0) return 'hoy';
    if (dias === 1) return 'ayer';
    return `hace ${dias} días`;
  }

  // --- Tooltip (uno para toda la página) ------------------------------------
  let tip = null;
  function mostrarTip(objetivo, valor, etiqueta) {
    if (!tip) {
      tip = el('div', { class: 'viz-tip', 'aria-hidden': 'true' });
      document.body.append(tip);
    }
    tip.replaceChildren(el('strong', {}, valor), el('span', {}, etiqueta));
    const r = objetivo.getBoundingClientRect();
    tip.style.left = `${r.left + r.width / 2 + window.scrollX}px`;
    tip.style.top = `${r.top + window.scrollY - 6}px`;
    tip.hidden = false;
  }
  const ocultarTip = () => { if (tip) tip.hidden = true; };

  // Marca con dato al pasar el mouse o al enfocarla con el teclado.
  function conDato(nodo, valor, etiqueta) {
    nodo.tabIndex = 0;
    nodo.setAttribute('aria-label', `${etiqueta}: ${valor}`);
    nodo.addEventListener('pointerenter', () => mostrarTip(nodo, valor, etiqueta));
    nodo.addEventListener('focus', () => mostrarTip(nodo, valor, etiqueta));
    nodo.addEventListener('pointerleave', ocultarTip);
    nodo.addEventListener('blur', ocultarTip);
    return nodo;
  }

  // Tope del eje en un número redondo (1, 2, 5 × 10ⁿ).
  function topeRedondo(max) {
    if (max <= 4) return 4;
    const base = 10 ** Math.floor(Math.log10(max));
    return [1, 2, 2.5, 5, 10].map((f) => f * base).find((v) => v >= max);
  }

  // Tabla con los mismos datos del gráfico (accesible y sin depender del mouse).
  function verDatos(columnas, filas) {
    return el('details', { class: 'viz-datos' },
      el('summary', {}, 'Ver datos'),
      el('div', { class: 'tabla-scroll' }, el('table', {},
        el('thead', {}, el('tr', {}, ...columnas.map((c) => el('th', {}, c)))),
        el('tbody', {}, ...filas.map((f) => el('tr', {}, ...f.map((v) => el('td', {}, String(v)))))))));
  }

  // --- Gráficos ---------------------------------------------------------------
  // Columnas de una sola serie a lo largo del tiempo.
  function columnas(serie, campo, unidad, unidadValor) {
    const tope = topeRedondo(Math.max(0, ...serie.map((p) => p[campo])));
    const cada = Math.max(1, Math.ceil(serie.length / 6));
    return el('div', { class: 'viz-columnas' },
      el('div', { class: 'viz-plot' },
        ...[tope, tope / 2, 0].map((v, i) => el('div', { class: 'viz-linea', style: `top: ${i * 50}%`, 'aria-hidden': 'true' },
          el('span', {}, cifra(v)))),
        el('div', { class: 'viz-barras' }, ...serie.map((p) => conDato(
          el('div', { class: 'viz-col' }, el('span', { class: 'viz-barra', style: `height: ${(p[campo] / tope) * 100}%` })),
          `${numero.format(p[campo])} ${p[campo] === 1 ? unidadValor[0] : unidadValor[1]}`,
          etiquetaPeriodo(p.periodo, unidad))))),
      el('div', { class: 'viz-ejex', 'aria-hidden': 'true' },
        ...serie.map((p, i) => el('span', {}, i % cada === 0 ? etiquetaPeriodo(p.periodo, unidad, true) : ''))),
      verDatos(['Período', unidadValor[1]], serie.map((p) => [etiquetaPeriodo(p.periodo, unidad), p[campo]])));
  }

  // Barras horizontales: [{ etiqueta, valor, nota? }].
  function barras(filas, unidadValor) {
    const max = Math.max(1, ...filas.map((f) => f.valor));
    return el('div', { class: 'viz-barrash' },
      ...filas.map((f) => el('div', { class: 'viz-fila' },
        el('span', { class: 'viz-etiqueta' }, f.etiqueta),
        conDato(el('span', { class: 'viz-pista' }, el('span', { class: 'viz-barra', style: `width: ${(f.valor / max) * 100}%` })),
          `${numero.format(f.valor)} ${f.valor === 1 ? unidadValor[0] : unidadValor[1]}`, f.etiqueta),
        el('span', { class: 'viz-valor' }, numero.format(f.valor), f.nota ? el('small', {}, ` ${f.nota}`) : null))));
  }

  // Mapa de calor día × hora (sellos), en 5 tonos de una sola escala.
  function mapaCalor(horario) {
    const horas = horario.map((h) => h.hora);
    const desde = Math.min(8, ...horas);
    const hasta = Math.max(20, ...horas);
    const lista = Array.from({ length: hasta - desde + 1 }, (_, i) => desde + i);
    const valor = new Map(horario.map((h) => [`${h.dia}-${h.hora}`, h.sellos]));
    const max = Math.max(1, ...horario.map((h) => h.sellos));
    const tono = (v) => (v ? Math.min(5, Math.ceil((v / max) * 5)) : 0);
    const columnasCss = `grid-template-columns: 2.6rem repeat(${lista.length}, minmax(0, 1fr))`;
    return el('div', { class: 'viz-calor' },
      el('div', { class: 'viz-calor-tabla', style: columnasCss },
        el('span', {}),
        ...lista.map((h) => el('span', { class: 'viz-calor-hora', 'aria-hidden': 'true' }, h % 2 === 0 ? `${h}h` : '')),
        ...DIAS.flatMap((dia, i) => [
          el('span', { class: 'viz-calor-dia' }, dia),
          ...lista.map((h) => {
            const v = valor.get(`${i + 1}-${h}`) || 0;
            return conDato(el('span', { class: `viz-celda t${tono(v)}` }),
              `${numero.format(v)} ${v === 1 ? 'sello' : 'sellos'}`, `${dia} ${h}:00 – ${h + 1}:00`);
          }),
        ])),
      el('div', { class: 'viz-leyenda', 'aria-hidden': 'true' }, 'Menos',
        ...[0, 1, 2, 3, 4, 5].map((t) => el('span', { class: `viz-celda t${t}` })), 'Más'),
      verDatos(['Día', 'Hora', 'Sellos'], horario.slice().sort((a, b) => b.sellos - a.sellos)
        .map((h) => [DIAS[h.dia - 1], `${h.hora}:00`, h.sellos])));
  }

  // --- Cifras -----------------------------------------------------------------
  // Variación contra el período anterior (subir es bueno en todas estas cifras).
  function variacion(actual, anterior) {
    if (anterior === undefined || anterior === null) return null;
    if (anterior === 0) return actual > 0 ? el('span', { class: 'viz-delta sube' }, '▲ nuevo en este período') : null;
    const pct = Math.round(((actual - anterior) / anterior) * 100);
    if (pct === 0) return el('span', { class: 'viz-delta' }, '= igual que el período anterior');
    return el('span', { class: `viz-delta ${pct > 0 ? 'sube' : 'baja'}` },
      `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)} % vs. período anterior`);
  }

  function cifraTarjeta(etiqueta, valor, { anterior, detalle } = {}) {
    return el('div', { class: 'viz-kpi' },
      el('span', { class: 'viz-kpi-etiqueta' }, etiqueta),
      el('span', { class: 'viz-kpi-valor' }, typeof valor === 'number' ? cifra(valor) : valor),
      variacion(typeof valor === 'number' ? valor : 0, anterior),
      detalle ? el('span', { class: 'viz-kpi-detalle' }, detalle) : null);
  }

  const tarjeta = (titulo, ayuda, ...hijos) => el('section', { class: 'tarjeta viz-tarjeta' },
    el('h3', {}, titulo), ayuda ? el('p', { class: 'suave viz-ayuda' }, ayuda) : null, ...hijos);
  const vacio = (texto) => el('p', { class: 'suave viz-vacio' }, texto);
  const dosColumnas = (...hijos) => el('div', { class: 'viz-dos' }, ...hijos);

  // Contacto rápido: llamar o escribir por WhatsApp (teléfonos de Costa Rica).
  const contacto = (telefono) => el('span', { class: 'viz-contacto' },
    el('a', { href: `tel:+506${telefono}` }, telefono), ' · ',
    el('a', { href: `https://wa.me/506${telefono}`, target: '_blank', rel: 'noopener' }, 'WhatsApp'));

  function tablaClientes(columnas, filas) {
    return el('div', { class: 'tabla-scroll' }, el('table', {},
      el('thead', {}, el('tr', {}, ...columnas.map((c) => el('th', {}, c)))),
      el('tbody', {}, ...filas.map((f) => el('tr', {}, ...f.map((v) => el('td', {}, v)))))));
  }

  const nombreUnidad = { day: 'Por día', week: 'Por semana', month: 'Por mes' };

  // --- Panel del negocio --------------------------------------------------------
  function pintarNegocio(d) {
    const r = d.resumen;
    const a = d.anterior;
    const meta = d.negocio.sellos_para_premio;
    const retorno = r.clientes_activos ? Math.round((r.recurrentes / r.clientes_activos) * 100) : 0;
    const partes = [];

    partes.push(el('div', { class: 'viz-kpis' },
      cifraTarjeta('Clientes que vinieron', r.clientes_activos, { anterior: a.clientes_activos }),
      cifraTarjeta('Sellos dados', r.sellos, { anterior: a.sellos }),
      cifraTarjeta('Clientes nuevos', r.clientes_nuevos, { anterior: a.clientes_nuevos }),
      cifraTarjeta('Premios canjeados', r.canjes, { anterior: a.canjes }),
      cifraTarjeta('Regresaron 2 veces o más', `${retorno} %`,
        { detalle: `${numero.format(r.recurrentes)} de ${numero.format(r.clientes_activos)} clientes` }),
      cifraTarjeta('Clientes inscritos', r.clientes_total,
        { detalle: `${numero.format(r.iphone)} con la tarjeta en iPhone · ${numero.format(r.premios_pendientes)} con premio listo` })));

    partes.push(tarjeta('Actividad', `${nombreUnidad[d.periodo.unidad]}. Pase el cursor por una barra para ver el dato.`,
      dosColumnas(
        el('div', {}, el('h4', {}, 'Sellos dados'), columnas(d.serie, 'sellos', d.periodo.unidad, ['sello', 'sellos'])),
        el('div', {}, el('h4', {}, 'Clientes nuevos'), columnas(d.serie, 'nuevos', d.periodo.unidad, ['cliente', 'clientes'])))));

    partes.push(tarjeta('¿Cuándo vienen sus clientes?', 'Sellos por día de la semana y hora. Más oscuro = más movimiento.',
      d.horario.length ? mapaCalor(d.horario) : vacio('Todavía no hay sellos en este período.')));

    const progreso = d.progreso.map((p) => ({
      etiqueta: p.sellos >= meta ? 'Premio listo' : `${p.sellos} de ${meta}`,
      valor: p.clientes,
      nota: p.sellos < meta && meta - p.sellos <= 2 ? '· cerca del premio' : '',
    })).reverse();
    const bloques = [tarjeta('¿Qué tan cerca del premio están?', 'Clientes según las estampas que llevan hoy.',
      progreso.length ? barras(progreso, ['cliente', 'clientes']) : vacio('Todavía no hay clientes inscritos.'))];
    if (d.niveles) {
      bloques.push(tarjeta('Niveles de esta temporada', `La temporada termina el ${d.niveles.fin}.`,
        barras(d.niveles.niveles.map((n) => ({ etiqueta: `${n.emoji} ${n.nombre}`, valor: n.clientes })), ['cliente', 'clientes'])));
    }
    partes.push(dosColumnas(...bloques));

    partes.push(tarjeta('Sus clientes más fieles', 'Los que más sellos sumaron en este período.',
      d.mejores.length
        ? tablaClientes(['Cliente', 'Teléfono', 'Sellos', 'Canjes', 'Última visita'],
          d.mejores.map((c) => [c.nombre, contacto(c.telefono), String(c.sellos), String(c.canjes), haceDias(c.ultima)]))
        : vacio('Todavía no hay sellos en este período.')));

    partes.push(tarjeta('Clientes que dejaron de venir',
      'Vinieron antes, pero no en los últimos 30 días. Primero los que más estampas llevan: un mensaje puede traerlos de vuelta.',
      d.en_riesgo.length
        ? tablaClientes(['Cliente', 'Teléfono', 'Estampas', 'Última visita'],
          d.en_riesgo.map((c) => [c.nombre, contacto(c.telefono), `${c.sellos_actuales} de ${meta}`, haceDias(c.ultima)]))
        : vacio('Ningún cliente lleva más de 30 días sin venir.')));

    const fila = [];
    fila.push(tarjeta('Cumpleaños de este mes', 'Clientes que dieron su fecha de nacimiento al inscribirse.',
      d.cumpleanos.length
        ? tablaClientes(['Cliente', 'Día', 'Teléfono'], d.cumpleanos.map((c) => [c.nombre, String(c.dia), contacto(c.telefono)]))
        : vacio('Nadie cumple años este mes.')));
    fila.push(tarjeta('Su equipo', 'Sellos y canjes que registró cada colaborador en este período.',
      d.staff.length
        ? barras(d.staff.map((s) => ({ etiqueta: s.nombre, valor: s.sellos, nota: s.canjes ? `· ${s.canjes} canjes` : '' })), ['sello', 'sellos'])
        : vacio('Todavía no hay sellos en este período.')));
    partes.push(dosColumnas(...fila));

    if (r.sin_volver) {
      partes.push(el('p', { class: 'suave viz-nota' },
        `${numero.format(r.sin_volver)} ${r.sin_volver === 1 ? 'cliente se inscribió' : 'clientes se inscribieron'} pero todavía no ha sumado ningún sello.`));
    }
    return partes;
  }

  // --- Panel del operador -----------------------------------------------------
  function pintarOperador(d, alAbrirNegocio) {
    const r = d.resumen;
    const a = d.anterior;
    const partes = [];
    partes.push(el('div', { class: 'viz-kpis' },
      cifraTarjeta('Negocios activos', r.negocios_activos, { detalle: `de ${numero.format(r.negocios)} en total` }),
      cifraTarjeta('Clientes que vinieron', r.clientes_activos, { anterior: a.clientes_activos }),
      cifraTarjeta('Sellos dados', r.sellos, { anterior: a.sellos }),
      cifraTarjeta('Clientes nuevos', r.clientes_nuevos, { anterior: a.clientes_nuevos }),
      cifraTarjeta('Premios canjeados', r.canjes, { anterior: a.canjes }),
      cifraTarjeta('Clientes inscritos', r.clientes_total, { detalle: `${numero.format(r.iphone)} con la tarjeta en iPhone` })));

    partes.push(tarjeta('Actividad de todos los negocios', `${nombreUnidad[d.periodo.unidad]}.`,
      dosColumnas(
        el('div', {}, el('h4', {}, 'Sellos dados'), columnas(d.serie, 'sellos', d.periodo.unidad, ['sello', 'sellos'])),
        el('div', {}, el('h4', {}, 'Clientes nuevos'), columnas(d.serie, 'nuevos', d.periodo.unidad, ['cliente', 'clientes'])))));

    // Un negocio activo sin sellos en 7 días merece una llamada de soporte.
    const alerta = (n) => {
      if (!n.activo) return el('span', { class: 'insignia no' }, 'Inactivo');
      const dias = n.ultima ? Math.floor((Date.now() - new Date(n.ultima).getTime()) / UN_DIA) : null;
      if (dias === null) return el('span', { class: 'insignia aviso' }, 'Sin sellos todavía');
      if (dias >= 7) return el('span', { class: 'insignia aviso' }, `Sin movimiento hace ${dias} días`);
      return el('span', { class: 'insignia si' }, 'Activo');
    };
    const negocios = d.negocios.slice().sort((x, y) => y.sellos - x.sellos);
    partes.push(tarjeta('Por negocio', 'Ordenados por sellos del período. La alerta marca negocios activos sin movimiento en 7 días.',
      el('div', { class: 'tabla-scroll' }, el('table', {},
        el('thead', {}, el('tr', {}, ...['Negocio', 'Clientes', 'Nuevos', 'Vinieron', 'Sellos', 'Canjes', 'Último sello', 'Estado', '']
          .map((c) => el('th', {}, c)))),
        el('tbody', {}, ...negocios.map((n) => el('tr', {},
          el('td', {}, el('strong', {}, n.nombre)),
          el('td', { class: 'num' }, numero.format(n.clientes)),
          el('td', { class: 'num' }, numero.format(n.nuevos)),
          el('td', { class: 'num' }, numero.format(n.activos)),
          el('td', { class: 'num' }, numero.format(n.sellos)),
          el('td', { class: 'num' }, numero.format(n.canjes)),
          el('td', {}, haceDias(n.ultima)),
          el('td', {}, alerta(n)),
          el('td', {}, alAbrirNegocio
            ? el('button', { class: 'boton chico secundario', type: 'button', onclick: () => alAbrirNegocio(n) }, 'Ver análisis')
            : null))))))));
    return partes;
  }

  // --- Montaje: filtro de período + contenido -------------------------------------
  function montar(contenedor, { tipo, ruta, token, alNoAutorizado, alAbrirNegocio }) {
    let periodo = '30d';
    const filtros = el('div', { class: 'viz-filtros', role: 'group', 'aria-label': 'Período' });
    const cuerpo = el('div', { class: 'viz-cuerpo' });
    const error = el('div', { class: 'mensaje error', hidden: true });
    contenedor.replaceChildren(filtros, error, cuerpo);

    function pintarFiltros() {
      filtros.replaceChildren(el('span', { class: 'suave' }, 'Período:'), ...PERIODOS.map(([clave, nombre]) => el('button', {
        type: 'button',
        class: 'boton chico secundario',
        'aria-pressed': String(clave === periodo),
        onclick: () => { periodo = clave; cargar(); },
      }, nombre)));
    }

    async function cargar() {
      pintarFiltros();
      cuerpo.classList.add('cargando'); // mantiene lo anterior, atenuado, mientras llega lo nuevo
      try {
        const datos = await api(`${ruta}?periodo=${periodo}`, { token });
        cuerpo.replaceChildren(...(tipo === 'operador' ? pintarOperador(datos, alAbrirNegocio) : pintarNegocio(datos)));
        mensaje(error, '');
      } catch (e) {
        if (e.status === 401 && alNoAutorizado) return alNoAutorizado();
        mensaje(error, e.message);
      } finally {
        cuerpo.classList.remove('cargando');
      }
    }
    cargar();
    return { recargar: cargar };
  }

  window.NT.analisis = { montar };
})();
