-- Phase 2A: projects own a default part linked one-to-one to an existing counter work item.
-- Physical deletion is restricted; project deletion only marks the project hidden.
alter table public.work_items add constraint work_items_id_user_key unique (id, user_id);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  creation_request_id uuid not null,
  creation_payload jsonb not null,
  name text not null check (char_length(name) between 1 and 120 and name = btrim(name)),
  notes text check (notes is null or char_length(notes) <= 5000),
  status text not null default 'active' check (status in ('active', 'paused', 'completed')),
  revision bigint not null default 0 check (revision between 0 and 9007199254740991),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint projects_id_user_key unique (id, user_id),
  constraint projects_user_request_key unique (user_id, creation_request_id)
);
create index projects_owner_visible_updated_idx on public.projects (user_id, updated_at desc) where deleted_at is null;

create table public.project_parts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  user_id uuid not null,
  work_item_id uuid not null,
  name text not null check (char_length(name) between 1 and 120 and name = btrim(name)),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint project_parts_project_owner_fk foreign key (project_id, user_id)
    references public.projects (id, user_id) on delete restrict,
  constraint project_parts_work_item_owner_fk foreign key (work_item_id, user_id)
    references public.work_items (id, user_id) on delete restrict,
  constraint project_parts_work_item_key unique (work_item_id)
);
create index project_parts_project_idx on public.project_parts (project_id);
create unique index project_parts_one_default_idx on public.project_parts (project_id) where is_default;

alter table public.projects enable row level security;
alter table public.project_parts enable row level security;
revoke all on public.projects from public, anon, authenticated;
revoke all on public.project_parts from public, anon, authenticated;
grant select on public.projects, public.project_parts to authenticated;
create policy "read own projects" on public.projects for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "read own project parts" on public.project_parts for select to authenticated
  using ((select auth.uid()) = user_id);

create function private.project_result(p_project_id uuid, p_status text)
returns jsonb language sql security definer set search_path = '' as $function$
  select jsonb_build_object(
    'result', p_status, 'id', p.id, 'name', p.name, 'notes', p.notes,
    'status', p.status, 'revision', p.revision, 'createdAt', p.created_at,
    'updatedAt', p.updated_at, 'deletedAt', p.deleted_at,
    'defaultPartId', part.id, 'workItemId', part.work_item_id
  )
  from public.projects p
  join public.project_parts part on part.project_id = p.id and part.is_default
  where p.id = p_project_id and p.user_id = auth.uid()
$function$;
revoke all on function private.project_result(uuid,text) from public, anon, authenticated, service_role;

create function private.create_project_internal(p_request_id uuid, p_name text, p_notes text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_user_id uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_payload jsonb;
  v_existing public.projects%rowtype;
  v_work_item_id uuid;
  v_project_id uuid;
begin
  if v_user_id is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_request_id is null then raise exception 'request ID required' using errcode = '22023'; end if;
  if char_length(v_name) not between 1 and 120 or char_length(v_notes) > 5000 then
    raise exception 'invalid project fields' using errcode = '22023';
  end if;
  v_payload := jsonb_build_object('name', v_name, 'notes', v_notes);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text || ':' || p_request_id::text, 0));
  select * into v_existing from public.projects where user_id = v_user_id and creation_request_id = p_request_id;
  if found then
    if v_existing.creation_payload <> v_payload then
      raise exception 'request ID reused with different content' using errcode = '22023';
    end if;
    return private.project_result(v_existing.id, 'duplicate');
  end if;
  v_work_item_id := (private.create_counter_work_item_internal()->'state'->>'workItemId')::uuid;
  insert into public.projects (user_id, creation_request_id, creation_payload, name, notes)
    values (v_user_id, p_request_id, v_payload, v_name, v_notes) returning id into v_project_id;
  insert into public.project_parts (project_id, user_id, work_item_id, name, is_default)
    values (v_project_id, v_user_id, v_work_item_id, '기본 파트', true);
  return private.project_result(v_project_id, 'created');
end;
$function$;
revoke all on function private.create_project_internal(uuid,text,text) from public, anon, service_role;
grant execute on function private.create_project_internal(uuid,text,text) to authenticated;
create function public.create_project(p_request_id uuid, p_name text, p_notes text default null)
returns jsonb language sql security invoker set search_path = '' as $function$
  select private.create_project_internal(p_request_id, p_name, p_notes)
$function$;
revoke all on function public.create_project(uuid,text,text) from public, anon, service_role;
grant execute on function public.create_project(uuid,text,text) to authenticated;

create function private.update_project_internal(p_project_id uuid, p_expected_revision bigint, p_name text, p_notes text, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_project public.projects%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if char_length(v_name) not between 1 and 120 or char_length(v_notes) > 5000 or p_status not in ('active', 'paused', 'completed') or p_status is null then
    raise exception 'invalid project fields' using errcode = '22023';
  end if;
  select * into v_project from public.projects where id = p_project_id and user_id = auth.uid() for update;
  if not found or v_project.deleted_at is not null then raise exception 'project not found' using errcode = 'P0002'; end if;
  if v_project.revision <> p_expected_revision then raise exception 'project revision conflict' using errcode = '40001'; end if;
  update public.projects set name = v_name, notes = v_notes, status = p_status,
    revision = revision + 1, updated_at = clock_timestamp() where id = p_project_id;
  return private.project_result(p_project_id, 'updated');
end;
$function$;
revoke all on function private.update_project_internal(uuid,bigint,text,text,text) from public, anon, service_role;
grant execute on function private.update_project_internal(uuid,bigint,text,text,text) to authenticated;
create function public.update_project(p_project_id uuid, p_expected_revision bigint, p_name text, p_notes text, p_status text)
returns jsonb language sql security invoker set search_path = '' as $function$
  select private.update_project_internal(p_project_id,p_expected_revision,p_name,p_notes,p_status)
$function$;
revoke all on function public.update_project(uuid,bigint,text,text,text) from public, anon, service_role;
grant execute on function public.update_project(uuid,bigint,text,text,text) to authenticated;

create function private.delete_project_internal(p_project_id uuid, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_project public.projects%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v_project from public.projects where id = p_project_id and user_id = auth.uid() for update;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  if v_project.deleted_at is not null then return private.project_result(p_project_id, 'duplicate'); end if;
  if v_project.revision <> p_expected_revision then raise exception 'project revision conflict' using errcode = '40001'; end if;
  update public.projects set deleted_at = clock_timestamp(), updated_at = clock_timestamp(), revision = revision + 1 where id = p_project_id;
  return private.project_result(p_project_id, 'deleted');
end;
$function$;
revoke all on function private.delete_project_internal(uuid,bigint) from public, anon, service_role;
grant execute on function private.delete_project_internal(uuid,bigint) to authenticated;
create function public.delete_project(p_project_id uuid, p_expected_revision bigint)
returns jsonb language sql security invoker set search_path = '' as $function$
  select private.delete_project_internal(p_project_id,p_expected_revision)
$function$;
revoke all on function public.delete_project(uuid,bigint) from public, anon, service_role;
grant execute on function public.delete_project(uuid,bigint) to authenticated;
