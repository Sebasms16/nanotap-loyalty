-- Enlaces por correo para abrir una tarjeta existente (2026-11-07). Paso aditivo.
-- Correr en el SQL Editor de Supabase ANTES de desplegar el código que lo usa.
-- Es re-ejecutable. Su contenido es el mismo de schema.sql para estas piezas.

create table if not exists enlaces_tarjeta (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  token_hash text not null unique,
  creado_en timestamptz not null default now(),
  expira_en timestamptz not null
);
create index if not exists idx_enlaces_tarjeta_cliente on enlaces_tarjeta(cliente_id, creado_en);
alter table enlaces_tarjeta enable row level security;
