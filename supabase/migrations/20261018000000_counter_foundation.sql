-- Phase 0: server-side counter foundation only. No project or timer tables.
-- All writes are withheld from API roles until the atomic command RPC is added in Phase 1.

create table public.work_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  revision bigint not null default 0 check (revision between 0 and 9007199254740991),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index work_items_user_created_idx
  on public.work_items (user_id, created_at desc);

create table public.counters (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references public.work_items (id) on delete restrict,
  counter_type text not null check (counter_type in ('stitch', 'row')),
  current_value bigint not null default 0 check (current_value between 0 and 9007199254740991),
  target_value bigint check (target_value is null or target_value between 1 and 9007199254740991),
  updated_at timestamptz not null default now(),
  constraint counters_work_item_type_key unique (work_item_id, counter_type)
);

-- The unique constraint also indexes lookups by work_item_id.

create table public.counter_events (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references public.work_items (id) on delete restrict,
  command_id uuid not null unique,
  device_id text not null check (char_length(device_id) between 1 and 128),
  event_type text not null check (event_type in (
    'change', 'complete_row', 'set_value', 'set_target', 'undo'
  )),
  previous_state jsonb not null check (jsonb_typeof(previous_state) = 'object'),
  next_state jsonb not null check (jsonb_typeof(next_state) = 'object'),
  revision_before bigint not null check (revision_before between 0 and 9007199254740990),
  revision_after bigint not null,
  undo_of_event_id uuid,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint counter_events_revision_step check (revision_after = revision_before + 1),
  constraint counter_events_undo_reference check (
    (event_type = 'undo' and undo_of_event_id is not null) or
    (event_type <> 'undo' and undo_of_event_id is null)
  ),
  constraint counter_events_id_work_item_key unique (id, work_item_id),
  constraint counter_events_undo_same_work_item_fk
    foreign key (undo_of_event_id, work_item_id)
    references public.counter_events (id, work_item_id) on delete restrict
);

create index counter_events_work_item_created_idx
  on public.counter_events (work_item_id, created_at desc);

create unique index counter_events_work_item_revision_idx
  on public.counter_events (work_item_id, revision_after);

create function public.reject_counter_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'counter_events is append-only';
end;
$$;

create trigger counter_events_append_only
before update or delete on public.counter_events
for each row execute function public.reject_counter_event_mutation();

alter table public.work_items enable row level security;
alter table public.counters enable row level security;
alter table public.counter_events enable row level security;

-- Supabase projects may have broad default grants. Remove them explicitly.
revoke all on public.work_items from public, anon, authenticated;
revoke all on public.counters from public, anon, authenticated;
revoke all on public.counter_events from public, anon, authenticated;

grant select on public.work_items to authenticated;
grant select on public.counters to authenticated;
grant select on public.counter_events to authenticated;

create policy "read own work items"
  on public.work_items for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "read own counters"
  on public.counters for select to authenticated
  using (exists (
    select 1 from public.work_items wi
    where wi.id = counters.work_item_id
      and wi.user_id = (select auth.uid())
  ));

create policy "read own counter events"
  on public.counter_events for select to authenticated
  using (exists (
    select 1 from public.work_items wi
    where wi.id = counter_events.work_item_id
      and wi.user_id = (select auth.uid())
  ));
