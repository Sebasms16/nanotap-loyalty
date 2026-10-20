require('./helpers/entorno').configurar();

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const jwt = require('jsonwebtoken');
const env = require('../src/config/env');
const v = require('../src/utils/validacion');
const { aCsv } = require('../src/utils/csv');
const { generarCodigo } = require('../src/services/qrcode.service');
const imagen = require('../src/services/imagen.service');
const googleWallet = require('../src/services/googleWallet.service');
const appleWallet = require('../src/services/appleWallet.service');

const negocio = {
  id: '11111111-1111-4111-8111-111111111111',
  nombre: 'PodoSport',
  slug: 'podosport',
  logo_url: null,
  color_primario: '#123456',
  color_secundario: '#ffffff',
  sellos_para_premio: 8,
  descripcion_premio: 'Café gratis',
  activo: true,
};
const cliente = {
  id: '22222222-2222-4222-8222-222222222222',
  negocio_id: negocio.id,
  nombre: 'Ana',
  primer_apellido: 'Mora',
  codigo_qr: 'POD-2026-D5471AC9',
  sellos_actuales: 8,
  premios_canjeados: 1,
};

test('teléfonos de Costa Rica se normalizan', () => {
  assert.equal(v.normalizarTelefono('+506 8888-7777'), '88887777');
  assert.equal(v.normalizarTelefono('8888 7777'), '88887777');
  assert.equal(v.telefono('(506) 2222-3333'), '22223333');
  assert.throws(() => v.telefono('123'), /teléfono válido/);
});

test('validaciones de slug, color, correo y fecha', () => {
  assert.equal(v.slug('PodoSport'), 'podosport');
  assert.throws(() => v.slug('api'));
  assert.throws(() => v.slug('con espacio'));
  assert.equal(v.color('#AABBCC', 'c'), '#aabbcc');
  assert.throws(() => v.color('rojo', 'c'));
  assert.equal(v.correo(' Ana@Example.com '), 'ana@example.com');
  assert.throws(() => v.correo('ana@'));
  assert.equal(v.fecha('1990-05-20', 'f'), '1990-05-20');
  assert.throws(() => v.fecha('2999-01-01', 'f'));
  assert.throws(() => v.urlHttps('http://inseguro.com/logo.png', 'logo'));
});

test('código QR con prefijo del negocio, año y 8 hex', () => {
  const codigo = generarCodigo('podosport');
  assert.match(codigo, new RegExp(`^POD-${new Date().getFullYear()}-[0-9A-F]{8}$`));
  assert.match(generarCodigo('9-9'), /^NAN-/);
});

test('CSV con BOM, escapes y protección contra fórmulas', () => {
  const csv = aCsv(
    [{ titulo: 'nombre', valor: (f) => f.n }, { titulo: 'nota', valor: (f) => f.x }],
    [{ n: 'Ana, "la jefa"', x: '=HYPERLINK("malo")' }]
  );
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(csv.slice(1), 'nombre,nota\r\n"Ana, ""la jefa""","\'=HYPERLINK(""malo"")"\r\n');
});

test('la tira de sellos es un PNG válido del tamaño pedido', () => {
  const png = imagen.tiraSellos({ total: 10, llenos: 3, fondo: '#1a1a2e', sello: '#ffffff', ancho: 750, alto: 246 });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 750);
  assert.equal(png.readUInt32BE(20), 246);
  // El IDAT se descomprime al tamaño exacto: (ancho*3 + 1 byte de filtro) * alto
  const largoIdat = png.readUInt32BE(33);
  const idat = png.subarray(41, 41 + largoIdat);
  assert.equal(zlib.inflateSync(idat).length, (750 * 3 + 1) * 246);
});

test('objeto de Google Wallet refleja sellos y premio disponible', () => {
  const objeto = googleWallet.construirObjeto(cliente, negocio);
  assert.equal(objeto.id, `${env.google.issuerId}.cliente-${cliente.id}`);
  assert.equal(objeto.classId, `${env.google.issuerId}.negocio-${negocio.id}`);
  assert.equal(objeto.barcode.value, cliente.codigo_qr);
  assert.equal(objeto.loyaltyPoints.label, 'Estampas');
  assert.equal(objeto.loyaltyPoints.balance.string, '8 / 8');
  assert.equal(objeto.secondaryLoyaltyPoints.balance.string, 'Café gratis');
  assert.equal(objeto.textModulesData[0].header, '¡Premio disponible!');
  const prefijo = `https://loyalty.test/img/negocios/${negocio.id}/estampas.png?llenos=8&v=`;
  assert.ok(objeto.heroImage.sourceUri.uri.startsWith(prefijo), objeto.heroImage.sourceUri.uri);

  const pocos = googleWallet.construirObjeto({ ...cliente, sellos_actuales: 3 }, negocio);
  assert.equal(pocos.textModulesData[0].body, '5 estampas para su premio: Café gratis.');
  // Cambiar la marca cambia la URL de la imagen, para que Google no reuse su caché.
  const otraMarca = googleWallet.construirObjeto(cliente, { ...negocio, color_fondo_sellos: '#ffffff' });
  assert.notEqual(otraMarca.heroImage.sourceUri.uri, objeto.heroImage.sourceUri.uri);

  const clase = googleWallet.construirClase(negocio);
  assert.match(clase.programLogo.sourceUri.uri, /\/img\/icono\.png\?fondo=123456&color=ffffff/);
});

test('link de Google Wallet es un JWT RS256 "savetowallet" verificable', () => {
  const url = googleWallet.linkGuardar('3388000000012345678.cliente-x');
  assert.match(url, /^https:\/\/pay\.google\.com\/gp\/v\/save\//);
  const token = url.split('/').pop();
  const publica = require('node:crypto').createPublicKey(env.google.serviceAccount.private_key);
  const payload = jwt.verify(token, publica, { algorithms: ['RS256'] });
  assert.equal(payload.aud, 'google');
  assert.equal(payload.typ, 'savetowallet');
  assert.deepEqual(payload.origins, ['https://loyalty.test']);
  assert.deepEqual(payload.payload.loyaltyObjects, [{ id: '3388000000012345678.cliente-x' }]);
});

test('el .pkpass de Apple se firma e incluye pass.json, imágenes y web service', async () => {
  const pass = { serial_number: 'serial-prueba', auth_token: 'a'.repeat(48), ultima_actualizacion: new Date().toISOString() };
  const buffer = await appleWallet.generarPass({ cliente: { ...cliente, sellos_actuales: 5 }, negocio, pass });
  const archivos = leerZip(buffer);
  for (const f of ['pass.json', 'manifest.json', 'signature', 'icon.png', 'icon@2x.png', 'strip@2x.png']) {
    assert.ok(archivos[f], `el .pkpass no contiene ${f}`);
  }

  const json = JSON.parse(archivos['pass.json'].toString('utf8'));
  assert.equal(json.serialNumber, 'serial-prueba');
  assert.equal(json.passTypeIdentifier, 'pass.cr.nanotap.prueba');
  assert.equal(json.teamIdentifier, 'ABCDE12345');
  assert.equal(json.webServiceURL, 'https://loyalty.test/api/wallet/apple');
  assert.equal(json.authenticationToken, 'a'.repeat(48));
  assert.equal(json.backgroundColor, 'rgb(18, 52, 86)');
  assert.equal(json.logoText, 'PodoSport');
  const sinNombre = leerZip(await appleWallet.generarPass({ cliente, negocio: { ...negocio, ocultar_nombre: true }, pass }));
  assert.equal(JSON.parse(sinNombre['pass.json'].toString('utf8')).logoText, undefined);
  assert.equal(json.storeCard.headerFields[0].value, '5/8');
  assert.equal(json.storeCard.secondaryFields[0].value, 'Café gratis');
  assert.equal(json.storeCard.secondaryFields[1].value, 3);
  assert.deepEqual(json.storeCard.backFields.slice(0, 2).map((c) => c.value), ['Ana Mora', 1]);
  const reglasReverso = json.storeCard.backFields.find((c) => c.key === 'reglas');
  assert.match(reglasReverso.value, /^• Recibe una estampa por cada compra en PodoSport/);
  assert.match(reglasReverso.value, /\n• El premio no se puede cambiar por dinero/);
  assert.equal(json.barcodes[0].message, cliente.codigo_qr);

  // El manifest debe tener el SHA-1 correcto de cada archivo (si no, el iPhone lo rechaza).
  const manifest = JSON.parse(archivos['manifest.json'].toString('utf8'));
  for (const [nombre, sha1] of Object.entries(manifest)) {
    assert.equal(require('node:crypto').createHash('sha1').update(archivos[nombre]).digest('hex'), sha1, nombre);
  }
});

// Lector mínimo de zip (passkit-generator guarda los archivos sin comprimir).
function leerZip(buffer) {
  const archivos = {};
  let i = 0;
  while (buffer.readUInt32LE(i) === 0x04034b50) {
    const metodo = buffer.readUInt16LE(i + 8);
    const tamano = buffer.readUInt32LE(i + 18);
    const largoNombre = buffer.readUInt16LE(i + 26);
    const largoExtra = buffer.readUInt16LE(i + 28);
    const nombre = buffer.subarray(i + 30, i + 30 + largoNombre).toString('utf8');
    const inicio = i + 30 + largoNombre + largoExtra;
    const datos = buffer.subarray(inicio, inicio + tamano);
    archivos[nombre] = metodo === 8 ? zlib.inflateRawSync(datos) : datos;
    i = inicio + tamano;
  }
  return archivos;
}

test('RNF-10: reporta días para el vencimiento de los certificados', () => {
  const estado = appleWallet.estadoCertificados();
  assert.equal(estado.length, 2);
  for (const c of estado) assert.ok(c.dias >= 18 && c.dias <= 20, `días inesperados: ${c.dias}`);
});

test('estampas con logo: obtenidas a color y pendientes en gris', async () => {
  const sharp = require('sharp');
  const { tiraConImagenes } = require('../src/services/estampas.service');
  const logo = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 220, g: 30, b: 30, alpha: 1 } } })
    .png().toBuffer();
  const png = await tiraConImagenes({ imagenes: [logo, logo, logo, logo], total: 4, llenos: 2, fondo: '#ffffff', ancho: 750, alto: 246 });
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 750);
  assert.equal(info.height, 246);

  // Una fila de 4 estampas centrada: se mide el centro de la 1.ª (obtenida) y la 4.ª (pendiente).
  const pixel = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const { celda, centros } = imagen.distribuirEstampas(4, 750, 246);
  const x0 = Math.round(centros[0].x);
  const x3 = Math.round(centros[3].x);
  const [r1, g1, b1] = pixel(x0, 123);
  const [r4, g4, b4] = pixel(x3, 123);
  assert.ok(r1 > 180 && g1 < 80 && b1 < 80, `la obtenida debería ser roja: ${r1},${g1},${b1}`);
  assert.ok(Math.abs(r4 - g4) < 6 && Math.abs(g4 - b4) < 6, `la pendiente debería ser gris: ${r4},${g4},${b4}`);
  assert.ok(r4 > 150, 'la pendiente debería ser tenue (casi el fondo)');

  // Sin aro: entre dos estampas y en las esquinas solo se ve el fondo.
  const entreEstampas = pixel(Math.round(x0 + celda / 2), 123);
  assert.deepEqual(entreEstampas, [255, 255, 255]);
  assert.deepEqual(pixel(2, 2), [255, 255, 255]);
});

test('logo para Google: cuadrado con margen sobre el color de la tarjeta', async () => {
  const sharp = require('sharp');
  const { logoParaGoogle } = require('../src/services/estampas.service');
  const logo = await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } })
    .png().toBuffer();
  const png = await logoParaGoogle(logo, '#123456');
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 660);
  assert.equal(info.height, 660);
  assert.deepEqual([...data.subarray(0, 3)], [0x12, 0x34, 0x56]); // esquina: color de la tarjeta
  const centro = (330 * 660 + 330) * info.channels;
  assert.deepEqual([...data.subarray(centro, centro + 3)], [0, 0, 255]); // centro: el logo
});

test('sin logo, la zona de estampas usa los círculos de color', async () => {
  const marca = require('../src/services/marca.service');
  const png = await marca.tiraDelNegocio({ ...negocio, logo_url: null, sello_url: null }, 3);
  assert.equal(png.readUInt32BE(16), 750);
});

test('logo alargado: se detecta sin su margen y se usa a lo ancho en Apple y Google', async () => {
  const sharp = require('sharp');
  const estampas = require('../src/services/estampas.service');
  // Logo de 2,5:1 dentro de un lienzo cuadrado transparente (como se suelen exportar).
  const logo = await sharp({ create: { width: 600, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: { create: { width: 500, height: 200, channels: 4, background: '#e53935' } }, left: 50, top: 200 }])
    .png().toBuffer();
  assert.ok(Math.abs(await estampas.proporcionLogo(logo) - 2.5) < 0.05);

  // Google: 1280 × 400, alineado a la izquierda (el logo queda de 1000 × 400).
  const ancho = await estampas.logoAnchoParaGoogle(logo);
  const { data, info } = await sharp(ancho).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [1280, 400]);
  const alfa = (x, y) => data[(y * info.width + x) * 4 + 3];
  assert.equal(alfa(10, 200), 255); // empieza a la izquierda
  assert.equal(alfa(1270, 200), 0); // a la derecha queda transparente

  const clase = googleWallet.construirClase({ ...negocio, logo_url: 'https://x/logo.png' }, { logoAncho: true });
  assert.match(clase.wideProgramLogo.sourceUri.uri, /\/img\/negocios\/.+\/logo-ancho\.png\?v=/);
  assert.equal(googleWallet.construirClase(negocio).wideProgramLogo, undefined);

  // Apple: sin el nombre al lado del logo (el Buffer hace de URL ya descargada).
  const pass = { serial_number: 's', auth_token: 'a'.repeat(48), ultima_actualizacion: new Date().toISOString() };
  const zip = leerZip(await appleWallet.generarPass({ cliente, negocio: { ...negocio, logo_url: logo }, pass }));
  assert.equal(JSON.parse(zip['pass.json'].toString('utf8')).logoText, undefined);
});

test('logo con fondo sólido: conserva su margen y redondea las esquinas', async () => {
  const sharp = require('sharp');
  const { logoEncabezado } = require('../src/services/estampas.service');
  // Fondo blanco opaco con un cuadro negro al centro (como un logo en JPG).
  const logo = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ffffff' } })
    .composite([{ input: { create: { width: 200, height: 200, channels: 3, background: '#000000' } }, left: 100, top: 100 }])
    .png().toBuffer();
  const png = await logoEncabezado(logo, 2); // 100 × 100
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
  assert.equal(info.width, 100);
  assert.equal(pixel(0, 0)[3], 0); // esquina redondeada: transparente
  assert.deepEqual(pixel(12, 50), [255, 255, 255, 255]); // el margen blanco se conserva (no se recortó)
  assert.deepEqual(pixel(50, 50), [0, 0, 0, 255]);
});

test('estampas: ninguna cae en los bordes que el iPhone recorta', () => {
  // La tarjeta se ve de ~340 pt de ancho y el strip mide 375 pt: iOS recorta ~17 pt por lado.
  for (const ancho of [375, 750, 1125]) {
    const alto = Math.round((ancho * 123) / 375);
    const recorte = (ancho * 20) / 375; // margen con holgura
    for (let total = 1; total <= 30; total++) {
      const { celda, centros } = imagen.distribuirEstampas(total, ancho, alto);
      const mitad = (celda * 0.84) / 2; // la estampa ocupa el 84 % de su celda
      for (const { x } of centros) {
        assert.ok(x - mitad >= recorte && x + mitad <= ancho - recorte, `${total} estampas a ${ancho} px: x=${x}`);
      }
    }
  }
});

test('estampas: una imagen por posición y pendientes en gris u ocultas', async () => {
  const sharp = require('sharp');
  const marca = require('../src/services/marca.service');
  const cuadro = (r, g, b) => sharp({ create: { width: 300, height: 300, channels: 4, background: { r, g, b, alpha: 1 } } })
    .png().toBuffer();
  const rojo = await cuadro(255, 0, 0);
  const azul = await cuadro(0, 0, 255);
  // Color en el centro de cada estampa: 4 estampas en una fila sobre 750 × 246.
  const posiciones = imagen.distribuirEstampas(4, 750, 246).centros;
  const centros = async (png) => {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    return posiciones.map(({ x, y }) => {
      const p = (Math.round(y) * info.width + Math.round(x)) * info.channels;
      return [...data.subarray(p, p + 3)];
    });
  };
  // Los Buffers hacen de URLs ya descargadas (como en la vista previa del panel).
  const base = { ...negocio, sellos_para_premio: 4, color_fondo_sellos: '#000000', sello_url: rojo, estampas_urls: [null, azul] };

  const [primera, segunda, tercera, cuarta] = await centros(await marca.tiraDelNegocio(base, 2));
  assert.deepEqual(primera, [255, 0, 0]); // sin imagen propia: la general, a color
  assert.deepEqual(segunda, [0, 0, 255]); // con imagen propia
  assert.ok(tercera[0] > 0 && tercera[0] < 60 && tercera[0] === tercera[1]); // pendiente: gris tenue
  assert.deepEqual(cuarta, tercera);

  const ocultas = await centros(await marca.tiraDelNegocio({ ...base, estampas_pendientes: 'ocultas' }, 2));
  assert.deepEqual(ocultas.slice(0, 2), [[255, 0, 0], [0, 0, 255]]);
  assert.deepEqual(ocultas.slice(2), [[0, 0, 0], [0, 0, 0]]); // círculo vacío: se ve el fondo

  // Cambiar las imágenes por estampa o el modo cambia la versión (Google descarga de nuevo).
  const sinUrls = { ...negocio, estampas_urls: [] };
  assert.notEqual(marca.versionTira({ ...sinUrls, estampas_urls: ['https://x/1.png'] }), marca.versionTira(sinUrls));
  assert.notEqual(marca.versionTira({ ...sinUrls, estampas_pendientes: 'ocultas' }), marca.versionTira(sinUrls));
});

test('reglas del programa: sugeridas, propias y normalización al guardar', () => {
  const reglas = require('../src/utils/reglas');
  const sugeridas = reglas.reglasSugeridas(negocio);
  assert.match(sugeridas[1], /Al completar 8 estampas recibe: Café gratis/);
  assert.ok(sugeridas.some((r) => /dinero en efectivo/.test(r)));
  assert.deepEqual(reglas.reglasDelNegocio({ ...negocio, reglas: null }), sugeridas);

  // Viñetas y numeración se limpian; líneas vacías se ignoran.
  assert.deepEqual(reglas.aLista('• Uno\n\n2) Dos\n- Tres '), ['Uno', 'Dos', 'Tres']);
  assert.deepEqual(reglas.reglasDelNegocio({ ...negocio, reglas: 'Solo los martes' }), ['Solo los martes']);

  // Vacías o iguales a las sugeridas se guardan como null (siguen al día con el negocio).
  assert.equal(reglas.paraGuardar('', negocio), null);
  assert.equal(reglas.paraGuardar(sugeridas.map((r) => `• ${r}`).join('\n'), negocio), null);
  assert.equal(reglas.paraGuardar('Solo los martes\nUna por día', negocio), 'Solo los martes\nUna por día');
  assert.equal(reglas.reglasComoTexto({ ...negocio, reglas: 'A\nB' }), '• A\n• B');
});

test('niveles: temporadas en hora de Costa Rica y nivel según tarjetas canjeadas', () => {
  const niveles = require('../src/services/niveles.service');
  const t = (inicio, meses, ahora) => niveles.temporadaActual({ temporada_inicio: inicio, temporada_meses: meses }, new Date(ahora));
  assert.equal(t('2026-01-01', 3, '2026-10-14T15:00:00Z').clave, '2026-10-01');
  assert.equal(niveles.fechaFin(t('2026-01-01', 3, '2026-10-14T15:00:00Z')), '31 dic 2026');
  // El 31 de enero + 4 meses cae a fin de mes, sin desbordar.
  assert.equal(t('2026-01-31', 4, '2026-06-15T15:00:00Z').clave, '2026-05-31');
  // Medianoche de Costa Rica = 06:00 UTC: 23:30 del 31 dic todavía es la temporada vieja.
  assert.equal(t('2026-01-01', 3, '2027-01-01T05:30:00Z').clave, '2026-10-01');
  assert.equal(t('2026-01-01', 3, '2027-01-01T06:30:00Z').clave, '2027-01-01');

  const neg = {
    ...negocio,
    niveles_activos: true,
    niveles: [{ clave: 'plata', tarjetas: 2, premio: 'Café grande' }, { clave: 'oro', tarjetas: 4, premio: '' }],
  };
  const temporada = t('2026-10-01', 3, '2026-10-14T15:00:00Z');
  const nivelCon = (tarjetas) => niveles.describir(neg, tarjetas, temporada);
  assert.equal(nivelCon(0).nivel.clave, 'bronce');
  assert.equal(nivelCon(0).premio, 'Café gratis'); // sin premio propio: el general
  assert.equal(nivelCon(1).faltan, 1);
  assert.equal(nivelCon(2).nivel.clave, 'plata');
  assert.equal(nivelCon(2).premio, 'Café grande');
  assert.equal(nivelCon(5).nivel.clave, 'oro');
  assert.equal(nivelCon(6).nivel.clave, 'diamante'); // diamante sin configurar: 6 por defecto
  assert.equal(nivelCon(6).siguiente, null);
  assert.equal(niveles.etiqueta(nivelCon(5).nivel), '🥇 ORO');
  assert.match(niveles.resumen(nivelCon(2)), /🥈 Plata · 2 tarjetas llenas esta temporada · faltan 2 para 🥇 Oro\. La temporada termina el 31 dic 2026\./);

  // Reglas sugeridas explican los niveles y la temporada.
  const reglas = require('../src/utils/reglas');
  const texto = reglas.reglasSugeridas({ ...neg, temporada_meses: 4 }).join('\n');
  assert.match(texto, /🥈 Plata \(al canjear 2 tarjetas en la temporada\): Café grande/);
  assert.match(texto, /Cada temporada dura 4 meses/);
});

test('niveles en las tarjetas: Apple arriba a la derecha y Google en el campo principal', async () => {
  const niveles = require('../src/services/niveles.service');
  const neg = { ...negocio, niveles_activos: true, niveles: [{ clave: 'oro', tarjetas: 4, premio: 'Desayuno' }] };
  const estado = niveles.describir(neg, 4, niveles.temporadaActual({ temporada_inicio: '2026-10-01' }, new Date('2026-10-14T15:00:00Z')));

  const objeto = googleWallet.construirObjeto({ ...cliente, sellos_actuales: 3 }, neg, estado);
  assert.deepEqual(objeto.loyaltyPoints, { label: 'Nivel', balance: { string: '🥇 Oro' } });
  assert.equal(objeto.secondaryLoyaltyPoints.balance.string, '3 / 8');
  assert.match(objeto.textModulesData[0].body, /para su premio: Desayuno\.$/);
  assert.equal(objeto.textModulesData[1].id, 'nivel');

  // Apple: el conteo de canjes va a la base de datos; aquí se reemplaza por un valor fijo.
  const original = niveles.estadoDelCliente;
  niveles.estadoDelCliente = async () => estado;
  try {
    const pass = { serial_number: 's', auth_token: 'a'.repeat(48), ultima_actualizacion: new Date().toISOString() };
    const json = JSON.parse(leerZip(await appleWallet.generarPass({ cliente, negocio: neg, pass }))['pass.json'].toString('utf8'));
    assert.deepEqual(json.storeCard.headerFields[0], {
      key: 'nivel', label: 'NIVEL', value: '🥇 ORO', textAlignment: 'PKTextAlignmentRight', changeMessage: '¡Subió a nivel %@!',
    });
    assert.equal(json.storeCard.secondaryFields[0].value, 'Desayuno');
    assert.ok(json.storeCard.backFields.some((c) => c.key === 'nivel_detalle'));
  } finally {
    niveles.estadoDelCliente = original;
  }
});

test('análisis: períodos en hora de Costa Rica y clientes por nivel', () => {
  const analisis = require('../src/services/analisis.service');
  const ahora = new Date('2026-10-14T15:00:00Z'); // 9:00 en Costa Rica
  const treinta = analisis.rango('30d', ahora);
  assert.equal(treinta.hasta.toISOString(), '2026-10-15T06:00:00.000Z'); // mañana a medianoche (CR)
  assert.equal(treinta.desde.toISOString(), '2026-09-15T06:00:00.000Z'); // 30 días, hoy incluido
  assert.equal(treinta.unidad, 'day');
  const anio = analisis.rango('12m', ahora);
  assert.equal(anio.desde.toISOString(), '2025-11-01T06:00:00.000Z'); // 12 meses completos
  assert.equal(anio.hasta.toISOString(), '2026-11-01T06:00:00.000Z');
  assert.equal(analisis.rango('otro', ahora).clave, '30d');

  const niveles = require('../src/services/niveles.service');
  const neg = { ...negocio, niveles_activos: true, niveles: [{ clave: 'plata', tarjetas: 2 }] };
  const temporada = niveles.temporadaActual({ temporada_inicio: '2026-10-01' }, ahora);
  const r = analisis.clientesPorNivel(neg, [{ canjes: 0, clientes: 5 }, { canjes: 1, clientes: 2 }, { canjes: 3, clientes: 1 }], temporada);
  assert.deepEqual(r.niveles.map((n) => [n.clave, n.clientes]), [['bronce', 7], ['plata', 1], ['oro', 0], ['diamante', 0]]);
});

test('reinicio por inactividad: aviso con la fecha límite en la tarjeta, la consulta y las reglas', async () => {
  const inactividad = require('../src/services/inactividad.service');
  const neg = { ...negocio, inactividad_dias: 30 };
  const activo = { ...cliente, sellos_actuales: 3, ultima_actividad: '2026-10-14T15:00:00Z' };
  assert.equal(inactividad.aviso(activo, negocio), null); // el negocio no lo usa
  // 30 días después del 14 oct (9:00 en CR): el 13 de noviembre.
  assert.equal(inactividad.fechaLimite(activo, neg).toISOString(), '2026-11-13T15:00:00.000Z');
  assert.equal(inactividad.aviso(activo, neg), 'Reciba su próxima estampa antes del 13 de noviembre de 2026; si no, sus estampas vuelven a cero.');
  assert.match(inactividad.aviso({ ...activo, sellos_actuales: 0 }, neg), /Si pasan 30 días sin recibir una estampa/);

  const reglas = require('../src/utils/reglas');
  assert.ok(reglas.reglasSugeridas(neg).some((r) => /30 días sin recibir una estampa/.test(r)));
  assert.ok(!reglas.reglasSugeridas(negocio).some((r) => /sin recibir una estampa/.test(r)));

  const objeto = googleWallet.construirObjeto(activo, neg);
  assert.deepEqual(objeto.textModulesData.find((m) => m.id === 'vigencia'),
    { id: 'vigencia', header: 'Vigencia de las estampas', body: inactividad.aviso(activo, neg) });
  assert.ok(!googleWallet.construirObjeto(activo, negocio).textModulesData.some((m) => m.id === 'vigencia'));

  const pass = { serial_number: 's', auth_token: 'a'.repeat(48), ultima_actualizacion: new Date().toISOString() };
  const json = JSON.parse(leerZip(await appleWallet.generarPass({ cliente: activo, negocio: neg, pass }))['pass.json'].toString('utf8'));
  assert.equal(json.storeCard.backFields.find((c) => c.key === 'vigencia').value, inactividad.aviso(activo, neg));
});

test('foto de fondo de las estampas: recorte, efectos y versión de la tira', async () => {
  const sharp = require('sharp');
  const estampas = require('../src/services/estampas.service');
  const marca = require('../src/services/marca.service');
  // Foto de 1200 × 400: mitad izquierda blanca, mitad derecha azul.
  const foto = await sharp({ create: { width: 1200, height: 400, channels: 3, background: '#ffffff' } })
    .composite([{ input: { create: { width: 600, height: 400, channels: 3, background: '#0000ff' } }, left: 600, top: 0 }])
    .jpeg().toBuffer();
  const pixel = async (png, x, y) => {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const p = (y * info.width + x) * info.channels;
    return [...data.subarray(p, p + 3)];
  };
  const cerca = (a, b, margen = 12) => a.every((c, i) => Math.abs(c - b[i]) <= margen);

  for (const efecto of estampas.EFECTOS_FONDO) {
    const base = await estampas.fondoConFoto(foto, { ancho: 750, alto: 246, efecto, color: '#ff0000' });
    const meta = await sharp(base).metadata();
    assert.deepEqual([meta.width, meta.height], [750, 246], efecto);
  }
  const con = (efecto) => estampas.fondoConFoto(foto, { ancho: 750, alto: 246, efecto, color: '#ff0000' });
  assert.ok(cerca(await pixel(await con('nitida'), 10, 120), [255, 255, 255]));
  assert.ok(cerca(await pixel(await con('oscura'), 10, 120), [140, 140, 140], 4)); // 45 % de negro
  assert.ok(cerca(await pixel(await con('clara'), 740, 120), [128, 128, 255], 4)); // 50 % de blanco sobre azul
  const byn = await pixel(await con('byn'), 740, 120);
  assert.ok(byn[0] === byn[1] && byn[1] === byn[2]);
  assert.ok((await pixel(await con('color'), 10, 120))[0] > 200); // teñida con el rojo
  // Borrosa: en el borde entre blanco y azul el color se mezcla.
  const borde = await pixel(await con('borrosa'), 372, 120);
  assert.ok(borde[0] > 40 && borde[0] < 215, `borde ${borde}`);

  // La tira se arma sobre la foto aunque no haya imágenes de estampas (círculos encima).
  const neg = { ...negocio, sellos_para_premio: 4, fondo_estampas_url: foto, fondo_estampas_efecto: 'nitida' };
  const tira = await marca.tiraDelNegocio(neg, 1);
  assert.ok(cerca(await pixel(tira, 5, 5), [255, 255, 255]));
  assert.ok(cerca(await pixel(tira, 745, 240), [0, 0, 255]));

  // Sin foto la versión no cambia; con foto, cambia con la foto y con el efecto.
  const conUrl = { ...negocio, fondo_estampas_url: 'https://x/f.jpg', fondo_estampas_efecto: 'nitida' };
  assert.equal(marca.versionTira({ ...negocio, fondo_estampas_efecto: 'borrosa' }), marca.versionTira(negocio));
  assert.notEqual(marca.versionTira(conUrl), marca.versionTira(negocio));
  assert.notEqual(marca.versionTira({ ...conUrl, fondo_estampas_efecto: 'borrosa' }), marca.versionTira(conUrl));
});

test('estampas ocultas: el aro punteado se distingue del fondo aunque el texto sea del mismo color', async () => {
  const sharp = require('sharp');
  const marca = require('../src/services/marca.service');
  const cuadro = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  // Como Woven Souls: texto y fondo de las estampas del mismo crema; tarjeta verde.
  const neg = {
    ...negocio, sellos_para_premio: 4, estampas_pendientes: 'ocultas', sello_url: cuadro, estampas_urls: [],
    color_primario: '#556f62', color_secundario: '#f6eddc', color_fondo_sellos: '#f6eddc',
  };
  const { data, info } = await sharp(await marca.tiraDelNegocio(neg, 1)).raw().toBuffer({ resolveWithObject: true });
  const { celda, centros } = imagen.distribuirEstampas(4, 750, 246);
  // Recorre el borde del aro de la última estampa: algún punto debe ser verdoso, no crema.
  const { x, y } = centros[3];
  const radio = Math.round(celda * 0.84) * 0.45 * 0.94;
  let verde = false;
  for (let a = 0; a < 360; a += 3) {
    const px = Math.round(x + radio * Math.cos((a * Math.PI) / 180));
    const py = Math.round(y + radio * Math.sin((a * Math.PI) / 180));
    const p = (py * info.width + px) * info.channels;
    if (data[p + 1] < 200 && data[p] < 200) verde = true;
  }
  assert.ok(verde, 'el aro de la estampa oculta no se ve sobre el fondo');
});
