alter table public.telegram_connections
add column if not exists last_menu_message_id integer,
add column if not exists last_bot_message_id integer;

notify pgrst, 'reload schema';
