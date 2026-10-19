-- Phase 2B: ordered parts, idempotent part commands, project detail, and access gates.
-- Existing project, default part, work item, and event rows are preserved.
alter table public.project_parts
  add column position bigint not null default 0 check (position between 0 and 9007199254740991),
  add constraint project_parts_project_position_key unique (project_id, position) deferrable initially deferred;

create table public.project_part_commands (
  user_id uuid not null references auth.users (id) on delete restrict,
  request_id uuid not null,
  project_id uuid not null,
  expected_revision bigint not null check (expected_revision >= 0),
  action jsonb not null check (jsonb_typeof(action) = 'object'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  primary key (user_id, request_id),
  constraint project_part_commands_owner_fk foreign key (project_id, user_id)
    references public.projects (id, user_id) on delete restrict
);
create index project_part_commands_project_idx on public.project_part_commands (project_id, created_at desc);
alter table public.project_part_commands enable row level security;
revoke all on public.project_part_commands from public, anon, authenticated;
-- Receipts are only exposed by the exact authenticated RPC retry.

create function private.can_read_counter_work_item(p_work_item_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (
    select 1 from public.work_items wi
    where wi.id = p_work_item_id and wi.user_id = auth.uid()
      and not exists (
        select 1 from public.project_parts part
        join public.projects project on project.id = part.project_id
        where part.work_item_id = wi.id
          and (part.deleted_at is not null or project.deleted_at is not null)
      )
  )
$function$;
revoke all on function private.can_read_counter_work_item(uuid) from public, anon, service_role;
grant execute on function private.can_read_counter_work_item(uuid) to authenticated;

drop policy "read own work items" on public.work_items;
create policy "read own work items" on public.work_items for select to authenticated
  using (private.can_read_counter_work_item(id));
drop policy "read own counters" on public.counters;
create policy "read own counters" on public.counters for select to authenticated
  using (private.can_read_counter_work_item(work_item_id));
drop policy "read own counter events" on public.counter_events;
create policy "read own counter events" on public.counter_events for select to authenticated
  using (private.can_read_counter_work_item(work_item_id));
drop policy "read own projects" on public.projects;
create policy "read own projects" on public.projects for select to authenticated
  using ((select auth.uid()) = user_id and deleted_at is null);
drop policy "read own project parts" on public.project_parts;
create policy "read own project parts" on public.project_parts for select to authenticated
  using ((select auth.uid()) = user_id and deleted_at is null and exists (
    select 1 from public.projects project where project.id = project_id and project.deleted_at is null
  ));

-- Keep the validated counter engine. This wrapper serializes part commands with project edits
-- and denies new counter writes after pause, completion, or soft deletion.
revoke execute on function private.apply_counter_command_internal(uuid,uuid,bigint,timestamptz,text,jsonb) from authenticated;
create or replace function public.apply_counter_command(
  p_command_id uuid, p_work_item_id uuid, p_expected_revision bigint,
  p_occurred_at timestamptz, p_device_id text, p_action jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_part_deleted_at timestamptz;
  v_project_deleted_at timestamptz;
  v_project_status text;
  v_linked boolean := false;
begin
  if auth.uid() is null or not exists (
    select 1 from public.work_items wi where wi.id = p_work_item_id and wi.user_id = auth.uid()
  ) then
    return jsonb_build_object('status', 'rejected', 'reason', '작업을 사용할 수 없습니다.');
  end if;
  select part.deleted_at, project.deleted_at, project.status, true
    into v_part_deleted_at, v_project_deleted_at, v_project_status, v_linked
    from public.project_parts part
    join public.projects project on project.id = part.project_id
    where part.work_item_id = p_work_item_id
    for update of project;
  if v_linked and (v_part_deleted_at is not null or v_project_deleted_at is not null or v_project_status <> 'active') then
    -- A previously committed command can still be acknowledged after a status change.
    if exists (select 1 from public.counter_events e where e.command_id = p_command_id and e.work_item_id = p_work_item_id) then
      return private.apply_counter_command_internal(p_command_id,p_work_item_id,p_expected_revision,p_occurred_at,p_device_id,p_action);
    end if;
    return jsonb_build_object('status', 'rejected', 'reason',
      case when v_project_status <> 'active' and v_project_deleted_at is null and v_part_deleted_at is null
        then '프로젝트를 진행 중으로 바꾼 뒤 카운트해 주세요.' else '삭제된 프로젝트 또는 파트에서는 카운트할 수 없습니다.' end);
  end if;
  return private.apply_counter_command_internal(p_command_id,p_work_item_id,p_expected_revision,p_occurred_at,p_device_id,p_action);
end;
$function$;
revoke all on function public.apply_counter_command(uuid,uuid,bigint,timestamptz,text,jsonb) from public, anon, service_role;
grant execute on function public.apply_counter_command(uuid,uuid,bigint,timestamptz,text,jsonb) to authenticated;

create function private.apply_project_part_command_internal(
  p_project_id uuid, p_request_id uuid, p_expected_revision bigint, p_action jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_user_id uuid := auth.uid();
  v_project public.projects%rowtype;
  v_receipt public.project_part_commands%rowtype;
  v_part public.project_parts%rowtype;
  v_neighbor public.project_parts%rowtype;
  v_type text;
  v_name text;
  v_part_id uuid;
  v_work_item_id uuid;
  v_position bigint;
  v_result jsonb;
begin
  if v_user_id is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_project_id is null or p_request_id is null or p_expected_revision is null or p_expected_revision < 0
    or p_action is null or jsonb_typeof(p_action) <> 'object' then
    raise exception 'invalid part command' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text || ':' || p_request_id::text, 0));
  select * into v_receipt from public.project_part_commands
    where user_id = v_user_id and request_id = p_request_id;
  if found then
    if v_receipt.project_id <> p_project_id or v_receipt.expected_revision <> p_expected_revision or v_receipt.action <> p_action then
      raise exception 'request ID reused with different content' using errcode = '22023';
    end if;
    return jsonb_set(v_receipt.result, '{status}', '"duplicate"'::jsonb);
  end if;
  select * into v_project from public.projects
    where id = p_project_id and user_id = v_user_id for update;
  if not found or v_project.deleted_at is not null then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  if v_project.revision <> p_expected_revision then
    return jsonb_build_object('status','conflict','latestRevision',v_project.revision);
  end if;
  v_type := p_action->>'type';
  if v_type = 'create' then
    if (select count(*) from pg_catalog.jsonb_object_keys(p_action)) <> 2
      or pg_catalog.jsonb_typeof(p_action->'name') <> 'string' then
      raise exception 'invalid part name' using errcode = '22023';
    end if;
    v_name := pg_catalog.btrim(p_action->>'name');
    if pg_catalog.char_length(v_name) not between 1 and 120 then raise exception 'invalid part name' using errcode = '22023'; end if;
    select coalesce(max(position), -1) + 1 into v_position from public.project_parts where project_id = p_project_id;
    v_work_item_id := (private.create_counter_work_item_internal()->'state'->>'workItemId')::uuid;
    insert into public.project_parts(project_id,user_id,work_item_id,name,position)
      values (p_project_id,v_user_id,v_work_item_id,v_name,v_position) returning id into v_part_id;
  elsif v_type in ('rename','move','delete') then
    if (p_action->>'partId') is null or (p_action->>'partId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid part ID' using errcode = '22023';
    end if;
    v_part_id := (p_action->>'partId')::uuid;
    select * into v_part from public.project_parts
      where id = v_part_id and project_id = p_project_id and user_id = v_user_id and deleted_at is null for update;
    if not found then raise exception 'part not found' using errcode = 'P0002'; end if;
    if v_type = 'rename' then
      if (select count(*) from pg_catalog.jsonb_object_keys(p_action)) <> 3
        or pg_catalog.jsonb_typeof(p_action->'name') <> 'string' then
        raise exception 'invalid part name' using errcode = '22023';
      end if;
      v_name := pg_catalog.btrim(p_action->>'name');
      if pg_catalog.char_length(v_name) not between 1 and 120 then raise exception 'invalid part name' using errcode = '22023'; end if;
      update public.project_parts set name = v_name, updated_at = pg_catalog.clock_timestamp() where id = v_part_id;
    elsif v_type = 'move' then
      if (select count(*) from pg_catalog.jsonb_object_keys(p_action)) <> 3
        or (p_action->>'direction') not in ('up','down') then raise exception 'invalid move direction' using errcode = '22023'; end if;
      if p_action->>'direction' = 'up' then
        select * into v_neighbor from public.project_parts
          where project_id = p_project_id and deleted_at is null and position < v_part.position
          order by position desc limit 1 for update;
      else
        select * into v_neighbor from public.project_parts
          where project_id = p_project_id and deleted_at is null and position > v_part.position
          order by position asc limit 1 for update;
      end if;
      if not found then
        v_result := jsonb_build_object('status','unchanged','projectRevision',v_project.revision);
        insert into public.project_part_commands(user_id,request_id,project_id,expected_revision,action,result)
          values (v_user_id,p_request_id,p_project_id,p_expected_revision,p_action,v_result);
        return v_result;
      end if;
      update public.project_parts set position = case when id = v_part.id then v_neighbor.position else v_part.position end,
        updated_at = pg_catalog.clock_timestamp() where id in (v_part.id,v_neighbor.id);
    else
      if (select count(*) from pg_catalog.jsonb_object_keys(p_action)) <> 2 then
        raise exception 'invalid delete command' using errcode = '22023';
      end if;
      if v_part.is_default then raise exception 'default part cannot be deleted' using errcode = '22023'; end if;
      update public.project_parts set deleted_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
        where id = v_part.id;
    end if;
  else
    raise exception 'invalid part command' using errcode = '22023';
  end if;
  update public.projects set revision = revision + 1, updated_at = pg_catalog.clock_timestamp() where id = p_project_id;
  v_result := jsonb_build_object('status','applied','projectRevision',v_project.revision + 1,
    'partId',v_part_id,'workItemId',v_work_item_id);
  insert into public.project_part_commands(user_id,request_id,project_id,expected_revision,action,result)
    values (v_user_id,p_request_id,p_project_id,p_expected_revision,p_action,v_result);
  return v_result;
end;
$function$;
revoke all on function private.apply_project_part_command_internal(uuid,uuid,bigint,jsonb) from public, anon, service_role;
grant execute on function private.apply_project_part_command_internal(uuid,uuid,bigint,jsonb) to authenticated;
create function public.apply_project_part_command(
  p_project_id uuid, p_request_id uuid, p_expected_revision bigint, p_action jsonb
) returns jsonb language sql security invoker set search_path = '' as $function$
  select private.apply_project_part_command_internal(p_project_id,p_request_id,p_expected_revision,p_action)
$function$;
revoke all on function public.apply_project_part_command(uuid,uuid,bigint,jsonb) from public, anon, service_role;
grant execute on function public.apply_project_part_command(uuid,uuid,bigint,jsonb) to authenticated;

create function public.get_project_detail(p_project_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'id',project.id,'name',project.name,'notes',project.notes,'status',project.status,
    'revision',project.revision,'updatedAt',project.updated_at,
    'parts',coalesce((select jsonb_agg(jsonb_build_object(
      'id',part.id,'name',part.name,'position',part.position,'isDefault',part.is_default,
      'workItemId',part.work_item_id,'workItemRevision',wi.revision,
      'stitch',stitch.current_value,'row',row_counter.current_value,
      'lastCountAt',last_event.occurred_at,'lastEventCreatedAt',last_event.created_at
    ) order by part.position,part.created_at)
    from public.project_parts part
    join public.work_items wi on wi.id = part.work_item_id
    join public.counters stitch on stitch.work_item_id = wi.id and stitch.counter_type = 'stitch'
    join public.counters row_counter on row_counter.work_item_id = wi.id and row_counter.counter_type = 'row'
    left join lateral (
      select e.occurred_at,e.created_at from public.counter_events e
      where e.work_item_id = wi.id and e.event_type in ('change','complete_row','set_value','undo')
      order by e.created_at desc,e.revision_after desc limit 1
    ) last_event on true
    where part.project_id = project.id and part.deleted_at is null), '[]'::jsonb)
  ) from public.projects project
  where project.id = p_project_id and project.user_id = auth.uid() and project.deleted_at is null
$function$;
revoke all on function public.get_project_detail(uuid) from public, anon, service_role;
grant execute on function public.get_project_detail(uuid) to authenticated;
