-- Phase 3C: additional read/acknowledgement APIs; existing timer/counter RPCs remain unchanged.
create table public.work_session_activity (
  session_id uuid primary key,
  user_id uuid not null,
  baseline timestamptz not null check(isfinite(baseline)),
  shown boolean not null default true,
  continued_at timestamptz check(continued_at is null or isfinite(continued_at)),
  choice text check(choice in ('continue','later','pause')),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(session_id,user_id) references public.work_sessions(id,user_id) on delete cascade
);
alter table public.work_session_activity enable row level security;
revoke all on public.work_session_activity from public,anon,authenticated;
grant select on public.work_session_activity to authenticated;
create policy "read own inactivity acknowledgement" on public.work_session_activity for select to authenticated using(user_id=(select auth.uid()));
create index counter_events_valid_activity_idx on public.counter_events(work_item_id,created_at desc)
where previous_state #> '{stitch,current}' is distinct from next_state #> '{stitch,current}'
   or previous_state #> '{row,current}' is distinct from next_state #> '{row,current}';

-- Record server confirmation time separately: counter_events.created_at uses transaction
-- start time, which can precede a concurrent acknowledgement in a long transaction.
create table public.work_item_activity (
  work_item_id uuid primary key,
  user_id uuid not null,
  last_count_at timestamptz not null check(isfinite(last_count_at)),
  revision bigint not null check(revision>0),
  foreign key(work_item_id,user_id) references public.work_items(id,user_id) on delete cascade
);
alter table public.work_item_activity enable row level security;
revoke all on public.work_item_activity from public,anon,authenticated;
grant select on public.work_item_activity to authenticated;
create policy "read own count activity" on public.work_item_activity for select to authenticated using(user_id=(select auth.uid()));
create function private.record_valid_count_activity() returns trigger language plpgsql security definer set search_path='' as $body$
begin
  if new.previous_state #> '{stitch,current}' is distinct from new.next_state #> '{stitch,current}'
     or new.previous_state #> '{row,current}' is distinct from new.next_state #> '{row,current}' then
    insert into public.work_item_activity(work_item_id,user_id,last_count_at,revision)
      select new.work_item_id,user_id,clock_timestamp(),new.revision_after from public.work_items where id=new.work_item_id
      on conflict(work_item_id) do update set last_count_at=excluded.last_count_at,revision=excluded.revision where work_item_activity.revision<excluded.revision;
  end if;return new;
end;
$body$;
revoke all on function private.record_valid_count_activity() from public,anon,authenticated,service_role;
create trigger counter_events_activity after insert on public.counter_events for each row execute function private.record_valid_count_activity();

create function public.get_work_inactivity(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare s public.work_sessions%rowtype; a public.work_session_activity%rowtype; last_count timestamptz; anchor timestamptz;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='28000'; end if;
  select * into s from public.work_sessions where id=p_session_id and user_id=auth.uid();
  if not found then raise exception 'session not found' using errcode='P0002'; end if;
  select * into a from public.work_session_activity where session_id=s.id and user_id=auth.uid();
  select last_count_at into last_count from public.work_item_activity where work_item_id=s.work_item_id and last_count_at>=s.started_at;
  if last_count is null then
  select max(created_at) into last_count from public.counter_events where work_item_id=s.work_item_id and created_at>=s.started_at
    and (previous_state #> '{stitch,current}' is distinct from next_state #> '{stitch,current}' or previous_state #> '{row,current}' is distinct from next_state #> '{row,current}');
  end if;
  anchor:=greatest(s.started_at,last_count,a.continued_at);
  return jsonb_build_object('session',private.work_session_state(s.id),'baseline',anchor,'shown',coalesce(a.baseline=anchor and a.shown,false),'now',date_trunc('milliseconds',clock_timestamp()));
end;
$fn$;
create function public.ack_work_inactivity(p_session_id uuid,p_baseline timestamptz,p_choice text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare context jsonb; a public.work_session_activity%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_choice is null or p_choice not in ('show','continue','later','pause') or p_baseline is null or not isfinite(p_baseline) then raise exception 'invalid inactivity acknowledgement' using errcode='22023'; end if;
  perform 1 from public.work_sessions where id=p_session_id and user_id=auth.uid() for update;
  if not found then raise exception 'session not found' using errcode='P0002'; end if;
  context:=public.get_work_inactivity(p_session_id);
  if context->'session'->>'status'<>'running' or (context->>'baseline')::timestamptz<>p_baseline then return jsonb_build_object('status','stale'); end if;
  select * into a from public.work_session_activity where session_id=p_session_id;
  if p_choice='show' then
    if (context->>'shown')::boolean or (context->>'now')::timestamptz<p_baseline+interval '30 minutes' then return jsonb_build_object('status','skipped'); end if;
    insert into public.work_session_activity(session_id,user_id,baseline,shown,continued_at)
      values(p_session_id,auth.uid(),p_baseline,true,a.continued_at)
      on conflict(session_id) do update set baseline=excluded.baseline,shown=true,choice=null,updated_at=clock_timestamp();
  else
    if not coalesce((context->>'shown')::boolean,false) then return jsonb_build_object('status','stale'); end if;
    if a.choice is not null then return jsonb_build_object('status','duplicate','choice',a.choice); end if;
    update public.work_session_activity set choice=p_choice,continued_at=case when p_choice='continue' then clock_timestamp() else continued_at end,updated_at=clock_timestamp() where session_id=p_session_id;
  end if;
  return jsonb_build_object('status','applied');
end;
$fn$;

create function public.get_work_time_statistics(p_zone text default 'Asia/Seoul',p_project_id uuid default null,p_work_item_id uuid default null,p_offset integer default 0,p_day date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare v_now timestamptz:=date_trunc('milliseconds',clock_timestamp()); v_day date; v_from timestamptz; v_to timestamptz; answer jsonb;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_zone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_zone) or p_offset is null or p_offset<0 or p_offset>1000000 then raise exception 'invalid statistics query' using errcode='22023'; end if;
  if p_project_id is not null and not exists(select 1 from public.projects where id=p_project_id and user_id=auth.uid()) then raise exception 'project not found' using errcode='P0002'; end if;
  if p_work_item_id is not null and not exists(select 1 from public.work_items where id=p_work_item_id and user_id=auth.uid()) then raise exception 'work item not found' using errcode='P0002'; end if;
  v_day:=coalesce(p_day,(v_now at time zone p_zone)::date);v_from:=v_day::timestamp at time zone p_zone;v_to:=(v_day+1)::timestamp at time zone p_zone;
  with scoped as (
    select s.*,pp.project_id,pp.id part_id,coalesce(p.name||' · '||pp.name,'계정 카운터') work_name,(p.deleted_at is not null or pp.deleted_at is not null) deleted
    from public.work_sessions s left join public.project_parts pp on pp.work_item_id=s.work_item_id and pp.user_id=s.user_id left join public.projects p on p.id=pp.project_id and p.user_id=s.user_id
    where s.user_id=auth.uid() and (p_project_id is null or pp.project_id=p_project_id) and (p_work_item_id is null or s.work_item_id=p_work_item_id)
  ), transitions as (
    select e.session_id,e.effective_at,e.event_type,lead(e.effective_at) over(partition by e.session_id order by e.revision_after) stop
    from public.work_session_events e join scoped s on s.id=e.session_id where e.user_id=auth.uid()
  ), daily as (
    select t.session_id,coalesce(sum(case when t.stop is not null then greatest(0,extract(epoch from (least(t.stop,v_to)-greatest(t.effective_at,v_from)))*1000) else 0 end),0)::bigint saved,
    coalesce(sum(case when t.stop is null then greatest(0,extract(epoch from (least(v_now,v_to)-greatest(t.effective_at,v_from)))*1000) else 0 end),0)::bigint live
    ,max(coalesce(t.stop,v_now)) last_worked_at from transitions t where t.event_type in ('start','resume') group by t.session_id
  ), summaries as (
    select s.work_item_id,s.project_id,s.part_id,s.work_name,s.deleted,
      sum(s.accumulated_ms) saved_ms,
      sum(case when s.status='running' then greatest(0,extract(epoch from (v_now-s.last_resumed_at))*1000) else 0 end)::bigint live_ms,
      sum(coalesce(d.saved,0)) today_saved_ms,sum(coalesce(d.live,0)) today_live_ms,max(coalesce(d.last_worked_at,s.started_at)) last_worked_at
    from scoped s left join daily d on d.session_id=s.id group by s.work_item_id,s.project_id,s.part_id,s.work_name,s.deleted
  ) select jsonb_build_object('zone',p_zone,'day',v_day,'serverNow',v_now,
    'works',coalesce((select jsonb_agg(jsonb_build_object('workItemId',r.work_item_id,'projectId',r.project_id,'partId',r.part_id,'name',r.work_name,'deleted',r.deleted,
      'savedMs',r.saved_ms,'liveMs',r.live_ms,'todaySavedMs',r.today_saved_ms,'todayLiveMs',r.today_live_ms,'lastWorkedAt',r.last_worked_at,
      'active',(select private.work_session_state(s.id) from scoped s where s.work_item_id=r.work_item_id and s.status in ('running','paused')))) from summaries r),'[]'::jsonb),
    'recent',coalesce((select jsonb_agg(private.work_session_state(q.id) order by q.ended_at desc,q.id desc) from (select id,ended_at from scoped where status='ended' order by ended_at desc,id desc limit 20 offset p_offset) q),'[]'::jsonb),
    'hasMore',(select count(*)>p_offset+20 from scoped where status='ended')) into answer;
  return answer;
end;
$fn$;
revoke all on function public.get_work_inactivity(uuid), public.ack_work_inactivity(uuid,timestamptz,text), public.get_work_time_statistics(text,uuid,uuid,integer,date) from public,anon,service_role;
grant execute on function public.get_work_inactivity(uuid), public.ack_work_inactivity(uuid,timestamptz,text), public.get_work_time_statistics(text,uuid,uuid,integer,date) to authenticated;
