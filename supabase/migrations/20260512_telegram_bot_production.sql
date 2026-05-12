alter table public.telegram_product_drafts
add column if not exists mode text not null default 'idle';

alter table public.telegram_product_drafts
add column if not exists product_id uuid references public.products(id) on delete set null;

alter table public.telegram_product_drafts
add column if not exists custom_values jsonb not null default '{}'::jsonb;

alter table public.telegram_product_drafts
add column if not exists edit_field text;

alter table public.telegram_product_drafts enable row level security;

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
