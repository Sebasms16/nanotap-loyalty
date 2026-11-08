-- Premios sorpresa (2026-11-07). Paso aditivo: no quita ni cambia datos existentes.
-- Correr en el SQL Editor de Supabase ANTES de desplegar el código que lo usa.
-- Es re-ejecutable. Su contenido es el mismo de schema.sql para estas piezas.

alter table negocios add column if not exists sorpresas_activas boolean not null default false;
alter table negocios add column if not exists sorpresas_probabilidad numeric(4, 1) not null default 5
  check (sorpresas_probabilidad between 0.5 and 50);
alter table negocios add column if not exists sorpresas_premios jsonb not null default '[]';
alter table negocios add column if not exists sorpresas_tope_mes integer check (sorpresas_tope_mes > 0);
alter table clientes add column if not exists sorpresa_pendiente text;

-- Premios sorpresa que salieron al sumar una estampa (sumar_sello) y su entrega.
create table if not exists premios_sorpresa (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id) on delete cascade,
  cliente_id uuid not null references clientes(id) on delete cascade,
  premio text not null,
  estampa integer not null,                 -- en qué estampa salió (ej. la 3 de 10)
  creado_en timestamptz not null default now(),
  entregado_en timestamptz,                 -- null = pendiente
  entregado_por uuid references staff(id) on delete set null
);
create index if not exists idx_premios_sorpresa_negocio on premios_sorpresa(negocio_id, creado_en);
create index if not exists idx_premios_sorpresa_cliente on premios_sorpresa(cliente_id, creado_en);
alter table premios_sorpresa enable row level security;

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
       n.puntos_tope_compra, n.puntos_espera_minutos, n.cashback_porcentaje, n.cashback_minimo, n.cashback_texto_franja,
       n.sorpresas_activas, n.sorpresas_probabilidad, n.sorpresas_premios, n.sorpresas_tope_mes
from negocios n;

create or replace function sumar_sello(p_cliente_id uuid, p_negocio_id uuid, p_staff_id uuid)
returns json
language plpgsql
set search_path = public
as $$
declare
  v_negocio_id uuid;
  v_n negocios%rowtype;
  v_meta integer;
  v_sellos integer;
  v_premios integer;
  v_desde timestamptz;
  v_premio text;
  v_sorpresa_id uuid;
  v_sorpresa json;
begin
  select c.negocio_id into v_negocio_id from clientes c where c.id = p_cliente_id for update;
  if not found then raise exception 'cliente_no_encontrado'; end if;
  if v_negocio_id <> p_negocio_id then raise exception 'cliente_de_otro_negocio'; end if;
  select * into v_n from negocios where id = p_negocio_id;
  if not v_n.activo then raise exception 'negocio_inactivo'; end if;
  if v_n.tipo_programa <> 'estampas' then raise exception 'programa_de_puntos'; end if; -- puntos o cashback
  v_meta := v_n.sellos_para_premio;

  update clientes
     set sellos_actuales = sellos_actuales + 1, ultima_actividad = now()
   where id = p_cliente_id
   returning sellos_actuales, premios_canjeados into v_sellos, v_premios;

  insert into sellos_eventos (cliente_id, staff_id, tipo) values (p_cliente_id, p_staff_id, 'sello');

  -- Premio sorpresa: al azar, nunca en la estampa que completa la tarjeta (esa ya trae
  -- premio), máximo uno por tarjeta (desde el último canje o reinicio) y sin pasar el tope del mes.
  if v_n.sorpresas_activas and v_sellos < v_meta and jsonb_array_length(v_n.sorpresas_premios) > 0
     and random() * 100 < v_n.sorpresas_probabilidad then
    select max(creado_en) into v_desde
      from sellos_eventos where cliente_id = p_cliente_id and tipo in ('canje', 'reinicio');
    if not exists (select 1 from premios_sorpresa
                    where cliente_id = p_cliente_id and creado_en > coalesce(v_desde, '-infinity'::timestamptz)) then
      -- El tope es de todo el negocio: se bloquea su fila para que dos estampas a la vez no lo pasen.
      perform 1 from negocios where id = p_negocio_id for update;
      if v_n.sorpresas_tope_mes is null or (
           select count(*) from premios_sorpresa
            where negocio_id = p_negocio_id
              and creado_en >= date_trunc('month', now() at time zone 'America/Costa_Rica') at time zone 'America/Costa_Rica'
         ) < v_n.sorpresas_tope_mes then
        v_premio := v_n.sorpresas_premios ->> floor(random() * jsonb_array_length(v_n.sorpresas_premios))::int;
        insert into premios_sorpresa (negocio_id, cliente_id, premio, estampa)
        values (p_negocio_id, p_cliente_id, v_premio, v_sellos)
        returning id into v_sorpresa_id;
        update clientes set sorpresa_pendiente = v_premio where id = p_cliente_id;
        v_sorpresa := json_build_object('id', v_sorpresa_id, 'premio', v_premio, 'estampa', v_sellos);
      end if;
    end if;
  end if;

  update wallet_passes set ultima_actualizacion = now() where cliente_id = p_cliente_id;

  return json_build_object(
    'sellos_actuales', v_sellos,
    'premios_canjeados', v_premios,
    'sellos_para_premio', v_meta,
    'premio_disponible', v_sellos >= v_meta,
    'sorpresa', v_sorpresa
  );
end;
$$;

-- El staff entrega un premio sorpresa pendiente.
create or replace function entregar_sorpresa(p_sorpresa_id uuid, p_negocio_id uuid, p_staff_id uuid)
returns json
language plpgsql
set search_path = public
as $$
declare
  v_cliente_id uuid;
  v_s premios_sorpresa%rowtype;
begin
  -- Primero el cliente (mismo orden de bloqueo que sumar_sello), después el premio.
  select cliente_id into v_cliente_id from premios_sorpresa where id = p_sorpresa_id;
  if not found then raise exception 'sorpresa_no_encontrada'; end if;
  perform 1 from clientes where id = v_cliente_id for update;
  select * into v_s from premios_sorpresa where id = p_sorpresa_id for update;
  if v_s.negocio_id <> p_negocio_id then raise exception 'cliente_de_otro_negocio'; end if;
  if not (select activo from negocios where id = p_negocio_id) then raise exception 'negocio_inactivo'; end if;
  if v_s.entregado_en is not null then raise exception 'sorpresa_ya_entregada'; end if;

  update premios_sorpresa set entregado_en = now(), entregado_por = p_staff_id where id = p_sorpresa_id;
  update clientes
     set sorpresa_pendiente = (select premio from premios_sorpresa
                                where cliente_id = v_cliente_id and entregado_en is null
                                order by creado_en desc limit 1),
         ultima_actividad = now()
   where id = v_cliente_id;
  update wallet_passes set ultima_actualizacion = now() where cliente_id = v_cliente_id;

  return json_build_object('premio', v_s.premio, 'cliente_id', v_cliente_id);
end;
$$;

revoke execute on function entregar_sorpresa(uuid, uuid, uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function entregar_sorpresa(uuid, uuid, uuid) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function entregar_sorpresa(uuid, uuid, uuid) to service_role;
  end if;
end;
$$;
