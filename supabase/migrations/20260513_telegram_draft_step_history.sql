alter table public.telegram_product_drafts
add column if not exists step_history jsonb not null default '[]'::jsonb;
