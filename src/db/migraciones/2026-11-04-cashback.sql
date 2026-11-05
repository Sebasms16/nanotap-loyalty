-- Programa de cashback (2026-11-04). Paso aditivo: no quita ni cambia datos existentes.
-- Correr en el SQL Editor de Supabase ANTES de desplegar el código que usa cashback.
-- Es re-ejecutable. Su contenido es el mismo de schema.sql para estas piezas.

alter table negocios drop constraint if exists negocios_tipo_programa_check;
alter table negocios add constraint negocios_tipo_programa_check check (tipo_programa in ('estampas', 'puntos', 'cashback'));
alter table negocios add column if not exists cashback_porcentaje numeric(4, 1) not null default 5
  check (cashback_porcentaje between 0.5 and 50);
alter table negocios add column if not exists cashback_minimo integer check (cashback_minimo > 0);

drop view if exists negocios_resumen;
create view negocios_resumen with (security_invoker = on) as
select n.id, n.nombre, n.slug, n.logo_url, n.color_primario, n.color_secundario,
       n.sellos_para_premio, n.descripcion_premio, n.activo, n.creado_en,
       (select count(*) from clientes c where c.negocio_id = n.id)::int as total_clientes,
       (select count(*) from staff s where s.negocio_id = n.id and s.activo)::int as total_staff,
       n.sello_url, n.color_fondo_sellos, n.reglas, n.estampas_urls, n.estampas_pendientes,
       n.ocultar_nombre, n.niveles_activos, n.niveles, n.temporada_meses, n.temporada_inicio,
       n.inactividad_meses, n.fondo_estampas_url, n.fondo_estampas_efecto, n.suscripcion_plan, n.suscripcion_inicio,
       n.estampa_final_url, n.tipo_programa, n.colones_por_punto, n.premios_puntos, n.puntos_factura_obligatoria,
       n.puntos_tope_compra, n.puntos_espera_minutos, n.cashback_porcentaje, n.cashback_minimo
from negocios n;

create or replace function sumar_sello(p_cliente_id uuid, p_negocio_id uuid, p_staff_id uuid)
returns json
language plpgsql
set search_path = public
as $$
declare
  v_negocio_id uuid;
  v_activo boolean;
  v_tipo text;
  v_meta integer;
  v_sellos integer;
  v_premios integer;
begin
  select c.negocio_id, n.activo, n.sellos_para_premio, n.tipo_programa
    into v_negocio_id, v_activo, v_meta, v_tipo
    from clientes c join negocios n on n.id = c.negocio_id
   where c.id = p_cliente_id
     for update of c;

  if not found then raise exception 'cliente_no_encontrado'; end if;
  if v_negocio_id <> p_negocio_id then raise exception 'cliente_de_otro_negocio'; end if;
  if not v_activo then raise exception 'negocio_inactivo'; end if;
  if v_tipo <> 'estampas' then raise exception 'programa_de_puntos'; end if; -- puntos o cashback

  update clientes
     set sellos_actuales = sellos_actuales + 1, ultima_actividad = now()
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
  v_tipo text;
begin
  select c.negocio_id, n.activo, n.sellos_para_premio, c.sellos_actuales, n.tipo_programa
    into v_negocio_id, v_activo, v_meta, v_sellos, v_tipo
    from clientes c join negocios n on n.id = c.negocio_id
   where c.id = p_cliente_id
     for update of c;

  if not found then raise exception 'cliente_no_encontrado'; end if;
  if v_negocio_id <> p_negocio_id then raise exception 'cliente_de_otro_negocio'; end if;
  if not v_activo then raise exception 'negocio_inactivo'; end if;
  if v_tipo <> 'estampas' then raise exception 'programa_de_puntos'; end if; -- puntos o cashback
  if v_sellos < v_meta then raise exception 'sellos_insuficientes'; end if;

  update clientes
     set sellos_actuales = sellos_actuales - v_meta,
         premios_canjeados = premios_canjeados + 1,
         ultima_actividad = now()
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

create or replace function sumar_puntos(
  p_cliente_id uuid, p_negocio_id uuid, p_staff_id uuid,
  p_monto integer, p_factura text default null, p_sin_tope boolean default false
)
returns json
language plpgsql
set search_path = public
as $$
declare
  v_negocio_id uuid;
  v_n negocios%rowtype;
  v_puntos integer;
  v_saldo integer;
  -- Misma factura escrita con espacios o minúsculas = la misma factura.
  v_factura text := nullif(upper(regexp_replace(coalesce(p_factura, ''), '\s', '', 'g')), '');
begin
  select c.negocio_id into v_negocio_id from clientes c where c.id = p_cliente_id for update;
  if not found then raise exception 'cliente_no_encontrado'; end if;
  if v_negocio_id <> p_negocio_id then raise exception 'cliente_de_otro_negocio'; end if;
  select * into v_n from negocios where id = p_negocio_id;
  if not v_n.activo then raise exception 'negocio_inactivo'; end if;
  if v_n.tipo_programa not in ('puntos', 'cashback') then raise exception 'programa_de_estampas'; end if;
  if p_monto is null or p_monto <= 0 or p_monto > 100000000 then raise exception 'monto_invalido'; end if;
  if v_n.puntos_factura_obligatoria and v_factura is null then raise exception 'factura_requerida'; end if;
  if v_n.puntos_tope_compra is not null and p_monto > v_n.puntos_tope_compra and not coalesce(p_sin_tope, false) then
    raise exception 'monto_sobre_tope';
  end if;
  if v_n.puntos_espera_minutos is not null and exists (
       select 1 from sellos_eventos
        where cliente_id = p_cliente_id and tipo = 'puntos'
          and creado_en > now() - make_interval(mins => v_n.puntos_espera_minutos)) then
    raise exception 'compra_muy_seguida';
  end if;

  if v_n.tipo_programa = 'cashback' then
    v_puntos := floor(p_monto * v_n.cashback_porcentaje / 100)::integer;
    if v_puntos < 1 then raise exception 'monto_sin_cashback'; end if;
  else
    v_puntos := p_monto / v_n.colones_por_punto; -- división entera: se redondea hacia abajo
    if v_puntos < 1 then raise exception 'monto_insuficiente'; end if;
  end if;

  if v_factura is not null then
    begin
      insert into facturas_puntos (negocio_id, factura, cliente_id) values (p_negocio_id, v_factura, p_cliente_id);
    exception when unique_violation then
      raise exception 'factura_repetida';
    end;
  end if;

  update clientes set puntos = puntos + v_puntos, ultima_actividad = now()
   where id = p_cliente_id returning puntos into v_saldo;
  insert into sellos_eventos (cliente_id, staff_id, tipo, cantidad, monto, factura)
  values (p_cliente_id, p_staff_id, 'puntos', v_puntos, p_monto, v_factura);
  update wallet_passes set ultima_actualizacion = now() where cliente_id = p_cliente_id;

  return json_build_object('puntos_actuales', v_saldo, 'puntos_sumados', v_puntos, 'monto', p_monto);
end;
$$;

create or replace function canjear_puntos(p_cliente_id uuid, p_negocio_id uuid, p_staff_id uuid, p_premio_id text)
returns json
language plpgsql
set search_path = public
as $$
declare
  v_negocio_id uuid;
  v_n negocios%rowtype;
  v_premio jsonb;
  v_costo integer;
  v_saldo integer;
  v_premios integer;
begin
  select c.negocio_id, c.puntos into v_negocio_id, v_saldo from clientes c where c.id = p_cliente_id for update;
  if not found then raise exception 'cliente_no_encontrado'; end if;
  if v_negocio_id <> p_negocio_id then raise exception 'cliente_de_otro_negocio'; end if;
  select * into v_n from negocios where id = p_negocio_id;
  if not v_n.activo then raise exception 'negocio_inactivo'; end if;
  if v_n.tipo_programa <> 'puntos' then raise exception 'programa_sin_catalogo'; end if;

  select e.valor into v_premio
    from jsonb_array_elements(v_n.premios_puntos) as e(valor)
   where e.valor->>'id' = p_premio_id
   limit 1;
  if v_premio is null then raise exception 'premio_no_encontrado'; end if;
  v_costo := (v_premio->>'puntos')::integer;
  if v_saldo < v_costo then raise exception 'puntos_insuficientes'; end if;

  update clientes
     set puntos = puntos - v_costo, premios_canjeados = premios_canjeados + 1, ultima_actividad = now()
   where id = p_cliente_id
   returning puntos, premios_canjeados into v_saldo, v_premios;
  insert into sellos_eventos (cliente_id, staff_id, tipo, cantidad, premio)
  values (p_cliente_id, p_staff_id, 'canje_puntos', -v_costo, v_premio->>'nombre');
  update wallet_passes set ultima_actualizacion = now() where cliente_id = p_cliente_id;

  return json_build_object('puntos_actuales', v_saldo, 'premios_canjeados', v_premios,
                           'premio', v_premio->>'nombre', 'puntos_usados', v_costo);
end;
$$;

create or replace function usar_cashback(p_cliente_id uuid, p_negocio_id uuid, p_staff_id uuid, p_monto integer)
returns json
language plpgsql
set search_path = public
as $$
declare
  v_negocio_id uuid;
  v_n negocios%rowtype;
  v_saldo integer;
  v_usos integer;
begin
  select c.negocio_id, c.puntos into v_negocio_id, v_saldo from clientes c where c.id = p_cliente_id for update;
  if not found then raise exception 'cliente_no_encontrado'; end if;
  if v_negocio_id <> p_negocio_id then raise exception 'cliente_de_otro_negocio'; end if;
  select * into v_n from negocios where id = p_negocio_id;
  if not v_n.activo then raise exception 'negocio_inactivo'; end if;
  if v_n.tipo_programa <> 'cashback' then raise exception 'programa_sin_cashback'; end if;
  if p_monto is null or p_monto <= 0 or p_monto > 100000000 then raise exception 'monto_invalido'; end if;
  if v_n.cashback_minimo is not null and v_saldo < v_n.cashback_minimo then raise exception 'saldo_bajo_minimo'; end if;
  if p_monto > v_saldo then raise exception 'saldo_insuficiente'; end if;

  update clientes
     set puntos = puntos - p_monto, premios_canjeados = premios_canjeados + 1, ultima_actividad = now()
   where id = p_cliente_id
   returning puntos, premios_canjeados into v_saldo, v_usos;
  insert into sellos_eventos (cliente_id, staff_id, tipo, cantidad, monto, premio)
  values (p_cliente_id, p_staff_id, 'canje_puntos', -p_monto, p_monto, 'Saldo de cashback');
  update wallet_passes set ultima_actualizacion = now() where cliente_id = p_cliente_id;

  return json_build_object('puntos_actuales', v_saldo, 'premios_canjeados', v_usos, 'usado', p_monto);
end;
$$;

create or replace function compras_en_rango(p_cliente_id uuid, p_desde timestamptz, p_hasta timestamptz)
returns bigint
language sql
stable
set search_path = public
as $$
  select coalesce(sum(monto), 0)::bigint
    from sellos_eventos
   where cliente_id = p_cliente_id and tipo = 'puntos' and creado_en >= p_desde and creado_en < p_hasta;
$$;

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
  -- Con puntos, cada compra cuenta como visita ('sello') y cada canje como canje.
  ev as (select e.id, e.cliente_id, e.staff_id, e.creado_en,
                case e.tipo when 'puntos' then 'sello' when 'canje_puntos' then 'canje' else e.tipo end as tipo
           from sellos_eventos e join cli c on c.id = e.cliente_id
          where e.tipo <> 'reinicio'),
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
  -- Avance de nivel en la temporada: tarjetas canjeadas, puntos ganados o, con cashback, colones comprados
  -- (se devuelve como 'canjes' para no cambiar el formato).
  'niveles', case when p_temporada_desde is null then null else (
    select coalesce(json_agg(json_build_object('canjes', k, 'clientes', n) order by k), '[]'::json)
      from (select coalesce(t.valor, 0) k, count(*) n
              from cli
              left join (select e.cliente_id,
                                case (select tipo_programa from negocios where id = p_negocio_id)
                                     when 'puntos' then coalesce(sum(e.cantidad) filter (where e.tipo = 'puntos'), 0)
                                     when 'cashback' then coalesce(sum(e.monto) filter (where e.tipo = 'puntos'), 0)
                                     else count(*) filter (where e.tipo = 'canje') end as valor
                           from sellos_eventos e join cli c2 on c2.id = e.cliente_id
                          where e.creado_en >= p_temporada_desde and e.creado_en < p_temporada_hasta
                          group by e.cliente_id) t on t.cliente_id = cli.id
             group by 1) x
  ) end
);
$$;

revoke execute on function usar_cashback(uuid, uuid, uuid, integer) from public;
revoke execute on function compras_en_rango(uuid, timestamptz, timestamptz) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function usar_cashback(uuid, uuid, uuid, integer) from anon, authenticated;
    revoke execute on function compras_en_rango(uuid, timestamptz, timestamptz) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function usar_cashback(uuid, uuid, uuid, integer) to service_role;
    grant execute on function compras_en_rango(uuid, timestamptz, timestamptz) to service_role;
  end if;
end;
$$;
