create extension if not exists pgcrypto;

insert into storage.buckets (id, name, public)
values ('product-media', 'product-media', true)
on conflict (id) do update set public = true;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  sku_prefix text not null,
  currency text not null default 'KGS',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_slug_unique unique (slug),
  constraint companies_sku_prefix_check check (sku_prefix ~ '^[A-Za-z0-9]{2,6}$')
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  email text not null,
  full_name text,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_email_unique unique (email),
  constraint profiles_role_check check (role in ('owner', 'admin', 'member'))
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  code text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint categories_company_name_unique unique (company_id, name),
  constraint categories_company_code_unique unique (company_id, code),
  constraint categories_code_check check (code ~ '^[0-9]{3}$')
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  category_id uuid references public.categories(id) on delete set null,
  name text not null,
  sku text not null,
  price numeric(12, 2) not null default 0,
  stock integer not null default 0,
  status text not null default 'draft',
  description text,
  keywords text[] not null default '{}',
  is_visible_in_api boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_company_sku_unique unique (company_id, sku),
  constraint products_price_check check (price >= 0),
  constraint products_stock_check check (stock >= 0),
  constraint products_status_check check (status in ('active', 'hidden', 'out_of_stock', 'draft'))
);

create table public.product_media (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  type text not null,
  original_url text not null,
  optimized_url text,
  thumbnail_url text,
  file_name text,
  mime_type text,
  original_size bigint,
  optimized_size bigint,
  processing_status text not null default 'uploaded',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_media_type_check check (type in ('photo', 'video')),
  constraint product_media_status_check check (processing_status in ('uploaded', 'processing', 'ready', 'failed')),
  constraint product_media_original_size_check check (original_size is null or original_size >= 0),
  constraint product_media_optimized_size_check check (optimized_size is null or optimized_size >= 0)
);

create table public.custom_fields (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  key text not null,
  field_type text not null,
  unit text,
  options jsonb,
  is_required boolean not null default false,
  is_visible_in_api boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint custom_fields_company_name_unique unique (company_id, name),
  constraint custom_fields_company_key_unique unique (company_id, key),
  constraint custom_fields_key_check check (key ~ '^[A-Za-z0-9_]+$'),
  constraint custom_fields_type_check check (field_type in ('text', 'number', 'select', 'boolean'))
);

create table public.product_custom_values (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  custom_field_id uuid not null references public.custom_fields(id) on delete cascade,
  value_text text,
  value_number numeric(12, 2),
  value_boolean boolean,
  value_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_custom_values_unique unique (product_id, custom_field_id)
);

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  token_hash text not null,
  token_prefix text not null,
  is_active boolean not null default true,
  last_used_at timestamptz,
  daily_limit integer not null default 5000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_keys_company_name_unique unique (company_id, name),
  constraint api_keys_token_hash_unique unique (token_hash),
  constraint api_keys_daily_limit_check check (daily_limit > 0)
);

create table public.imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  file_name text not null,
  file_url text,
  file_size_bytes bigint,
  status text not null default 'uploaded',
  total_rows integer not null default 0,
  success_rows integer not null default 0,
  error_rows integer not null default 0,
  created_products integer not null default 0,
  updated_products integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint imports_status_check check (status in ('uploaded', 'preview', 'mapping', 'validating', 'completed', 'failed')),
  constraint imports_file_size_check check (file_size_bytes is null or file_size_bytes >= 0),
  constraint imports_rows_check check (
    total_rows >= 0 and success_rows >= 0 and error_rows >= 0 and created_products >= 0 and updated_products >= 0
  )
);

create table public.import_errors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  import_id uuid not null references public.imports(id) on delete cascade,
  row_number integer not null,
  field_name text not null,
  raw_value text,
  error_message text not null,
  recommendation text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_errors_row_number_check check (row_number > 0)
);

create index profiles_company_id_idx on public.profiles(company_id);
create index categories_company_id_idx on public.categories(company_id);
create index categories_company_sort_order_idx on public.categories(company_id, sort_order);
create index products_company_id_idx on public.products(company_id);
create index products_company_category_id_idx on public.products(company_id, category_id);
create index products_company_status_idx on public.products(company_id, status);
create index products_company_is_visible_in_api_idx on public.products(company_id, is_visible_in_api);
create index products_keywords_gin_idx on public.products using gin(keywords);
create index product_media_company_product_id_idx on public.product_media(company_id, product_id);
create index custom_fields_company_id_idx on public.custom_fields(company_id);
create index custom_fields_company_sort_order_idx on public.custom_fields(company_id, sort_order);
create index product_custom_values_company_product_id_idx on public.product_custom_values(company_id, product_id);
create index product_custom_values_custom_field_id_idx on public.product_custom_values(custom_field_id);
create index api_keys_company_id_idx on public.api_keys(company_id);
create index imports_company_id_idx on public.imports(company_id);
create index imports_company_status_idx on public.imports(company_id, status);
create index import_errors_company_import_id_idx on public.import_errors(company_id, import_id);

create trigger companies_set_updated_at
before update on public.companies
for each row execute function public.set_updated_at();

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger categories_set_updated_at
before update on public.categories
for each row execute function public.set_updated_at();

create trigger products_set_updated_at
before update on public.products
for each row execute function public.set_updated_at();

create trigger product_media_set_updated_at
before update on public.product_media
for each row execute function public.set_updated_at();

create trigger custom_fields_set_updated_at
before update on public.custom_fields
for each row execute function public.set_updated_at();

create trigger product_custom_values_set_updated_at
before update on public.product_custom_values
for each row execute function public.set_updated_at();

create trigger api_keys_set_updated_at
before update on public.api_keys
for each row execute function public.set_updated_at();

create trigger imports_set_updated_at
before update on public.imports
for each row execute function public.set_updated_at();

create trigger import_errors_set_updated_at
before update on public.import_errors
for each row execute function public.set_updated_at();

alter table public.companies enable row level security;
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_media enable row level security;
alter table public.custom_fields enable row level security;
alter table public.product_custom_values enable row level security;
alter table public.api_keys enable row level security;
alter table public.imports enable row level security;
alter table public.import_errors enable row level security;

create policy "users can read own company"
on public.companies
for select
to authenticated
using (
  id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
);

create policy "users can update own company"
on public.companies
for update
to authenticated
using (
  id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
)
with check (
  id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
);

create policy "users can read profiles in own company"
on public.profiles
for select
to authenticated
using (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
);

create policy "users can update own profile"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create policy "company access categories"
on public.categories
for all
to authenticated
using (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
)
with check (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
);

create policy "company access products"
on public.products
for all
to authenticated
using (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
)
with check (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
);

create policy "company access product_media"
on public.product_media
for all
to authenticated
using (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
)
with check (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
);

create policy "authenticated users can read product media files"
on storage.objects
for select
to authenticated
using (bucket_id = 'product-media');

create policy "authenticated users can upload product media files"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'product-media');

create policy "authenticated users can update product media files"
on storage.objects
for update
to authenticated
using (bucket_id = 'product-media')
with check (bucket_id = 'product-media');

create policy "authenticated users can delete product media files"
on storage.objects
for delete
to authenticated
using (bucket_id = 'product-media');

create policy "company access custom_fields"
on public.custom_fields
for all
to authenticated
using (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
)
with check (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
);

create policy "company access product_custom_values"
on public.product_custom_values
for all
to authenticated
using (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
)
with check (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
);

create policy "company access api_keys"
on public.api_keys
for all
to authenticated
using (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
)
with check (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
);

create policy "company access imports"
on public.imports
for all
to authenticated
using (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
)
with check (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
);

create policy "company access import_errors"
on public.import_errors
for all
to authenticated
using (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
)
with check (
  company_id in (
    select company_id
    from public.profiles
    where profiles.id = auth.uid()
  )
);
