// Utilidades compartidas por todas las páginas (sin frameworks).
(function () {
  const $ = (selector, raiz = document) => raiz.querySelector(selector);

  // fetch JSON con mensaje de error en español.
  async function api(ruta, { metodo = 'GET', cuerpo, token } = {}) {
    const cabeceras = {};
    if (cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json';
    if (token) cabeceras.Authorization = `Bearer ${token}`;
    let respuesta;
    try {
      respuesta = await fetch(ruta, {
        method: metodo,
        headers: cabeceras,
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      });
    } catch {
      throw Object.assign(new Error('No hay conexión. Revise su internet e intente de nuevo.'), { status: 0 });
    }
    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) {
      throw Object.assign(new Error(datos.error || 'Ocurrió un error. Intente de nuevo.'), { status: respuesta.status });
    }
    return datos;
  }

  // Crea elementos sin innerHTML (evita XSS con datos de clientes).
  function el(etiqueta, atributos = {}, ...hijos) {
    const nodo = document.createElement(etiqueta);
    for (const [clave, valor] of Object.entries(atributos)) {
      if (valor === null || valor === undefined || valor === false) continue;
      if (clave === 'class') nodo.className = valor;
      else if (clave.startsWith('on')) nodo.addEventListener(clave.slice(2), valor);
      else nodo.setAttribute(clave, valor === true ? '' : valor);
    }
    for (const hijo of hijos.flat()) {
      if (hijo === null || hijo === undefined || hijo === false) continue;
      nodo.append(hijo instanceof Node ? hijo : document.createTextNode(String(hijo)));
    }
    return nodo;
  }

  let temporizadorToast;
  function toast(texto, tipo = '') {
    let nodo = $('#toast');
    if (!nodo) {
      nodo = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
      document.body.append(nodo);
    }
    nodo.className = `toast ${tipo}`;
    nodo.textContent = texto;
    nodo.hidden = false;
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(() => { nodo.hidden = true; }, 3000);
  }

  function mensaje(contenedor, texto, tipo = 'error') {
    contenedor.className = `mensaje ${tipo}`;
    contenedor.textContent = texto;
    contenedor.hidden = !texto;
  }

  // Aplica los colores del negocio a la página.
  function aplicarMarca(negocio) {
    const raiz = document.documentElement.style;
    if (negocio.color_primario) raiz.setProperty('--marca', negocio.color_primario);
    if (negocio.color_secundario) raiz.setProperty('--marca-texto', negocio.color_secundario);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && negocio.color_primario) meta.content = negocio.color_primario;
  }

  // Círculos de sellos (llenos/vacíos).
  function circulosSellos(llenos, total) {
    const contenedor = el('div', { class: 'sellos', 'aria-label': `${llenos} de ${total} sellos` });
    for (let i = 0; i < total; i++) contenedor.append(el('span', { class: i < llenos ? 'lleno' : '' }));
    return contenedor;
  }

  // Slug del negocio desde la URL: /{slug}/inscripcion
  const slugDeRuta = () => decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] || '');

  const almacen = {
    leer(clave) { try { return localStorage.getItem(clave); } catch { return null; } },
    guardar(clave, valor) { try { localStorage.setItem(clave, valor); } catch { /* sin almacenamiento */ } },
    borrar(clave) { try { localStorage.removeItem(clave); } catch { /* sin almacenamiento */ } },
  };

  // Descarga un archivo de una ruta protegida por token (exportación CSV).
  async function descargar(ruta, token) {
    const r = await fetch(ruta, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const datos = await r.json().catch(() => ({}));
      throw new Error(datos.error || 'No se pudo descargar el archivo.');
    }
    const nombre = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'export.csv';
    const url = URL.createObjectURL(await r.blob());
    const a = el('a', { href: url, download: nombre });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.NT = { $, api, el, toast, mensaje, aplicarMarca, circulosSellos, slugDeRuta, almacen, descargar };
})();
