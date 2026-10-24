-- Phase 3F-1: manual metadata, independent from counters, timers and project status.
-- Defaults apply to existing rows without inferring anything from their history.
alter table public.projects add column progress_percent integer default null,
  add constraint projects_progress_percent_check check (progress_percent between 0 and 100);
alter table public.project_parts add column status text not null default 'not_started',
  add constraint project_parts_status_check check (status in ('not_started','in_progress','paused','completed'));

-- Keep the existing project-part receipts/lock namespace and shared project revision.
-- No new client table-write privilege or RLS bypass path is introduced.
create function private.apply_project_tracking_command_internal(
  p_project_id uuid, p_request_id uuid, p_expected_revision bigint, p_action jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_user_id uuid := auth.uid();
  v_project public.projects%rowtype;
  v_part public.project_parts%rowtype;
  v_receipt public.project_part_commands%rowtype;
  v_part_id uuid;
  v_progress integer;
  v_numeric numeric;
  v_status text;
  v_change jsonb;
  v_changed boolean;
  v_result jsonb;
begin
  if v_user_id is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_project_id is null or p_request_id is null or p_expected_revision is null
    or p_expected_revision not between 0 and 9007199254740991
    or p_action is null or jsonb_typeof(p_action) <> 'object' then
    raise exception 'invalid tracking command' using errcode='22023';
  end if;
  -- Validate JSON before an integer cast so fractional input cannot be rounded.
  if p_action->>'type' = 'setProgress' then
    if (select count(*) from pg_catalog.jsonb_object_keys(p_action)) <> 2
      or not (p_action ? 'value') or jsonb_typeof(p_action->'value') not in ('number','null') then
      raise exception 'invalid project progress' using errcode='22023';
    end if;
    if jsonb_typeof(p_action->'value') = 'number' then
      v_numeric := (p_action->>'value')::numeric;
      if v_numeric not between 0 and 100 or pg_catalog.trunc(v_numeric) <> v_numeric then
        raise exception 'invalid project progress' using errcode='22023';
      end if;
      v_progress := v_numeric::integer;
    end if;
  elsif p_action->>'type' = 'setPartStatus' then
    if (select count(*) from pg_catalog.jsonb_object_keys(p_action)) <> 3
      or jsonb_typeof(p_action->'partId') is distinct from 'string'
      or (p_action->>'partId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(p_action->'status') is distinct from 'string'
      or p_action->>'status' not in ('not_started','in_progress','paused','completed') then
      raise exception 'invalid part status' using errcode='22023';
    end if;
    v_part_id := (p_action->>'partId')::uuid;
    v_status := p_action->>'status';
  else
    raise exception 'invalid tracking action' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text || ':' || p_request_id::text,0));
  select * into v_receipt from public.project_part_commands where user_id=v_user_id and request_id=p_request_id;
  if found then
    if v_receipt.project_id <> p_project_id or v_receipt.expected_revision <> p_expected_revision or v_receipt.action <> p_action then
      raise exception 'request ID reused with different content' using errcode='22023';
    end if;
    return jsonb_set(v_receipt.result,'{status}','"duplicate"'::jsonb);
  end if;
  select * into v_project from public.projects where id=p_project_id and user_id=v_user_id for update;
  if not found or v_project.deleted_at is not null then raise exception 'project not found' using errcode='P0002'; end if;
  if v_project.revision <> p_expected_revision then
    return jsonb_build_object('status','conflict','latestRevision',v_project.revision);
  end if;
  -- Metadata remains editable on paused/completed projects, like existing rename/move commands.
  if p_action->>'type' = 'setProgress' then
    v_changed := v_project.progress_percent is distinct from v_progress;
    v_change := jsonb_build_object('type','setProgress','before',v_project.progress_percent,'after',v_progress);
    if v_changed then update public.projects set progress_percent=v_progress where id=p_project_id; end if;
  else
    select * into v_part from public.project_parts
      where id=v_part_id and project_id=p_project_id and user_id=v_user_id and deleted_at is null for update;
    if not found then raise exception 'part not found' using errcode='P0002'; end if;
    v_changed := v_part.status <> v_status;
    v_change := jsonb_build_object('type','setPartStatus','partId',v_part_id,'before',v_part.status,'after',v_status);
    if v_changed then update public.project_parts set status=v_status,updated_at=pg_catalog.clock_timestamp() where id=v_part_id; end if;
  end if;
  if v_changed then
    update public.projects set revision=revision+1,updated_at=pg_catalog.clock_timestamp() where id=p_project_id;
  end if;
  v_result := jsonb_build_object('status',case when v_changed then 'applied' else 'unchanged' end,
    'projectId',p_project_id,'projectRevision',v_project.revision + case when v_changed then 1 else 0 end,'change',v_change);
  insert into public.project_part_commands(user_id,request_id,project_id,expected_revision,action,result)
    values(v_user_id,p_request_id,p_project_id,p_expected_revision,p_action,v_result);
  return v_result;
end;
$function$;
revoke all on function private.apply_project_tracking_command_internal(uuid,uuid,bigint,jsonb) from public,anon,service_role;
grant execute on function private.apply_project_tracking_command_internal(uuid,uuid,bigint,jsonb) to authenticated;
create function public.apply_project_tracking_command(
  p_project_id uuid,p_request_id uuid,p_expected_revision bigint,p_action jsonb
) returns jsonb language sql security invoker set search_path='' as $function$
  select private.apply_project_tracking_command_internal(p_project_id,p_request_id,p_expected_revision,p_action)
$function$;
revoke all on function public.apply_project_tracking_command(uuid,uuid,bigint,jsonb) from public,anon,service_role;
grant execute on function public.apply_project_tracking_command(uuid,uuid,bigint,jsonb) to authenticated;

-- Additive read fields only; existing ownership/deletion filters and counter projections are retained.
create or replace function private.project_result(p_project_id uuid, p_status text)
returns jsonb language sql security definer set search_path = '' as $function$
  select jsonb_build_object(
    'result', p_status, 'id', p.id, 'name', p.name, 'notes', p.notes,
    'progressPercent', p.progress_percent, 'status', p.status, 'revision', p.revision, 'createdAt', p.created_at,
    'updatedAt', p.updated_at, 'deletedAt', p.deleted_at,
    'defaultPartId', part.id, 'workItemId', part.work_item_id
  )
  from public.projects p
  join public.project_parts part on part.project_id = p.id and part.is_default
  where p.id = p_project_id and p.user_id = auth.uid()
$function$;

create or replace function public.get_project_detail(p_project_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'id',project.id,'name',project.name,'notes',project.notes,'status',project.status,
    'progressPercent',project.progress_percent,'revision',project.revision,'updatedAt',project.updated_at,
    'parts',coalesce((select jsonb_agg(jsonb_build_object(
      'id',part.id,'name',part.name,'status',part.status,'position',part.position,'isDefault',part.is_default,
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
