create table if not exists public.telegram_connection_codes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.telegram_connections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  telegram_chat_id text not null,
  telegram_user_id text,
  telegram_username text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_connections_company_chat_unique unique (company_id, telegram_chat_id)
);

create index if not exists telegram_connection_codes_company_id_idx
on public.telegram_connection_codes(company_id);

create index if not exists telegram_connection_codes_code_idx
on public.telegram_connection_codes(code);

create index if not exists telegram_connections_company_id_idx
on public.telegram_connections(company_id);

create index if not exists telegram_connections_chat_id_idx
on public.telegram_connections(telegram_chat_id);

drop trigger if exists telegram_connections_set_updated_at on public.telegram_connections;
create trigger telegram_connections_set_updated_at
before update on public.telegram_connections
for each row execute function public.set_updated_at();

alter table public.telegram_connection_codes enable row level security;
alter table public.telegram_connections enable row level security;

drop policy if exists "telegram connection codes select own company" on public.telegram_connection_codes;
create policy "telegram connection codes select own company"
on public.telegram_connection_codes
for select
to authenticated
using (company_id = public.current_company_id());

drop policy if exists "telegram connection codes insert own company" on public.telegram_connection_codes;
create policy "telegram connection codes insert own company"
on public.telegram_connection_codes
for insert
to authenticated
with check (company_id = public.current_company_id());

drop policy if exists "telegram connections select own company" on public.telegram_connections;
create policy "telegram connections select own company"
on public.telegram_connections
for select
to authenticated
using (company_id = public.current_company_id());

drop policy if exists "telegram connections insert own company" on public.telegram_connections;
create policy "telegram connections insert own company"
on public.telegram_connections
for insert
to authenticated
with check (company_id = public.current_company_id());

drop policy if exists "telegram connections update own company" on public.telegram_connections;
create policy "telegram connections update own company"
on public.telegram_connections
for update
to authenticated
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());
