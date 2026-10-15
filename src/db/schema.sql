-- =========================================================
-- Nanotap Loyalty — esquema de base de datos (Supabase / Postgres 15+)
--
-- Ejecutar completo en el SQL Editor de Supabase. Es re-ejecutable.
-- Base: sección 5 de la especificación técnica. Agregados (ver README,
-- "Supuestos y desviaciones"):
--   * clientes.acepto_terminos_en       evidencia legal del consentimiento (sec. 12)
--   * wallet_passes.auth_token          authenticationToken del protocolo de Apple
--   * wallet_sync_pendientes            cola de reintentos hacia los wallets (RNF-03)
--   * funciones sumar_sello / canjear_premio   cambios atómicos de sellos + auditoría
--   * vista negocios_resumen            panel del operador (RF-08)
--   * RLS activado sin políticas: solo la service_role (el backend) accede
-- =========================================================

-- =========================================================
-- NEGOCIOS (tenants)
-- =========================================================
create table if not exists negocios (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  slug text unique not null,                 -- usado en la URL pública de inscripción
  logo_url text,
  color_primario text default '#1a1a2e',
  color_secundario text default '#ffffff',
  sellos_para_premio integer not null default 10 check (sellos_para_premio between 1 and 30),
  descripcion_premio text not null default 'Producto gratis',
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  sello_url text,                            -- imagen de la estampa (si es null, se usa el logo)
  color_fondo_sellos text,                   -- fondo de la zona de estampas (si es null, el color de la tarjeta)
  reglas text,                               -- reglas del programa, una por línea (si es null, las sugeridas)
  estampas_urls jsonb not null default '[]', -- imagen propia de cada estampa, por posición (null = la general)
  estampas_pendientes text not null default 'gris'
    check (estampas_pendientes in ('gris', 'ocultas')), -- gris: la imagen en gris; ocultas: círculo vacío
  ocultar_nombre boolean not null default false, -- no mostrar el nombre junto al logo (Apple), si el logo ya lo trae
  -- Niveles por temporada (ver services/niveles.service.js)
  niveles_activos boolean not null default false,
  niveles jsonb,                               -- [{clave, tarjetas, premio}] (null = valores por defecto)
  temporada_meses integer not null default 3 check (temporada_meses between 1 and 12),
  temporada_inicio date,                       -- inicio de la primera temporada; las siguientes se encadenan
  temporada_sincronizada text                  -- última temporada enviada a las tarjetas (para refrescarlas al cambiar)
);
-- Para bases creadas antes de que existieran estas columnas:
alter table negocios add column if not exists sello_url text;
alter table negocios add column if not exists color_fondo_sellos text;
alter table negocios add column if not exists reglas text;
alter table negocios add column if not exists estampas_urls jsonb not null default '[]';
alter table negocios add column if not exists estampas_pendientes text not null default 'gris'
  check (estampas_pendientes in ('gris', 'ocultas'));
alter table negocios add column if not exists ocultar_nombre boolean not null default false;
alter table negocios add column if not exists niveles_activos boolean not null default false;
alter table negocios add column if not exists niveles jsonb;
alter table negocios add column if not exists temporada_meses integer not null default 3
  check (temporada_meses between 1 and 12);
alter table negocios add column if not exists temporada_inicio date;
alter table negocios add column if not exists temporada_sincronizada text;

-- =========================================================
-- STAFF (usuarios del negocio que suman sellos)
-- =========================================================
create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id) on delete cascade,
  usuario text not null,
  password_hash text not null,                -- bcrypt, nunca texto plano
  nombre text,
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  rol text not null default 'staff' check (rol in ('staff', 'administrador')), -- administrador: ve el análisis
  unique (negocio_id, usuario)
);
alter table staff add column if not exists rol text not null default 'staff'
  check (rol in ('staff', 'administrador'));

-- =========================================================
-- CLIENTES FINALES
-- =========================================================
create table if not exists clientes (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id) on delete cascade,
  nombre text not null,
  primer_apellido text,
  segundo_apellido text,
  telefono text not null,                     -- normalizado: solo dígitos, sin prefijo 506
  correo text not null,
  fecha_nacimiento date,
  identificacion text,
  acepto_terminos boolean not null default false,
  acepto_terminos_en timestamptz,             -- fecha/hora del consentimiento (Ley 8968)
  codigo_qr text unique not null,             -- ej. "POD-2026-D5471AC9"
  sellos_actuales integer not null default 0 check (sellos_actuales >= 0),
  premios_canjeados integer not null default 0 check (premios_canjeados >= 0),
  creado_en timestamptz not null default now(),
  unique (negocio_id, telefono)
);

-- =========================================================
-- EVENTOS DE SELLOS Y CANJES (auditoría completa)
-- =========================================================
create table if not exists sellos_eventos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  staff_id uuid references staff(id) on delete set null,
  tipo text not null check (tipo in ('sello', 'canje')),
  creado_en timestamptz not null default now()
);

-- =========================================================
-- PASSES EMITIDOS (uno por cliente por plataforma)
-- =========================================================
create table if not exists wallet_passes (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  plataforma text not null check (plataforma in ('apple', 'google')),
  serial_number text not null unique,         -- Apple: serialNumber propio; Google: objectId
  auth_token text,                            -- Apple: authenticationToken del pass
  ultima_actualizacion timestamptz not null default now(),  -- Apple: "versión" del pass
  unique (cliente_id, plataforma)
);

-- =========================================================
-- REGISTROS DE DISPOSITIVO (solo necesario para Apple Wallet)
-- =========================================================
create table if not exists apple_device_registrations (
  id uuid primary key default gen_random_uuid(),
  device_library_identifier text not null,
  pass_type_identifier text not null,
  serial_number text not null,
  push_token text not null,
  creado_en timestamptz not null default now(),
  unique (device_library_identifier, pass_type_identifier, serial_number)
);

-- =========================================================
-- COLA DE REINTENTOS HACIA LOS WALLETS (RNF-03)
-- Si Apple/Google fallan, el sello ya quedó guardado; aquí se anota
-- la notificación pendiente y un worker la reintenta con backoff.
-- =========================================================
create table if not exists wallet_sync_pendientes (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  plataforma text not null check (plataforma in ('apple', 'google')),
  intentos integer not null default 0,
  proximo_intento timestamptz not null default now(),
  ultimo_error text,
  creado_en timestamptz not null default now(),
  unique (cliente_id, plataforma)
);

create index if not exists idx_clientes_negocio on clientes(negocio_id);
create index if not exists idx_sellos_eventos_cliente on sellos_eventos(cliente_id);
create index if not exists idx_apple_devices_serial on apple_device_registrations(serial_number);
create index if not exists idx_wallet_sync_proximo on wallet_sync_pendientes(proximo_intento);
create index if not exists idx_sellos_eventos_creado on sellos_eventos(creado_en);

-- =========================================================
-- VISTA PARA EL PANEL DEL OPERADOR (RF-08)
-- =========================================================
-- Columnas explícitas: "create or replace view" solo permite agregar columnas al final.
create or replace view negocios_resumen with (security_invoker = on) as
select n.id, n.nombre, n.slug, n.logo_url, n.color_primario, n.color_secundario,
       n.sellos_para_premio, n.descripcion_premio, n.activo, n.creado_en,
       (select count(*) from clientes c where c.negocio_id = n.id)::int as total_clientes,
       (select count(*) from staff s where s.negocio_id = n.id and s.activo)::int as total_staff,
       n.sello_url, n.color_fondo_sellos, n.reglas, n.estampas_urls, n.estampas_pendientes,
       n.ocultar_nombre, n.niveles_activos, n.niveles, n.temporada_meses, n.temporada_inicio
from negocios n;

-- =========================================================
-- SUMAR SELLO (RF-05)
-- Atómico: incrementa, registra el evento y marca el pass Apple como
-- modificado en una sola transacción. Verifica el tenant (RF-04).
-- =========================================================
create or replace function sumar_sello(p_cliente_id uuid, p_negocio_id uuid, p_staff_id uuid)
returns json
language plpgsql
set search_path = public
as $$
declare
  v_negocio_id uuid;
  v_activo boolean;
  v_meta integer;
  v_sellos integer;
  v_premios integer;
begin
  select c.negocio_id, n.activo, n.sellos_para_premio
    into v_negocio_id, v_activo, v_meta
    from clientes c join negocios n on n.id = c.negocio_id
   where c.id = p_cliente_id
     for update of c;

  if not found then raise exception 'cliente_no_encontrado'; end if;
  if v_negocio_id <> p_negocio_id then raise exception 'cliente_de_otro_negocio'; end if;
  if not v_activo then raise exception 'negocio_inactivo'; end if;

  update clientes
     set sellos_actuales = sellos_actuales + 1
   where id = p_cliente_id
   returning sellos_actuales, premios_canjeados into v_sellos, v_premios;

  insert into sellos_eventos (cliente_id, staff_id, tipo) values (p_cliente_id, p_staff_id, 'sello');
  update wallet_passes set ultima_actualizacion = now() where cliente_id = p_cliente_id;

  return json_build_object(
    'sellos_actuales', v_sellos,
    'premios_canjeados', v_premios,
    'sellos_para_premio', v_meta,
    'premio_disponible', v_sellos >= v_meta
  );
end;
$$;

-- =========================================================
-- CANJEAR PREMIO (RF-06)
-- Resta sellos_para_premio (no resetea a cero) para no perder sellos extra.
-- =========================================================
create or replace function canjear_premio(p_cliente_id uuid, p_negocio_id uuid, p_staff_id uuid)
returns json
language plpgsql
set search_path = public
as $$
declare
  v_negocio_id uuid;
  v_activo boolean;
  v_meta integer;
  v_sellos integer;
  v_premios integer;
begin
  select c.negocio_id, n.activo, n.sellos_para_premio, c.sellos_actuales
    into v_negocio_id, v_activo, v_meta, v_sellos
    from clientes c join negocios n on n.id = c.negocio_id
   where c.id = p_cliente_id
     for update of c;

  if not found then raise exception 'cliente_no_encontrado'; end if;
  if v_negocio_id <> p_negocio_id then raise exception 'cliente_de_otro_negocio'; end if;
  if not v_activo then raise exception 'negocio_inactivo'; end if;
  if v_sellos < v_meta then raise exception 'sellos_insuficientes'; end if;

  update clientes
     set sellos_actuales = sellos_actuales - v_meta,
         premios_canjeados = premios_canjeados + 1
   where id = p_cliente_id
   returning sellos_actuales, premios_canjeados into v_sellos, v_premios;

  insert into sellos_eventos (cliente_id, staff_id, tipo) values (p_cliente_id, p_staff_id, 'canje');
  update wallet_passes set ultima_actualizacion = now() where cliente_id = p_cliente_id;

  return json_build_object(
    'sellos_actuales', v_sellos,
    'premios_canjeados', v_premios,
    'sellos_para_premio', v_meta,
    'premio_disponible', v_sellos >= v_meta
  );
end;
$$;

-- =========================================================
-- REFRESCAR TODAS LAS TARJETAS DE UN NEGOCIO
-- Se usa cuando cambia la marca o la regla del premio: marca los passes
-- Apple como modificados y los encola para enviarles push.
-- (Google se actualiza de una vez parcheando la clase del negocio.)
-- =========================================================
create or replace function encolar_sync_negocio(p_negocio_id uuid)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_total integer;
begin
  update wallet_passes wp
     set ultima_actualizacion = now()
    from clientes c
   where c.id = wp.cliente_id and c.negocio_id = p_negocio_id;

  insert into wallet_sync_pendientes (cliente_id, plataforma)
  select wp.cliente_id, wp.plataforma
    from wallet_passes wp join clientes c on c.id = wp.cliente_id
   where c.negocio_id = p_negocio_id
  on conflict (cliente_id, plataforma)
  do update set proximo_intento = now(), intentos = 0;

  get diagnostics v_total = row_count;
  return v_total;
end;
$$;

-- =========================================================
-- ANÁLISIS (panel del dueño del negocio y del operador)
-- Todo se agrupa en hora de Costa Rica. p_unidad: 'day', 'week' o 'month'.
-- El período anterior (para comparar) es uno de igual duración justo antes.
-- =========================================================
create or replace function analisis_negocio(
  p_negocio_id uuid,
  p_desde timestamptz,
  p_hasta timestamptz,
  p_unidad text default 'day',
  p_temporada_desde timestamptz default null,
  p_temporada_hasta timestamptz default null
)
returns json
language sql
stable
set search_path = public
as $$
with
  cli as (select * from clientes where negocio_id = p_negocio_id),
  meta as (select sellos_para_premio as n from negocios where id = p_negocio_id),
  ev as (select e.* from sellos_eventos e join cli c on c.id = e.cliente_id),
  ev_p as (select * from ev where creado_en >= p_desde and creado_en < p_hasta),
  ev_a as (select * from ev where creado_en >= p_desde - (p_hasta - p_desde) and creado_en < p_desde),
  activos as (
    select cliente_id,
           count(*) filter (where tipo = 'sello') as sellos,
           count(*) filter (where tipo = 'canje') as canjes,
           max(creado_en) as ultima
      from ev_p group by cliente_id
  ),
  ultima as (select cliente_id, max(creado_en) as ultima from ev where tipo = 'sello' group by cliente_id),
  hoy as (select (now() at time zone 'America/Costa_Rica') as t)
select json_build_object(
  'resumen', json_build_object(
    'clientes_total', (select count(*) from cli),
    'clientes_nuevos', (select count(*) from cli where creado_en >= p_desde and creado_en < p_hasta),
    'clientes_activos', (select count(*) from activos where sellos > 0),
    'recurrentes', (select count(*) from activos where sellos >= 2),
    'sellos', (select count(*) from ev_p where tipo = 'sello'),
    'canjes', (select count(*) from ev_p where tipo = 'canje'),
    'premios_pendientes', (select count(*) from cli, meta where cli.sellos_actuales >= meta.n),
    'sin_volver', (select count(*) from cli where not exists (select 1 from ev where ev.cliente_id = cli.id)),
    'iphone', (select count(distinct wp.cliente_id) from wallet_passes wp
                 join cli on cli.id = wp.cliente_id
                 join apple_device_registrations r on r.serial_number = wp.serial_number
                where wp.plataforma = 'apple')
  ),
  'anterior', json_build_object(
    'clientes_nuevos', (select count(*) from cli
                         where creado_en >= p_desde - (p_hasta - p_desde) and creado_en < p_desde),
    'clientes_activos', (select count(distinct cliente_id) from ev_a where tipo = 'sello'),
    'sellos', (select count(*) from ev_a where tipo = 'sello'),
    'canjes', (select count(*) from ev_a where tipo = 'canje')
  ),
  'serie', (
    select coalesce(json_agg(json_build_object(
             'periodo', to_char(g, 'YYYY-MM-DD'),
             'sellos', coalesce(s.sellos, 0), 'canjes', coalesce(s.canjes, 0), 'nuevos', coalesce(n.nuevos, 0)
           ) order by g), '[]'::json)
      from generate_series(
             date_trunc(p_unidad, p_desde at time zone 'America/Costa_Rica'),
             date_trunc(p_unidad, (p_hasta - interval '1 second') at time zone 'America/Costa_Rica'),
             ('1 ' || p_unidad)::interval) g
      left join (select date_trunc(p_unidad, creado_en at time zone 'America/Costa_Rica') b,
                        count(*) filter (where tipo = 'sello') sellos,
                        count(*) filter (where tipo = 'canje') canjes
                   from ev_p group by 1) s on s.b = g
      left join (select date_trunc(p_unidad, creado_en at time zone 'America/Costa_Rica') b, count(*) nuevos
                   from cli where creado_en >= p_desde and creado_en < p_hasta group by 1) n on n.b = g
  ),
  'horario', (
    select coalesce(json_agg(json_build_object('dia', d, 'hora', h, 'sellos', n)), '[]'::json)
      from (select extract(isodow from creado_en at time zone 'America/Costa_Rica')::int d,
                   extract(hour from creado_en at time zone 'America/Costa_Rica')::int h,
                   count(*) n
              from ev_p where tipo = 'sello' group by 1, 2) x
  ),
  'progreso', (
    select coalesce(json_agg(json_build_object('sellos', s, 'clientes', n) order by s), '[]'::json)
      from (select least(cli.sellos_actuales, meta.n) s, count(*) n from cli, meta group by 1) x
  ),
  'staff', (
    select coalesce(json_agg(json_build_object(
             'nombre', coalesce(st.nombre, st.usuario), 'usuario', st.usuario, 'sellos', x.sellos, 'canjes', x.canjes
           ) order by x.sellos desc, x.canjes desc), '[]'::json)
      from (select staff_id, count(*) filter (where tipo = 'sello') sellos, count(*) filter (where tipo = 'canje') canjes
              from ev_p where staff_id is not null group by staff_id) x
      join staff st on st.id = x.staff_id
  ),
  'mejores', (
    select coalesce(json_agg(json_build_object(
             'nombre', trim(c.nombre || ' ' || coalesce(c.primer_apellido, '')), 'telefono', c.telefono,
             'sellos', a.sellos, 'canjes', a.canjes, 'ultima', a.ultima
           ) order by a.sellos desc, a.ultima desc), '[]'::json)
      from (select * from activos where sellos > 0 order by sellos desc, ultima desc limit 10) a
      join cli c on c.id = a.cliente_id
  ),
  -- Volvieron alguna vez pero no en los últimos 30 días; primero los que más estampas llevan.
  'en_riesgo', (
    select coalesce(json_agg(json_build_object(
             'nombre', x.nombre, 'telefono', x.telefono, 'sellos_actuales', x.sellos_actuales, 'ultima', x.ultima
           ) order by x.sellos_actuales desc, x.ultima desc), '[]'::json)
      from (select trim(c.nombre || ' ' || coalesce(c.primer_apellido, '')) nombre, c.telefono, c.sellos_actuales, u.ultima
              from ultima u join cli c on c.id = u.cliente_id
             where u.ultima < now() - interval '30 days'
             order by c.sellos_actuales desc, u.ultima desc
             limit 15) x
  ),
  'cumpleanos', (
    select coalesce(json_agg(json_build_object(
             'nombre', trim(c.nombre || ' ' || coalesce(c.primer_apellido, '')), 'telefono', c.telefono,
             'dia', extract(day from c.fecha_nacimiento)::int
           ) order by extract(day from c.fecha_nacimiento)), '[]'::json)
      from cli c, hoy
     where c.fecha_nacimiento is not null
       and extract(month from c.fecha_nacimiento) = extract(month from hoy.t)
  ),
  'niveles', case when p_temporada_desde is null then null else (
    select coalesce(json_agg(json_build_object('canjes', k, 'clientes', n) order by k), '[]'::json)
      from (select coalesce(t.canjes, 0) k, count(*) n
              from cli
              left join (select cliente_id, count(*) canjes from ev
                          where tipo = 'canje' and creado_en >= p_temporada_desde and creado_en < p_temporada_hasta
                          group by cliente_id) t on t.cliente_id = cli.id
             group by 1) x
  ) end
);
$$;

create or replace function analisis_operador(p_desde timestamptz, p_hasta timestamptz, p_unidad text default 'day')
returns json
language sql
stable
set search_path = public
as $$
with
  ev as (select e.*, c.negocio_id from sellos_eventos e join clientes c on c.id = e.cliente_id),
  ev_p as (select * from ev where creado_en >= p_desde and creado_en < p_hasta),
  ev_a as (select * from ev where creado_en >= p_desde - (p_hasta - p_desde) and creado_en < p_desde)
select json_build_object(
  'resumen', json_build_object(
    'negocios', (select count(*) from negocios),
    'negocios_activos', (select count(*) from negocios where activo),
    'clientes_total', (select count(*) from clientes),
    'clientes_nuevos', (select count(*) from clientes where creado_en >= p_desde and creado_en < p_hasta),
    'clientes_activos', (select count(distinct cliente_id) from ev_p where tipo = 'sello'),
    'sellos', (select count(*) from ev_p where tipo = 'sello'),
    'canjes', (select count(*) from ev_p where tipo = 'canje'),
    'iphone', (select count(distinct wp.cliente_id) from wallet_passes wp
                 join apple_device_registrations r on r.serial_number = wp.serial_number
                where wp.plataforma = 'apple')
  ),
  'anterior', json_build_object(
    'clientes_nuevos', (select count(*) from clientes
                         where creado_en >= p_desde - (p_hasta - p_desde) and creado_en < p_desde),
    'clientes_activos', (select count(distinct cliente_id) from ev_a where tipo = 'sello'),
    'sellos', (select count(*) from ev_a where tipo = 'sello'),
    'canjes', (select count(*) from ev_a where tipo = 'canje')
  ),
  'serie', (
    select coalesce(json_agg(json_build_object(
             'periodo', to_char(g, 'YYYY-MM-DD'),
             'sellos', coalesce(s.sellos, 0), 'canjes', coalesce(s.canjes, 0), 'nuevos', coalesce(n.nuevos, 0)
           ) order by g), '[]'::json)
      from generate_series(
             date_trunc(p_unidad, p_desde at time zone 'America/Costa_Rica'),
             date_trunc(p_unidad, (p_hasta - interval '1 second') at time zone 'America/Costa_Rica'),
             ('1 ' || p_unidad)::interval) g
      left join (select date_trunc(p_unidad, creado_en at time zone 'America/Costa_Rica') b,
                        count(*) filter (where tipo = 'sello') sellos,
                        count(*) filter (where tipo = 'canje') canjes
                   from ev_p group by 1) s on s.b = g
      left join (select date_trunc(p_unidad, creado_en at time zone 'America/Costa_Rica') b, count(*) nuevos
                   from clientes where creado_en >= p_desde and creado_en < p_hasta group by 1) n on n.b = g
  ),
  'negocios', (
    select coalesce(json_agg(json_build_object(
             'id', n.id, 'nombre', n.nombre, 'slug', n.slug, 'activo', n.activo, 'creado_en', n.creado_en,
             'clientes', (select count(*) from clientes c where c.negocio_id = n.id),
             'nuevos', (select count(*) from clientes c
                         where c.negocio_id = n.id and c.creado_en >= p_desde and c.creado_en < p_hasta),
             'activos', (select count(distinct cliente_id) from ev_p where ev_p.negocio_id = n.id and tipo = 'sello'),
             'sellos', (select count(*) from ev_p where ev_p.negocio_id = n.id and tipo = 'sello'),
             'canjes', (select count(*) from ev_p where ev_p.negocio_id = n.id and tipo = 'canje'),
             'ultima', (select max(creado_en) from ev where ev.negocio_id = n.id)
           ) order by n.nombre), '[]'::json)
      from negocios n
  )
);
$$;

-- =========================================================
-- SEGURIDAD
-- RLS sin políticas = la anon/authenticated key de Supabase no puede leer ni
-- escribir nada. El backend usa la service_role, que ignora RLS.
-- =========================================================
alter table negocios enable row level security;
alter table staff enable row level security;
alter table clientes enable row level security;
alter table sellos_eventos enable row level security;
alter table wallet_passes enable row level security;
alter table apple_device_registrations enable row level security;
alter table wallet_sync_pendientes enable row level security;

-- Las funciones no deben poder llamarse vía /rpc con la anon key.
revoke execute on function sumar_sello(uuid, uuid, uuid) from public;
revoke execute on function canjear_premio(uuid, uuid, uuid) from public;
revoke execute on function encolar_sync_negocio(uuid) from public;
revoke execute on function analisis_negocio(uuid, timestamptz, timestamptz, text, timestamptz, timestamptz) from public;
revoke execute on function analisis_operador(timestamptz, timestamptz, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function sumar_sello(uuid, uuid, uuid) from anon, authenticated;
    revoke execute on function canjear_premio(uuid, uuid, uuid) from anon, authenticated;
    revoke execute on function encolar_sync_negocio(uuid) from anon, authenticated;
    revoke execute on function analisis_negocio(uuid, timestamptz, timestamptz, text, timestamptz, timestamptz) from anon, authenticated;
    revoke execute on function analisis_operador(timestamptz, timestamptz, text) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function sumar_sello(uuid, uuid, uuid) to service_role;
    grant execute on function canjear_premio(uuid, uuid, uuid) to service_role;
    grant execute on function encolar_sync_negocio(uuid) to service_role;
    grant execute on function analisis_negocio(uuid, timestamptz, timestamptz, text, timestamptz, timestamptz) to service_role;
    grant execute on function analisis_operador(timestamptz, timestamptz, text) to service_role;
  end if;
end;
$$;
