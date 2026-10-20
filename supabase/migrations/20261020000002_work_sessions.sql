-- Phase 3A: timestamp-based work sessions. Existing counters/history are untouched.
create table public.work_sessions (
  id uuid primary key,
  user_id uuid not null,
  work_item_id uuid not null,
  status text not null check(status in ('running','paused','ended')),
  started_at timestamptz not null check(isfinite(started_at) and started_at >= timestamptz '1970-01-01Z'),
  ended_at timestamptz,
  accumulated_ms bigint not null default 0 check(accumulated_ms between 0 and 9007199254740991),
  last_resumed_at timestamptz,
  last_transition_at timestamptz not null,
  revision bigint not null check(revision between 1 and 9007199254740991),
  last_command_id uuid not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(id,user_id,work_item_id),
  unique(id,user_id),
  foreign key(work_item_id,user_id) references public.work_items(id,user_id) on delete restrict,
  check(isfinite(last_transition_at) and last_transition_at>=started_at),
  check(created_at=started_at and updated_at=last_transition_at),
  check(started_at=date_trunc('milliseconds',started_at) and last_transition_at=date_trunc('milliseconds',last_transition_at)),
  check(accumulated_ms <= floor(extract(epoch from (last_transition_at-started_at))*1000)),
  check((status='running' and last_resumed_at is not null and last_resumed_at=last_transition_at and ended_at is null)
     or (status='paused' and last_resumed_at is null and ended_at is null)
     or (status='ended' and last_resumed_at is null and ended_at is not null and ended_at=last_transition_at))
);
create unique index work_sessions_one_active_owner_idx on public.work_sessions(user_id) where status in ('running','paused');
create index work_sessions_work_history_idx on public.work_sessions(work_item_id,started_at desc);
create table public.work_session_events (
  user_id uuid not null,
  command_id uuid not null,
  session_id uuid not null,
  work_item_id uuid not null,
  revision_after bigint not null check(revision_after between 1 and 9007199254740991),
  event_type text not null check(event_type in ('start','pause','resume','end')),
  occurred_at timestamptz not null check(isfinite(occurred_at)),
  effective_at timestamptz not null check(isfinite(effective_at)),
  device_id text not null check(char_length(btrim(device_id)) between 1 and 120 and char_length(device_id)<=120),
  command jsonb not null check(jsonb_typeof(command)='object'),
  before_state jsonb check(before_state is null or jsonb_typeof(before_state)='object'),
  after_state jsonb not null check(jsonb_typeof(after_state)='object'),
  result jsonb not null check(jsonb_typeof(result)='object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(user_id,command_id),
  unique(session_id,revision_after),
  foreign key(session_id,user_id,work_item_id) references public.work_sessions(id,user_id,work_item_id) on delete restrict
);
alter table public.work_sessions add constraint work_sessions_last_command_fk
  foreign key(user_id,last_command_id) references public.work_session_events(user_id,command_id) deferrable initially deferred;
-- Reserved storage for a future explicit correction RPC. Baseline accumulated_ms is never edited by corrections.
create table public.work_session_time_adjustments (
  id uuid primary key,
  user_id uuid not null,
  session_id uuid not null,
  command_id uuid not null,
  previous_adjusted_ms bigint not null check(previous_adjusted_ms between 0 and 9007199254740991),
  adjusted_ms bigint not null check(adjusted_ms between 0 and 9007199254740991),
  reason text not null check(char_length(btrim(reason)) between 1 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,command_id),
  foreign key(session_id,user_id) references public.work_sessions(id,user_id) on delete restrict
);
create index work_session_adjustments_session_idx on public.work_session_time_adjustments(session_id,created_at);
create function private.reject_work_session_history_change()
returns trigger language plpgsql set search_path='' as $fn$
begin raise exception 'work session history is append only' using errcode='23514'; end;
$fn$;
revoke all on function private.reject_work_session_history_change() from public,anon,authenticated,service_role;
create trigger work_session_events_append_only before update or delete on public.work_session_events
  for each row execute function private.reject_work_session_history_change();
create trigger work_session_adjustments_append_only before update or delete on public.work_session_time_adjustments
  for each row execute function private.reject_work_session_history_change();

alter table public.work_sessions enable row level security;
alter table public.work_session_events enable row level security;
alter table public.work_session_time_adjustments enable row level security;
revoke all on public.work_sessions,public.work_session_events,public.work_session_time_adjustments from public,anon,authenticated;
grant select on public.work_sessions,public.work_session_events,public.work_session_time_adjustments to authenticated;
-- Own session history stays readable after project deletion; its immutable work-item FK preserves attribution.
create policy "read own sessions" on public.work_sessions for select to authenticated using(user_id=(select auth.uid()));
create policy "read own session events" on public.work_session_events for select to authenticated using(user_id=(select auth.uid()));
create policy "read own time adjustments" on public.work_session_time_adjustments for select to authenticated using(user_id=(select auth.uid()));

create function private.work_session_state(p_session_id uuid)
returns jsonb language sql stable security definer set search_path='' as $fn$
  select jsonb_build_object('sessionId',s.id,'userId',s.user_id,'workItemId',s.work_item_id,'status',s.status,
    'startedAt',s.started_at,'endedAt',s.ended_at,'accumulatedMs',s.accumulated_ms,
    'lastResumedAt',s.last_resumed_at,'lastTransitionAt',s.last_transition_at,
    'revision',s.revision,'createdAt',s.created_at,'updatedAt',s.updated_at)
  from public.work_sessions s where s.id=p_session_id and s.user_id=auth.uid()
$fn$;
revoke all on function private.work_session_state(uuid) from public,anon,authenticated,service_role;

create function public.get_work_session(p_session_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare v_id uuid; v_events jsonb;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='28000'; end if;
  select id into v_id from public.work_sessions where user_id=auth.uid() and
    ((p_session_id is null and status in ('running','paused')) or id=p_session_id);
  if v_id is null and p_session_id is not null then raise exception 'session not found' using errcode='P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('eventId',command_id,'command',command,'effectiveAt',effective_at,
    'before',before_state,'after',after_state) order by revision_after),'[]'::jsonb) into v_events
    from public.work_session_events where session_id=v_id and user_id=auth.uid();
  return jsonb_build_object('state',private.work_session_state(v_id),'events',v_events,
    'serverNow',date_trunc('milliseconds',clock_timestamp()));
end;
$fn$;
revoke all on function public.get_work_session(uuid) from public,anon,service_role;
grant execute on function public.get_work_session(uuid) to authenticated;

create function public.apply_work_session_command(
  p_command_id uuid,p_session_id uuid,p_work_item_id uuid,p_expected_revision bigint,
  p_occurred_at timestamptz,p_device_id text,p_action text
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  v_user uuid:=auth.uid(); v_session public.work_sessions%rowtype; v_event public.work_session_events%rowtype;
  v_project_id uuid; v_linked_project_id uuid; v_project public.projects%rowtype; v_part public.project_parts%rowtype;
  v_before jsonb; v_after jsonb; v_command jsonb; v_result jsonb; v_now timestamptz; v_ms bigint;
begin
  if v_user is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_command_id is null or p_session_id is null or p_work_item_id is null or p_expected_revision is null
    or p_expected_revision not between 0 and 9007199254740990 or p_occurred_at is null or not isfinite(p_occurred_at)
    or p_occurred_at<timestamptz '1970-01-01Z' or p_occurred_at>=timestamptz '10000-01-01Z' or p_occurred_at<>date_trunc('milliseconds',p_occurred_at)
    or p_device_id is null or char_length(btrim(p_device_id)) not between 1 and 120 or char_length(p_device_id)>120
    or p_action is null or p_action not in ('start','pause','resume','end') then
    return jsonb_build_object('status','rejected','reason','invalid_command'); end if;
  v_command:=jsonb_build_object('commandId',p_command_id,'sessionId',p_session_id,'workItemId',p_work_item_id,
    'expectedRevision',p_expected_revision,'occurredAt',p_occurred_at,'deviceId',p_device_id,'action',p_action);
  -- Match existing project/counter lock ordering: project -> work item -> user timer lock.
  if not exists(select 1 from public.work_items where id=p_work_item_id and user_id=v_user) then
    return jsonb_build_object('status','rejected','reason','work_item_unavailable'); end if;
  select project_id into v_project_id from public.project_parts where work_item_id=p_work_item_id and user_id=v_user;
  if v_project_id is not null then
    select * into v_project from public.projects where id=v_project_id and user_id=v_user for update;
  end if;
  perform 1 from public.work_items where id=p_work_item_id and user_id=v_user for update;
  if not found then return jsonb_build_object('status','rejected','reason','work_item_unavailable'); end if;
  select * into v_part from public.project_parts where work_item_id=p_work_item_id and user_id=v_user;
  v_linked_project_id:=v_part.project_id;
  if v_linked_project_id is distinct from v_project_id then
    return jsonb_build_object('status','rejected','reason','work_item_link_changed'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text||':work-session',0));
  select * into v_event from public.work_session_events where user_id=v_user and command_id=p_command_id;
  if found then
    if v_event.command<>v_command then return jsonb_build_object('status','rejected','reason','command_id_reused'); end if;
    return jsonb_set(v_event.result,'{status}','"duplicate"'::jsonb);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('work-session-id:'||p_session_id::text,0));
  select * into v_session from public.work_sessions where id=p_session_id and user_id=v_user for update;
  if v_session.id is not null and v_session.work_item_id<>p_work_item_id then
    return jsonb_build_object('status','rejected','reason','session_identity_mismatch'); end if;
  if coalesce(v_session.revision,0)<>p_expected_revision then
    return jsonb_build_object('status','conflict','current',private.work_session_state(p_session_id)); end if;
  if p_action in ('start','resume') and v_project_id is not null
    and (v_project.status<>'active' or v_project.deleted_at is not null or v_part.deleted_at is not null) then
    return jsonb_build_object('status','rejected','reason','project_or_part_unavailable'); end if;
  if p_action='start' then
    if v_session.id is not null then return jsonb_build_object('status','rejected','reason','session_already_exists'); end if;
    if exists(select 1 from public.work_sessions where user_id=v_user and status in ('running','paused')) then
      return jsonb_build_object('status','rejected','reason','active_session_exists'); end if;
    if exists(select 1 from public.work_sessions where id=p_session_id) then
      return jsonb_build_object('status','rejected','reason','session_identity_mismatch'); end if;
  else
    if v_session.id is null then return jsonb_build_object('status','rejected','reason','session_not_found'); end if;
    if v_session.status='ended' then return jsonb_build_object('status','rejected','reason','session_ended'); end if;
    if (p_action='pause' and v_session.status<>'running') or (p_action='resume' and v_session.status<>'paused') then
      return jsonb_build_object('status','rejected','reason','invalid_transition'); end if;
  end if;
  v_now:=date_trunc('milliseconds',clock_timestamp());
  v_before:=private.work_session_state(p_session_id);
  if p_action='start' then
    insert into public.work_sessions(id,user_id,work_item_id,status,started_at,last_resumed_at,last_transition_at,
      revision,last_command_id,created_at,updated_at)
      values(p_session_id,v_user,p_work_item_id,'running',v_now,v_now,v_now,1,p_command_id,v_now,v_now);
  else
    if v_now<v_session.last_transition_at then return jsonb_build_object('status','rejected','reason','clock_before_last_transition'); end if;
    v_ms:=v_session.accumulated_ms;
    if v_session.status='running' then v_ms:=v_ms+floor(extract(epoch from (v_now-v_session.last_resumed_at))*1000)::bigint; end if;
    if v_ms>9007199254740991 then return jsonb_build_object('status','rejected','reason','elapsed_out_of_range'); end if;
    update public.work_sessions set
      status=case p_action when 'pause' then 'paused' when 'resume' then 'running' else 'ended' end,
      accumulated_ms=v_ms,last_resumed_at=case when p_action='resume' then v_now else null end,
      ended_at=case when p_action='end' then v_now else null end,last_transition_at=v_now,
      revision=revision+1,last_command_id=p_command_id,updated_at=v_now where id=p_session_id;
  end if;
  v_after:=private.work_session_state(p_session_id);
  v_result:=jsonb_build_object('status','applied','state',v_after,'eventId',p_command_id);
  insert into public.work_session_events(user_id,command_id,session_id,work_item_id,revision_after,event_type,
    occurred_at,effective_at,device_id,command,before_state,after_state,result)
    values(v_user,p_command_id,p_session_id,p_work_item_id,p_expected_revision+1,p_action,
      p_occurred_at,v_now,p_device_id,v_command,v_before,v_after,v_result);
  return v_result;
end;
$fn$;
revoke all on function public.apply_work_session_command(uuid,uuid,uuid,bigint,timestamptz,text,text) from public,anon,service_role;
grant execute on function public.apply_work_session_command(uuid,uuid,uuid,bigint,timestamptz,text,text) to authenticated;

create function private.guard_project_work_session()
returns trigger language plpgsql security definer set search_path='' as $fn$
begin
  if (new.status<>'active' or new.deleted_at is not null) and exists(
    select 1 from public.work_sessions s join public.project_parts part on part.work_item_id=s.work_item_id
      where part.project_id=new.id and s.status in ('running','paused')
  ) then raise exception '진행 중이거나 일시정지된 작업 세션을 먼저 종료해 주세요.' using errcode='23514'; end if;
  return new;
end;
$fn$;
revoke all on function private.guard_project_work_session() from public,anon,authenticated,service_role;
create trigger projects_guard_work_session before update of status,deleted_at on public.projects
  for each row execute function private.guard_project_work_session();
create function private.guard_part_work_session()
returns trigger language plpgsql security definer set search_path='' as $fn$
begin
  if tg_op='INSERT' then
    perform 1 from public.work_items where id=new.work_item_id for update;
    if exists(select 1 from public.work_sessions where work_item_id=new.work_item_id and status in ('running','paused')) then
      raise exception '프로젝트로 전환하기 전에 작업 세션을 종료해 주세요.' using errcode='23514'; end if;
  elsif new.deleted_at is not null and old.deleted_at is null and exists(
    select 1 from public.work_sessions where work_item_id=new.work_item_id and status in ('running','paused')
  ) then raise exception '파트를 삭제하기 전에 작업 세션을 종료해 주세요.' using errcode='23514'; end if;
  return new;
end;
$fn$;
revoke all on function private.guard_part_work_session() from public,anon,authenticated,service_role;
create trigger project_parts_guard_work_session before insert or update of deleted_at on public.project_parts
  for each row execute function private.guard_part_work_session();
