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
  assert.equal(pocos.textModulesData[0].body, '5 estampas para su premio.');
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
  const celda = Math.min((750 * 0.94) / 4, 246 * 0.9);
  const x0 = Math.round((750 - celda * 4) / 2 + celda / 2);
  const x3 = Math.round(x0 + celda * 3);
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

test('estampas: una imagen por posición y pendientes en gris u ocultas', async () => {
  const sharp = require('sharp');
  const marca = require('../src/services/marca.service');
  const cuadro = (r, g, b) => sharp({ create: { width: 300, height: 300, channels: 4, background: { r, g, b, alpha: 1 } } })
    .png().toBuffer();
  const rojo = await cuadro(255, 0, 0);
  const azul = await cuadro(0, 0, 255);
  // Color en el centro de cada estampa: 4 estampas en una fila sobre 750 × 246.
  const centros = async (png) => {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    return [0, 1, 2, 3].map((i) => {
      const x = Math.round(22.5 + 176.25 * (i + 0.5));
      const p = (123 * info.width + x) * info.channels;
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
