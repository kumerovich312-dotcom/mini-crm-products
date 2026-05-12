alter table public.companies
add column if not exists sku_random_digits integer not null default 4;

alter table public.companies
add column if not exists company_code text;

create or replace function public.generate_company_code()
returns text
language plpgsql
as $$
declare
  candidate text;
begin
  loop
    candidate := lpad(floor(random() * 1000000)::int::text, 6, '0');
    exit when not exists (
      select 1
      from public.companies
      where company_code = candidate
    );
  end loop;

  return candidate;
end;
$$;

alter table public.companies
alter column company_code set default public.generate_company_code();

do $$
declare
  company_record record;
begin
  for company_record in
    select id
    from public.companies
    where company_code is null or company_code = ''
  loop
    update public.companies
    set company_code = public.generate_company_code()
    where id = company_record.id;
  end loop;
end;
$$;

create unique index if not exists companies_company_code_unique_idx
on public.companies(company_code);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'companies_sku_random_digits_check'
      and conrelid = 'public.companies'::regclass
  ) then
    alter table public.companies
    add constraint companies_sku_random_digits_check
    check (sku_random_digits in (4, 5, 6));
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'companies_company_code_check'
      and conrelid = 'public.companies'::regclass
  ) then
    alter table public.companies
    add constraint companies_company_code_check
    check (company_code ~ '^[0-9]{5,6}$');
  end if;
end;
$$;
