alter table public.profiles
add column if not exists user_id uuid references auth.users(id) on delete cascade;

update public.profiles
set user_id = id
where user_id is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_user_id_unique'
  ) then
    alter table public.profiles
    add constraint profiles_user_id_unique unique (user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'companies'
      and policyname = 'authenticated users can create company'
  ) then
    create policy "authenticated users can create company"
    on public.companies
    for insert
    to authenticated
    with check (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'users can create own profile'
  ) then
    create policy "users can create own profile"
    on public.profiles
    for insert
    to authenticated
    with check (user_id = auth.uid() or id = auth.uid());
  end if;
end $$;
