-- Phase 2C-1: owner-scoped recovery without rewriting counter state/history.
alter table public.work_items add column recovery_revision bigint
  check (recovery_revision between 0 and 9007199254740991);

create table public.project_recovery_commands (
  user_id uuid not null references auth.users(id) on delete restrict,
  request_id uuid not null,
  project_id uuid not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, request_id),
  foreign key (project_id,user_id) references public.projects(id,user_id) on delete restrict
);
alter table public.project_recovery_commands enable row level security;
revoke all on public.project_recovery_commands from public, anon, authenticated;

create function public.get_deleted_projects()
returns jsonb language sql stable security definer set search_path = '' as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'name',p.name,'deletedAt',p.deleted_at,'status',p.status,'revision',p.revision
  ) order by p.deleted_at desc,p.id),'[]'::jsonb)
  from public.projects p where p.user_id=auth.uid() and p.deleted_at is not null
$function$;
revoke all on function public.get_deleted_projects() from public,anon,service_role;
grant execute on function public.get_deleted_projects() to authenticated;

create function public.get_deleted_project_parts(p_project_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare v_project public.projects%rowtype; v_items jsonb;
begin
  select * into v_project from public.projects where id=p_project_id and user_id=auth.uid() and deleted_at is null;
  if not found then raise exception 'project not found' using errcode='P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',part.id,'name',part.name,'deletedAt',part.deleted_at,'workItemId',part.work_item_id,
    'stitch',s.current_value,'row',r.current_value,'lastCountAt',last_event.occurred_at,
    'eventCount',(select count(*) from public.counter_events e where e.work_item_id=part.work_item_id)
  ) order by part.deleted_at desc,part.id),'[]'::jsonb) into v_items
  from public.project_parts part
  join public.counters s on s.work_item_id=part.work_item_id and s.counter_type='stitch'
  join public.counters r on r.work_item_id=part.work_item_id and r.counter_type='row'
  left join lateral (
    select e.occurred_at from public.counter_events e where e.work_item_id=part.work_item_id
    order by e.revision_after desc limit 1
  ) last_event on true
  where part.project_id=p_project_id and part.user_id=auth.uid() and part.deleted_at is not null;
  return jsonb_build_object('projectRevision',v_project.revision,'items',v_items);
end;
$function$;
revoke all on function public.get_deleted_project_parts(uuid) from public,anon,service_role;
grant execute on function public.get_deleted_project_parts(uuid) to authenticated;

create function private.restore_project_record_internal(
  p_project_id uuid,p_part_id uuid,p_request_id uuid,p_expected_revision bigint
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_user uuid:=auth.uid(); v_project public.projects%rowtype; v_part public.project_parts%rowtype;
  v_receipt public.project_recovery_commands%rowtype; v_payload jsonb; v_result jsonb;
  v_position bigint; v_changed boolean:=false;
begin
  if v_user is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_project_id is null or p_request_id is null or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740991 then
    raise exception 'invalid recovery request' using errcode='22023';
  end if;
  v_payload:=jsonb_build_object('projectId',p_project_id,'partId',p_part_id,'expectedRevision',p_expected_revision);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text||':'||p_request_id::text,0));
  select * into v_receipt from public.project_recovery_commands where user_id=v_user and request_id=p_request_id;
  if found then
    if v_receipt.payload<>v_payload then raise exception 'request ID reused with different content' using errcode='22023'; end if;
    return jsonb_set(v_receipt.result,'{status}','"duplicate"'::jsonb);
  end if;
  select * into v_project from public.projects where id=p_project_id and user_id=v_user for update;
  if not found then raise exception 'project not found' using errcode='P0002'; end if;
  if p_part_id is not null and v_project.deleted_at is not null then
    raise exception 'restore the project first' using errcode='22023';
  end if;
  if v_project.revision<>p_expected_revision then
    return jsonb_build_object('status','conflict','latestRevision',v_project.revision);
  end if;
  if p_part_id is null then
    if v_project.deleted_at is not null then
      update public.projects set deleted_at=null,revision=revision+1,updated_at=pg_catalog.clock_timestamp() where id=p_project_id;
      -- Individual part deletions stay deleted. Counter revision is never advanced by recovery.
      update public.work_items wi set recovery_revision=wi.revision
        from public.project_parts part where part.project_id=p_project_id and part.deleted_at is null and wi.id=part.work_item_id;
      v_changed:=true;
    end if;
  else
    select * into v_part from public.project_parts where id=p_part_id and project_id=p_project_id and user_id=v_user for update;
    if not found then raise exception 'part not found' using errcode='P0002'; end if;
    if v_part.deleted_at is not null then
      select coalesce(max(position),-1)+1 into v_position from public.project_parts where project_id=p_project_id;
      update public.project_parts set deleted_at=null,position=v_position,updated_at=pg_catalog.clock_timestamp() where id=p_part_id;
      update public.work_items set recovery_revision=revision where id=v_part.work_item_id;
      update public.projects set revision=revision+1,updated_at=pg_catalog.clock_timestamp() where id=p_project_id;
      v_changed:=true;
    end if;
  end if;
  v_result:=jsonb_build_object('status',case when v_changed then 'restored' else 'unchanged' end,
    'projectId',p_project_id,'partId',p_part_id,'projectRevision',v_project.revision+case when v_changed then 1 else 0 end);
  insert into public.project_recovery_commands(user_id,request_id,project_id,payload,result)
    values(v_user,p_request_id,p_project_id,v_payload,v_result);
  return v_result;
end;
$function$;
revoke all on function private.restore_project_record_internal(uuid,uuid,uuid,bigint) from public,anon,service_role;
grant execute on function private.restore_project_record_internal(uuid,uuid,uuid,bigint) to authenticated;
create function public.restore_project(p_project_id uuid,p_request_id uuid,p_expected_revision bigint)
returns jsonb language sql security invoker set search_path='' as $function$
  select private.restore_project_record_internal(p_project_id,null,p_request_id,p_expected_revision)
$function$;
revoke all on function public.restore_project(uuid,uuid,bigint) from public,anon,service_role;
grant execute on function public.restore_project(uuid,uuid,bigint) to authenticated;
create function public.restore_project_part(p_project_id uuid,p_part_id uuid,p_request_id uuid,p_expected_revision bigint)
returns jsonb language plpgsql security invoker set search_path='' as $function$
begin
  if p_part_id is null then raise exception 'part ID required' using errcode='22023'; end if;
  return private.restore_project_record_internal(p_project_id,p_part_id,p_request_id,p_expected_revision);
end;
$function$;
revoke all on function public.restore_project_part(uuid,uuid,uuid,bigint) from public,anon,service_role;
grant execute on function public.restore_project_part(uuid,uuid,uuid,bigint) to authenticated;
