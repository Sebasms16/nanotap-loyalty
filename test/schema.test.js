// Ejecuta schema.sql en un Postgres embebido (PGlite) y prueba las funciones
// de sellos/canjes: atomicidad, aislamiento por negocio y "restar, no resetear".
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let db;
let negocioA;
let negocioB;
let cliente;

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  await db.exec(sql);
  await db.exec(sql); // debe ser re-ejecutable

  negocioA = (await db.query(
    `insert into negocios (nombre, slug, sellos_para_premio) values ('Café A', 'cafe-a', 3) returning id`
  )).rows[0].id;
  negocioB = (await db.query(
    `insert into negocios (nombre, slug) values ('Café B', 'cafe-b') returning id`
  )).rows[0].id;
  cliente = (await db.query(
    `insert into clientes (negocio_id, nombre, telefono, correo, codigo_qr, acepto_terminos)
     values ($1, 'Ana', '88887777', 'ana@example.com', 'CAF-2026-AAAAAAAA', true) returning id`,
    [negocioA]
  )).rows[0].id;
  await db.query(
    `insert into wallet_passes (cliente_id, plataforma, serial_number, ultima_actualizacion)
     values ($1, 'apple', 'serial-1', now() - interval '1 day')`,
    [cliente]
  );
});

async function rpc(fn, clienteId, negocioId) {
  const r = await db.query(`select ${fn}($1, $2, null) as r`, [clienteId, negocioId]);
  return r.rows[0].r;
}

test('sumar_sello incrementa, registra evento y marca el pass como modificado', async () => {
  const r = await rpc('sumar_sello', cliente, negocioA);
  assert.equal(r.sellos_actuales, 1);
  assert.equal(r.premio_disponible, false);
  const eventos = await db.query(`select tipo from sellos_eventos where cliente_id = $1`, [cliente]);
  assert.deepEqual(eventos.rows.map((e) => e.tipo), ['sello']);
  const pass = await db.query(
    `select ultima_actualizacion > now() - interval '1 minute' as reciente from wallet_passes where cliente_id = $1`,
    [cliente]
  );
  assert.equal(pass.rows[0].reciente, true);
});

test('sumar_sello rechaza clientes de otro negocio', async () => {
  await assert.rejects(rpc('sumar_sello', cliente, negocioB), /cliente_de_otro_negocio/);
});

test('canjear_premio exige sellos suficientes', async () => {
  await assert.rejects(rpc('canjear_premio', cliente, negocioA), /sellos_insuficientes/);
});

test('canjear_premio resta el umbral sin perder sellos extra', async () => {
  for (let i = 0; i < 3; i++) await rpc('sumar_sello', cliente, negocioA); // total 4, meta 3
  const r = await rpc('canjear_premio', cliente, negocioA);
  assert.equal(r.sellos_actuales, 1);
  assert.equal(r.premios_canjeados, 1);
  const canjes = await db.query(
    `select count(*)::int as n from sellos_eventos where cliente_id = $1 and tipo = 'canje'`,
    [cliente]
  );
  assert.equal(canjes.rows[0].n, 1);
});

test('negocio inactivo no puede sumar sellos', async () => {
  await db.query(`update negocios set activo = false where id = $1`, [negocioA]);
  await assert.rejects(rpc('sumar_sello', cliente, negocioA), /negocio_inactivo/);
  await db.query(`update negocios set activo = true where id = $1`, [negocioA]);
});

test('cliente inexistente', async () => {
  await assert.rejects(
    rpc('sumar_sello', '00000000-0000-0000-0000-000000000000', negocioA),
    /cliente_no_encontrado/
  );
});

test('encolar_sync_negocio encola los passes del negocio', async () => {
  const r = await db.query(`select encolar_sync_negocio($1) as n`, [negocioA]);
  assert.equal(r.rows[0].n, 1);
  await db.query(`select encolar_sync_negocio($1)`, [negocioA]); // upsert, sin duplicar
  const cola = await db.query(`select count(*)::int as n from wallet_sync_pendientes`);
  assert.equal(cola.rows[0].n, 1);
});

test('vista negocios_resumen cuenta clientes', async () => {
  const r = await db.query(`select slug, total_clientes from negocios_resumen order by slug`);
  assert.deepEqual(r.rows, [
    { slug: 'cafe-a', total_clientes: 1 },
    { slug: 'cafe-b', total_clientes: 0 },
  ]);
});

test('análisis del negocio: cifras, serie, horarios, personas y aislamiento', async () => {
  const neg = (await db.query(
    `insert into negocios (nombre, slug, sellos_para_premio) values ('Pan C', 'pan-c', 3) returning id`
  )).rows[0].id;
  const ana = (await db.query(
    `insert into staff (negocio_id, usuario, password_hash, nombre, rol) values ($1, 'ana', 'x', 'Ana', 'administrador') returning id`,
    [neg]
  )).rows[0].id;
  const nuevo = (await db.query(
    `insert into clientes (negocio_id, nombre, primer_apellido, telefono, correo, codigo_qr, creado_en, fecha_nacimiento)
     values ($1, 'Luis', 'Mora', '81111111', 'l@x.com', 'PAN-1', now() - interval '3 days',
             make_date(1990, extract(month from now() at time zone 'America/Costa_Rica')::int, 5)) returning id`,
    [neg]
  )).rows[0].id;
  const viejo = (await db.query(
    `insert into clientes (negocio_id, nombre, telefono, correo, codigo_qr, creado_en, sellos_actuales)
     values ($1, 'Eva', '82222222', 'e@x.com', 'PAN-2', now() - interval '80 days', 2) returning id`,
    [neg]
  )).rows[0].id;
  await db.query(
    `insert into sellos_eventos (cliente_id, staff_id, tipo, creado_en) values
       ($1, $2, 'sello', now() - interval '2 days'), ($1, $2, 'sello', now() - interval '1 day'),
       ($1, $2, 'canje', now() - interval '1 day'), ($3, $2, 'sello', now() - interval '60 days')`,
    [nuevo, ana, viejo]
  );

  const r = (await db.query(
    `select analisis_negocio($1, now() - interval '30 days', now(), 'day', now() - interval '10 days', now() + interval '80 days') as r`,
    [neg]
  )).rows[0].r;
  assert.deepEqual(
    { ...r.resumen, iphone: undefined },
    { clientes_total: 2, clientes_nuevos: 1, clientes_activos: 1, recurrentes: 1, sellos: 2, canjes: 1,
      premios_pendientes: 0, sin_volver: 0, iphone: undefined }
  );
  assert.equal(r.serie.length, 31); // un punto por día, aunque no haya movimiento
  assert.equal(r.serie.reduce((t, p) => t + p.sellos, 0), 2);
  assert.equal(r.horario.reduce((t, h) => t + h.sellos, 0), 2);
  assert.deepEqual(r.staff, [{ nombre: 'Ana', usuario: 'ana', sellos: 2, canjes: 1 }]);
  assert.deepEqual(r.mejores.map((c) => [c.nombre, c.sellos]), [['Luis Mora', 2]]);
  assert.deepEqual(r.en_riesgo.map((c) => c.nombre), ['Eva']); // último sello hace 60 días
  assert.deepEqual(r.cumpleanos.map((c) => [c.nombre, c.dia]), [['Luis Mora', 5]]);
  assert.deepEqual(r.niveles, [{ canjes: 0, clientes: 1 }, { canjes: 1, clientes: 1 }]);
  // Solo cuenta sus propios clientes (los de Café A no aparecen).
  assert.ok(!r.mejores.some((c) => c.telefono === '88887777'));

  const o = (await db.query(`select analisis_operador(now() - interval '30 days', now(), 'week') as r`)).rows[0].r;
  const pan = o.negocios.find((n) => n.slug === 'pan-c');
  assert.equal(pan.sellos, 2);
  assert.equal(pan.clientes, 2);
  assert.ok(o.resumen.sellos >= 2);
  assert.equal(o.resumen.negocios, (await db.query(`select count(*)::int n from negocios`)).rows[0].n);
});
