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
  unique (negocio_id, usuario)
);

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

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function sumar_sello(uuid, uuid, uuid) from anon, authenticated;
    revoke execute on function canjear_premio(uuid, uuid, uuid) from anon, authenticated;
    revoke execute on function encolar_sync_negocio(uuid) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function sumar_sello(uuid, uuid, uuid) to service_role;
    grant execute on function canjear_premio(uuid, uuid, uuid) to service_role;
    grant execute on function encolar_sync_negocio(uuid) to service_role;
  end if;
end;
$$;
