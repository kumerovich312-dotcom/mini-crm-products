create or replace function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select profiles.company_id
  from public.profiles
  where profiles.user_id = auth.uid()
  limit 1
$$;

grant execute on function public.current_company_id() to authenticated;

do $$
declare
  policy_row record;
begin
  for policy_row in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'profiles',
        'companies',
        'categories',
        'products',
        'custom_fields',
        'product_custom_values',
        'product_media',
        'imports',
        'import_errors',
        'api_keys'
      )
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_row.policyname,
      policy_row.schemaname,
      policy_row.tablename
    );
  end loop;
end $$;

drop policy if exists "authenticated users can read product media files" on storage.objects;
drop policy if exists "authenticated users can upload product media files" on storage.objects;
drop policy if exists "authenticated users can update product media files" on storage.objects;
drop policy if exists "authenticated users can delete product media files" on storage.objects;
drop policy if exists "product media select own company" on storage.objects;
drop policy if exists "product media insert own company" on storage.objects;
drop policy if exists "product media update own company" on storage.objects;
drop policy if exists "product media delete own company" on storage.objects;

do $$
declare
  policy_row record;
begin
  for policy_row in
    select policyname
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (
        policyname like 'dev\_%' escape '\'
        or qual = 'true'
        or with_check = 'true'
      )
  loop
    execute format('drop policy if exists %I on storage.objects', policy_row.policyname);
  end loop;
end $$;

alter table public.companies enable row level security;
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.custom_fields enable row level security;
alter table public.product_custom_values enable row level security;
alter table public.product_media enable row level security;
alter table public.imports enable row level security;
alter table public.import_errors enable row level security;
alter table public.api_keys enable row level security;

create policy "profiles select own"
on public.profiles
for select
to authenticated
using (user_id = auth.uid());

create policy "profiles insert own"
on public.profiles
for insert
to authenticated
with check (user_id = auth.uid());

create policy "profiles update own"
on public.profiles
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "companies select own"
on public.companies
for select
to authenticated
using (id = public.current_company_id());

create policy "companies insert onboarding"
on public.companies
for insert
to authenticated
with check (auth.uid() is not null);

create policy "companies update own"
on public.companies
for update
to authenticated
using (id = public.current_company_id())
with check (id = public.current_company_id());

create policy "categories select own company"
on public.categories
for select
to authenticated
using (company_id = public.current_company_id());

create policy "categories insert own company"
on public.categories
for insert
to authenticated
with check (company_id = public.current_company_id());

create policy "categories update own company"
on public.categories
for update
to authenticated
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "categories delete own company"
on public.categories
for delete
to authenticated
using (company_id = public.current_company_id());

create policy "products select own company"
on public.products
for select
to authenticated
using (company_id = public.current_company_id());

create policy "products insert own company"
on public.products
for insert
to authenticated
with check (company_id = public.current_company_id());

create policy "products update own company"
on public.products
for update
to authenticated
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "products delete own company"
on public.products
for delete
to authenticated
using (company_id = public.current_company_id());

create policy "custom_fields select own company"
on public.custom_fields
for select
to authenticated
using (company_id = public.current_company_id());

create policy "custom_fields insert own company"
on public.custom_fields
for insert
to authenticated
with check (company_id = public.current_company_id());

create policy "custom_fields update own company"
on public.custom_fields
for update
to authenticated
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "custom_fields delete own company"
on public.custom_fields
for delete
to authenticated
using (company_id = public.current_company_id());

create policy "product_custom_values select own company"
on public.product_custom_values
for select
to authenticated
using (company_id = public.current_company_id());

create policy "product_custom_values insert own company"
on public.product_custom_values
for insert
to authenticated
with check (company_id = public.current_company_id());

create policy "product_custom_values update own company"
on public.product_custom_values
for update
to authenticated
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "product_custom_values delete own company"
on public.product_custom_values
for delete
to authenticated
using (company_id = public.current_company_id());

create policy "product_media select own company"
on public.product_media
for select
to authenticated
using (company_id = public.current_company_id());

create policy "product_media insert own company"
on public.product_media
for insert
to authenticated
with check (company_id = public.current_company_id());

create policy "product_media update own company"
on public.product_media
for update
to authenticated
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "product_media delete own company"
on public.product_media
for delete
to authenticated
using (company_id = public.current_company_id());

create policy "imports select own company"
on public.imports
for select
to authenticated
using (company_id = public.current_company_id());

create policy "imports insert own company"
on public.imports
for insert
to authenticated
with check (company_id = public.current_company_id());

create policy "imports update own company"
on public.imports
for update
to authenticated
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "imports delete own company"
on public.imports
for delete
to authenticated
using (company_id = public.current_company_id());

create policy "import_errors select own company"
on public.import_errors
for select
to authenticated
using (company_id = public.current_company_id());

create policy "import_errors insert own company"
on public.import_errors
for insert
to authenticated
with check (company_id = public.current_company_id());

create policy "import_errors update own company"
on public.import_errors
for update
to authenticated
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "import_errors delete own company"
on public.import_errors
for delete
to authenticated
using (company_id = public.current_company_id());

create policy "api_keys select own company"
on public.api_keys
for select
to authenticated
using (company_id = public.current_company_id());

create policy "api_keys insert own company"
on public.api_keys
for insert
to authenticated
with check (company_id = public.current_company_id());

create policy "api_keys update own company"
on public.api_keys
for update
to authenticated
using (company_id = public.current_company_id())
with check (company_id = public.current_company_id());

create policy "api_keys delete own company"
on public.api_keys
for delete
to authenticated
using (company_id = public.current_company_id());

create policy "product media select own company"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'product-media'
  and (storage.foldername(name))[1] = public.current_company_id()::text
);

create policy "product media insert own company"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'product-media'
  and (storage.foldername(name))[1] = public.current_company_id()::text
);

create policy "product media update own company"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'product-media'
  and (storage.foldername(name))[1] = public.current_company_id()::text
)
with check (
  bucket_id = 'product-media'
  and (storage.foldername(name))[1] = public.current_company_id()::text
);

create policy "product media delete own company"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'product-media'
  and (storage.foldername(name))[1] = public.current_company_id()::text
);
