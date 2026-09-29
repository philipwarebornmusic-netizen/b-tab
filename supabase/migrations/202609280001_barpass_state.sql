create table if not exists public.barpass_state (
  key text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.barpass_state enable row level security;

-- The Netlify function uses SUPABASE_SERVICE_ROLE_KEY server-side.
-- No browser/client role should read or write this table directly.
create policy "barpass_state_service_role_all"
  on public.barpass_state
  for all
  to service_role
  using (true)
  with check (true);
