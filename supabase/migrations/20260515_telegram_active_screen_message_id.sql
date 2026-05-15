alter table public.telegram_connections
add column if not exists active_screen_message_id integer;

notify pgrst, 'reload schema';
