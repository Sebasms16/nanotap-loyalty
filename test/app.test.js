// Pruebas HTTP de la app sin base de datos: páginas, imágenes, autenticación,
// validaciones previas a la BD y manejo de errores.
require('./helpers/entorno').configurar();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');

let servidor;
let base;

before(async () => {
  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => servidor.close());

const pedir = (ruta, opciones = {}) => fetch(`${base}${ruta}`, { redirect: 'manual', ...opciones });
const json = (cuerpo, token) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
});

test('salud', async () => {
  const r = await pedir('/salud');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('páginas públicas y de paneles', async () => {
  for (const ruta of ['/', '/podosport/inscripcion', '/podosport/consulta', '/podosport/privacidad', '/staff/login', '/staff/panel', '/operador/']) {
    const r = await pedir(ruta);
    assert.equal(r.status, 200, ruta);
    assert.match(r.headers.get('content-type'), /text\/html/, ruta);
  }
  assert.match(String((await pedir('/')).headers.get('content-security-policy')), /default-src 'self'/);
});

test('redirecciones de conveniencia', async () => {
  assert.equal((await pedir('/podosport')).headers.get('location'), '/podosport/inscripcion');
  assert.equal((await pedir('/podosport/staff')).headers.get('location'), '/staff/?negocio=podosport');
  assert.equal((await pedir('/staff/?negocio=podosport')).headers.get('location'), '/staff/login?negocio=podosport');
});

test('404 en HTML y en API', async () => {
  assert.equal((await pedir('/no/existe/aqui')).status, 404);
  const r = await pedir('/api/no-existe');
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'Ruta no encontrada.');
});

test('archivos estáticos y lector de QR', async () => {
  const r = await pedir('/vendor/html5-qrcode.min.js');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Html5Qrcode/);
  assert.equal((await pedir('/css/app.css')).status, 200);
});

test('imágenes generadas', async () => {
  const r = await pedir('/img/sellos.png?total=10&llenos=4&fondo=1a1a2e&sello=ffffff');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  const icono = await pedir('/img/icono.png?tam=9999');
  const png = Buffer.from(await icono.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 660); // tamaño acotado
});

test('rutas de staff exigen sesión', async () => {
  assert.equal((await pedir('/api/clientes/POD-2026-AAAAAAAA')).status, 401);
  assert.equal((await pedir('/api/clientes/22222222-2222-4222-8222-222222222222/sello', { method: 'POST' })).status, 401);
  assert.equal((await pedir('/api/negocios/podosport/clientes/export')).status, 401);
  const tokenFalso = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2wiOiJzdGFmZiJ9.firma-falsa';
  assert.equal((await pedir('/api/staff/yo', { headers: { Authorization: `Bearer ${tokenFalso}` } })).status, 401);
});

test('operador: login y validaciones de alta de negocio', async () => {
  assert.equal((await pedir('/api/negocios', json({ nombre: 'X', slug: 'x' }))).status, 401);
  assert.equal((await pedir('/api/operador/login', json({ password: 'mala' }))).status, 401);

  const login = await pedir('/api/operador/login', json({ password: 'operador-prueba' }));
  assert.equal(login.status, 200);
  const { token } = await login.json();

  const slugReservado = await pedir('/api/negocios', json({ nombre: 'API', slug: 'api' }, token));
  assert.equal(slugReservado.status, 400);
  assert.match((await slugReservado.json()).error, /slug/);

  const colorMalo = await pedir('/api/negocios', json({ nombre: 'Café', slug: 'cafe', color_primario: 'rojo' }, token));
  assert.equal(colorMalo.status, 400);

  // Subida de imágenes: exige operador y valida que sea una imagen antes de tocar la BD.
  const id = '11111111-1111-4111-8111-111111111111';
  const subir = (tok, cuerpo, tipo = 'image/png', clase = 'logo') => pedir(`/api/negocios/${id}/imagenes/${clase}`, {
    method: 'POST',
    headers: { 'Content-Type': tipo, ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: cuerpo,
  });
  assert.equal((await subir(null, 'x')).status, 401);
  const noImagen = await subir(token, 'esto no es una imagen');
  assert.equal(noImagen.status, 415);
  assert.match((await noImagen.json()).error, /imagen válida/);
  assert.equal((await subir(token, 'x', 'text/plain')).status, 415);
  assert.equal((await subir(token, 'x', 'image/png', 'otro')).status, 404);

  // Vista previa de estampas: con una imagen sin guardar devuelve el PNG dibujado.
  const sharp = require('sharp');
  const estampa = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 1 } } })
    .png().toBuffer();
  const previa = await pedir('/api/operador/vista-previa/estampas?total=6&llenos=2&fondo=ffffff', {
    method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${token}` }, body: estampa,
  });
  assert.equal(previa.status, 200);
  assert.equal(previa.headers.get('content-type'), 'image/png');
  assert.equal((await pedir('/api/operador/vista-previa/estampas', { method: 'POST' })).status, 401);
  assert.equal((await pedir('/img/qr-ejemplo.png')).status, 200);

  // Un token de operador no sirve como staff.
  assert.equal((await pedir('/api/staff/yo', { headers: { Authorization: `Bearer ${token}` } })).status, 401);
});

test('Apple web service rechaza passTypeIdentifier ajeno', async () => {
  const r = await pedir('/api/wallet/apple/v1/devices/abc/registrations/pass.otro.tipo/serial', json({ pushToken: 'x' }));
  assert.equal(r.status, 404);
  assert.equal((await pedir('/api/wallet/apple/v1/log', json({ logs: ['prueba'] }))).status, 200);
});

test('login sin cuerpo responde 401, no 500', async () => {
  assert.equal((await pedir('/api/operador/login', { method: 'POST' })).status, 401);
  assert.equal((await pedir('/api/staff/login', { method: 'POST' })).status, 401);
});

test('JSON inválido devuelve 400 en español', async () => {
  const r = await pedir('/api/operador/login', json('{no es json'));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /JSON/);
});

test('si la base de datos falla, el error es genérico y en español', async () => {
  const r = await pedir('/api/negocios/podosport');
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error, 'Ocurrió un error inesperado. Intente de nuevo.');
});
