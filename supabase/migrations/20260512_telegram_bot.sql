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

create table if not exists public.telegram_product_drafts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  telegram_chat_id text not null,
  step text not null default 'idle',
  category_id uuid references public.categories(id) on delete set null,
  name text,
  price numeric(12, 2) not null default 0,
  stock integer not null default 0,
  description text,
  keywords text[] not null default '{}',
  media jsonb not null default '[]'::jsonb,
  created_product_id uuid references public.products(id) on delete set null,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists telegram_connections_company_id_idx
on public.telegram_connections(company_id);

create index if not exists telegram_connections_chat_id_idx
on public.telegram_connections(telegram_chat_id);

create index if not exists telegram_product_drafts_company_chat_idx
on public.telegram_product_drafts(company_id, telegram_chat_id);

drop trigger if exists telegram_connections_set_updated_at on public.telegram_connections;
create trigger telegram_connections_set_updated_at
before update on public.telegram_connections
for each row execute function public.set_updated_at();

drop trigger if exists telegram_product_drafts_set_updated_at on public.telegram_product_drafts;
create trigger telegram_product_drafts_set_updated_at
before update on public.telegram_product_drafts
for each row execute function public.set_updated_at();

alter table public.telegram_connections enable row level security;
alter table public.telegram_product_drafts enable row level security;

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

drop policy if exists "telegram product drafts select own company" on public.telegram_product_drafts;
create policy "telegram product drafts select own company"
on public.telegram_product_drafts
for select
to authenticated
using (company_id = public.current_company_id());

drop policy if exists "telegram product drafts insert own company" on public.telegram_product_drafts;
create policy "telegram product drafts insert own company"
on public.telegram_product_drafts
for insert
to authenticated
with check (company_id = public.current_company_id());

drop policy if exists "telegram product drafts update own company" on public.telegram_product_drafts;
create policy "telegram product drafts update own company"
on public.telegram_product_drafts
for update
to authenticated
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

drop policy if exists "telegram product drafts delete own company" on public.telegram_product_drafts;
create policy "telegram product drafts delete own company"
on public.telegram_product_drafts
for delete
to authenticated
using (company_id = public.current_company_id());
