-- Franja de cashback sin texto (2026-11-06). Paso aditivo: no quita ni cambia datos existentes.
-- Correr en el SQL Editor de Supabase ANTES de desplegar el código que lo usa.
-- Es re-ejecutable. Su contenido es el mismo de schema.sql para estas piezas.

alter table negocios add column if not exists cashback_texto_franja boolean not null default true;

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
       n.puntos_tope_compra, n.puntos_espera_minutos, n.cashback_porcentaje, n.cashback_minimo, n.cashback_texto_franja
from negocios n;
