begin;
-- Add ordering metadata only; measured sessions/events and existing audit values stay intact.
alter table public.work_session_time_adjustments add column adjustment_revision bigint;
alter table public.work_session_time_adjustments disable trigger work_session_adjustments_append_only;
with ordered as (select id,row_number() over(partition by session_id order by created_at,id) n from public.work_session_time_adjustments)
update public.work_session_time_adjustments a set adjustment_revision=o.n from ordered o where a.id=o.id;
alter table public.work_session_time_adjustments enable trigger work_session_adjustments_append_only;
alter table public.work_session_time_adjustments alter column adjustment_revision set not null;
alter table public.work_session_time_adjustments add check(adjustment_revision between 1 and 9007199254740991);
alter table public.work_session_time_adjustments add unique(session_id,adjustment_revision);
alter table public.work_session_time_adjustments drop constraint work_session_time_adjustments_reason_check;
alter table public.work_session_time_adjustments add check(char_length(reason)<=1000);
do $body$
begin
  if exists(with ordered as (select a.*,coalesce(lag(adjusted_ms) over(partition by session_id order by adjustment_revision),s.accumulated_ms) expected
    from public.work_session_time_adjustments a join public.work_sessions s on s.id=a.session_id)
    select 1 from ordered where previous_adjusted_ms<>expected)
  then raise exception 'legacy adjustment order requires review';end if;
end;
$body$;

create function private.work_time_adjustment_json(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $fn$
  select jsonb_build_object('adjustmentId',id,'commandId',command_id,'sessionId',session_id,'userId',user_id,'previousAdjustedMs',previous_adjusted_ms,
    'adjustedMs',adjusted_ms,'reason',reason,'createdAt',created_at,'revision',adjustment_revision)
  from public.work_session_time_adjustments where id=p_id and user_id=auth.uid()
$fn$;
revoke all on function private.work_time_adjustment_json(uuid) from public,anon,authenticated,service_role;

create function public.get_work_time_adjustments(p_session_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare s public.work_sessions%rowtype; latest public.work_session_time_adjustments%rowtype; history jsonb; unavailable boolean;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='28000';end if;
  select * into s from public.work_sessions where id=p_session_id and user_id=auth.uid();
  if not found then raise exception 'session not found' using errcode='P0002';end if;
  select * into latest from public.work_session_time_adjustments where session_id=s.id and user_id=auth.uid() order by adjustment_revision desc limit 1;
  select jsonb_agg(private.work_time_adjustment_json(id) order by adjustment_revision) into history from public.work_session_time_adjustments where session_id=s.id and user_id=auth.uid();
  select exists(select 1 from public.project_parts pp join public.projects p on p.id=pp.project_id where pp.work_item_id=s.work_item_id and pp.user_id=auth.uid() and (pp.deleted_at is not null or p.deleted_at is not null)) into unavailable;
  return jsonb_build_object('session',private.work_session_state(s.id),'adjustments',coalesce(history,'[]'::jsonb),'effectiveMs',coalesce(latest.adjusted_ms,s.accumulated_ms),
    'revision',coalesce(latest.adjustment_revision,0),'canAdjust',s.status='ended' and not unavailable);
end;
$fn$;

create function public.adjust_work_session_time(p_request_id uuid,p_session_id uuid,p_expected_revision bigint,p_adjusted_ms numeric,p_reason text default '')
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare s public.work_sessions%rowtype; previous public.work_session_time_adjustments%rowtype; duplicate public.work_session_time_adjustments%rowtype;
  project_id uuid; new_id uuid:=gen_random_uuid(); reason text:=btrim(coalesce(p_reason,''));
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='28000';end if;
  if p_request_id is null or p_session_id is null or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740990 or p_adjusted_ms is null or p_adjusted_ms not between 0 and 9007199254740991 or p_adjusted_ms<>trunc(p_adjusted_ms) or char_length(coalesce(p_reason,''))>1000 then raise exception 'invalid adjustment' using errcode='22023';end if;
  -- Serialize equal request IDs before looking up a receipt, including across sessions.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text||':adjustment:'||p_request_id::text,0));
  select * into duplicate from public.work_session_time_adjustments where user_id=auth.uid() and command_id=p_request_id;
  if found then
    if duplicate.session_id<>p_session_id or duplicate.adjustment_revision<>p_expected_revision+1 or duplicate.adjusted_ms<>p_adjusted_ms or duplicate.reason<>reason then raise exception 'request id reused' using errcode='22023';end if;
    return jsonb_build_object('status','duplicate','adjustment',private.work_time_adjustment_json(duplicate.id));
  end if;
  select * into s from public.work_sessions where id=p_session_id and user_id=auth.uid();
  if not found then raise exception 'session not found' using errcode='P0002';end if;
  select pp.project_id into project_id from public.project_parts pp where pp.work_item_id=s.work_item_id and pp.user_id=auth.uid();
  if project_id is not null then perform 1 from public.projects p where p.id=project_id for update;end if;
  perform 1 from public.work_items where id=s.work_item_id and user_id=auth.uid() for update;
  if not private.can_read_counter_work_item(s.work_item_id) then raise exception 'restore project or part before adjustment' using errcode='22023';end if;
  select * into s from public.work_sessions where id=p_session_id and user_id=auth.uid() for update;
  if s.status<>'ended' then return jsonb_build_object('status','rejected','reason','session_not_ended');end if;
  select * into previous from public.work_session_time_adjustments where session_id=s.id and user_id=auth.uid() order by adjustment_revision desc limit 1;
  if coalesce(previous.adjustment_revision,0)<>p_expected_revision then return jsonb_build_object('status','conflict','revision',coalesce(previous.adjustment_revision,0));end if;
  insert into public.work_session_time_adjustments(id,user_id,session_id,command_id,previous_adjusted_ms,adjusted_ms,reason,adjustment_revision,created_at)
    values(new_id,auth.uid(),s.id,p_request_id,coalesce(previous.adjusted_ms,s.accumulated_ms),p_adjusted_ms,reason,p_expected_revision+1,clock_timestamp());
  return jsonb_build_object('status','applied','adjustment',private.work_time_adjustment_json(new_id));
end;
$fn$;
revoke all on function public.get_work_time_adjustments(uuid),public.adjust_work_session_time(uuid,uuid,bigint,numeric,text) from public,anon,service_role;
grant execute on function public.get_work_time_adjustments(uuid),public.adjust_work_session_time(uuid,uuid,bigint,numeric,text) to authenticated;

create function private.allocate_adjusted_day(p_original bigint,p_effective bigint,p_before numeric,p_during numeric,p_ended timestamptz,p_from timestamptz,p_to timestamptz)
returns bigint language sql immutable set search_path='' as $fn$
  select case when p_original=0 then case when p_ended>=p_from and p_ended<p_to then p_effective else 0 end
    else (floor(p_effective::numeric*(p_before+p_during)/p_original)-floor(p_effective::numeric*p_before/p_original))::bigint end
$fn$;
revoke all on function private.allocate_adjusted_day(bigint,bigint,numeric,numeric,timestamptz,timestamptz,timestamptz) from public,anon,authenticated,service_role;

create or replace function public.get_work_time_statistics(p_zone text default 'Asia/Seoul',p_project_id uuid default null,p_work_item_id uuid default null,p_offset integer default 0,p_day date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare v_now timestamptz:=date_trunc('milliseconds',clock_timestamp()); v_day date; v_from timestamptz; v_to timestamptz; answer jsonb;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_zone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_zone) or p_offset is null or p_offset<0 or p_offset>1000000 then raise exception 'invalid statistics query' using errcode='22023'; end if;
  if p_project_id is not null and not exists(select 1 from public.projects where id=p_project_id and user_id=auth.uid()) then raise exception 'project not found' using errcode='P0002'; end if;
  if p_work_item_id is not null and not exists(select 1 from public.work_items where id=p_work_item_id and user_id=auth.uid()) then raise exception 'work item not found' using errcode='P0002'; end if;
  v_day:=coalesce(p_day,(v_now at time zone p_zone)::date);v_from:=v_day::timestamp at time zone p_zone;v_to:=(v_day+1)::timestamp at time zone p_zone;
  with scoped as (
    select s.*,coalesce(a.adjusted_ms,s.accumulated_ms) effective_ms,coalesce(a.adjustment_revision,0) adjustment_revision,pp.project_id,pp.id part_id,coalesce(p.name||' · '||pp.name,'계정 카운터') work_name,(p.deleted_at is not null or pp.deleted_at is not null) deleted
    from public.work_sessions s left join public.project_parts pp on pp.work_item_id=s.work_item_id and pp.user_id=s.user_id left join public.projects p on p.id=pp.project_id and p.user_id=s.user_id
    left join lateral(select adjusted_ms,adjustment_revision from public.work_session_time_adjustments a where a.session_id=s.id and a.user_id=s.user_id order by adjustment_revision desc limit 1) a on true
    where s.user_id=auth.uid() and (p_project_id is null or pp.project_id=p_project_id) and (p_work_item_id is null or s.work_item_id=p_work_item_id)
  ), transitions as (
    select e.session_id,e.effective_at,e.event_type,lead(e.effective_at) over(partition by e.session_id order by e.revision_after) stop
    from public.work_session_events e join scoped s on s.id=e.session_id where e.user_id=auth.uid()
  ), daily as (
    select t.session_id,coalesce(sum(case when t.stop is not null then greatest(0,extract(epoch from (least(t.stop,v_to)-greatest(t.effective_at,v_from)))*1000) else 0 end),0)::bigint saved,
    coalesce(sum(case when t.stop is null then greatest(0,extract(epoch from (least(v_now,v_to)-greatest(t.effective_at,v_from)))*1000) else 0 end),0)::bigint live
    ,coalesce(sum(case when t.stop is not null then greatest(0,extract(epoch from (least(t.stop,v_from)-t.effective_at))*1000) else 0 end),0)::bigint before_day
    ,max(coalesce(t.stop,v_now)) last_worked_at from transitions t where t.event_type in ('start','resume') group by t.session_id
  ), summaries as (
    select s.work_item_id,s.project_id,s.part_id,s.work_name,s.deleted,
      sum(s.effective_ms) saved_ms,count(*) filter(where s.adjustment_revision>0) adjusted_sessions,
      sum(case when s.status='running' then greatest(0,extract(epoch from (v_now-s.last_resumed_at))*1000) else 0 end)::bigint live_ms,
      sum(case when s.adjustment_revision>0 then private.allocate_adjusted_day(s.accumulated_ms,s.effective_ms,coalesce(d.before_day,0),coalesce(d.saved,0),s.ended_at,v_from,v_to) else coalesce(d.saved,0) end) today_saved_ms,sum(coalesce(d.live,0)) today_live_ms,max(coalesce(d.last_worked_at,s.started_at)) last_worked_at
    from scoped s left join daily d on d.session_id=s.id group by s.work_item_id,s.project_id,s.part_id,s.work_name,s.deleted
  ) select jsonb_build_object('zone',p_zone,'day',v_day,'serverNow',v_now,
    'works',coalesce((select jsonb_agg(jsonb_build_object('workItemId',r.work_item_id,'projectId',r.project_id,'partId',r.part_id,'name',r.work_name,'deleted',r.deleted,
      'adjustedSessions',r.adjusted_sessions,'savedMs',r.saved_ms,'liveMs',r.live_ms,'todaySavedMs',r.today_saved_ms,'todayLiveMs',r.today_live_ms,'lastWorkedAt',r.last_worked_at,
      'active',(select private.work_session_state(s.id) from scoped s where s.work_item_id=r.work_item_id and s.status in ('running','paused')))) from summaries r),'[]'::jsonb),
    'recent',coalesce((select jsonb_agg(private.work_session_state(q.id)||jsonb_build_object('effectiveMs',q.effective_ms,'adjustmentRevision',q.adjustment_revision) order by q.ended_at desc,q.id desc) from (select id,ended_at,effective_ms,adjustment_revision from scoped where status='ended' order by ended_at desc,id desc limit 20 offset p_offset) q),'[]'::jsonb),
    'hasMore',(select count(*)>p_offset+20 from scoped where status='ended')) into answer;
  return answer;
end;
$fn$;

commit;
