grant usage on schema public to anon;
grant select on public.products to anon;
grant select on public.categories to anon;
grant select on public.product_media to anon;
grant select on public.custom_fields to anon;
grant select on public.product_custom_values to anon;

drop policy if exists "public api read visible products" on public.products;
drop policy if exists "public api read active categories" on public.categories;
drop policy if exists "public api read visible product media" on public.product_media;
drop policy if exists "public api read visible custom fields" on public.custom_fields;
drop policy if exists "public api read visible custom values" on public.product_custom_values;

create policy "public api read visible products"
on public.products
for select
to anon
using (
  company_id = '718f1a81-3a75-4484-901a-6054936be72c'::uuid
  and status = 'active'
  and is_visible_in_api = true
  and stock > 0
);

create policy "public api read active categories"
on public.categories
for select
to anon
using (
  company_id = '718f1a81-3a75-4484-901a-6054936be72c'::uuid
  and is_active = true
);

create policy "public api read visible product media"
on public.product_media
for select
to anon
using (
  company_id = '718f1a81-3a75-4484-901a-6054936be72c'::uuid
  and exists (
    select 1
    from public.products
    where products.id = product_media.product_id
      and products.company_id = product_media.company_id
      and products.status = 'active'
      and products.is_visible_in_api = true
      and products.stock > 0
  )
);

create policy "public api read visible custom fields"
on public.custom_fields
for select
to anon
using (
  company_id = '718f1a81-3a75-4484-901a-6054936be72c'::uuid
  and is_visible_in_api = true
);

create policy "public api read visible custom values"
on public.product_custom_values
for select
to anon
using (
  company_id = '718f1a81-3a75-4484-901a-6054936be72c'::uuid
  and exists (
    select 1
    from public.products
    where products.id = product_custom_values.product_id
      and products.company_id = product_custom_values.company_id
      and products.status = 'active'
      and products.is_visible_in_api = true
      and products.stock > 0
  )
  and exists (
    select 1
    from public.custom_fields
    where custom_fields.id = product_custom_values.custom_field_id
      and custom_fields.company_id = product_custom_values.company_id
      and custom_fields.is_visible_in_api = true
  )
);

notify pgrst, 'reload schema';
