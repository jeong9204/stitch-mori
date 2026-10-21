-- Phase 3B: work-scoped timer mode; counter/session command RPCs are unchanged.
create table public.work_timer_preferences (
  work_item_id uuid primary key,
  user_id uuid not null,
  mode text not null check(mode in ('manual','auto')),
  revision bigint not null check(revision between 1 and 9007199254740991),
  activation_revision bigint not null check(activation_revision between 0 and 9007199254740991),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(work_item_id,user_id) references public.work_items(id,user_id) on delete restrict
);
alter table public.work_timer_preferences enable row level security;
revoke all on public.work_timer_preferences from public,anon,authenticated;
grant select on public.work_timer_preferences to authenticated;
create policy "read own timer preferences" on public.work_timer_preferences for select to authenticated
  using(user_id=(select auth.uid()) and private.can_read_counter_work_item(work_item_id));
create function public.set_work_timer_mode(p_work_item_id uuid,p_mode text,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_project_id uuid; v_revision bigint; v_pref public.work_timer_preferences%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_mode is null or p_mode not in ('manual','auto') or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740990 then
    raise exception 'invalid timer mode' using errcode='22023'; end if;
  select project_id into v_project_id from public.project_parts where work_item_id=p_work_item_id and user_id=auth.uid();
  if v_project_id is not null then perform 1 from public.projects where id=v_project_id for update; end if;
  select revision into v_revision from public.work_items where id=p_work_item_id and user_id=auth.uid() for update;
  if not found or not private.can_read_counter_work_item(p_work_item_id) then raise exception 'work item not found' using errcode='P0002'; end if;
  select * into v_pref from public.work_timer_preferences where work_item_id=p_work_item_id;
  if coalesce(v_pref.revision,0)<>p_expected_revision then return jsonb_build_object('status','conflict'); end if;
  insert into public.work_timer_preferences(work_item_id,user_id,mode,revision,activation_revision)
    values(p_work_item_id,auth.uid(),p_mode,1,v_revision)
    on conflict(work_item_id) do update set mode=excluded.mode,revision=work_timer_preferences.revision+1,
      activation_revision=excluded.activation_revision,updated_at=clock_timestamp();
  return jsonb_build_object('status','applied');
end;
$fn$;
revoke all on function public.set_work_timer_mode(uuid,text,bigint) from public,anon,service_role;
grant execute on function public.set_work_timer_mode(uuid,text,bigint) to authenticated;
create function public.get_work_timer_context(p_work_item_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare v_work public.work_items%rowtype; v_pref public.work_timer_preferences%rowtype; v_own uuid; v_active uuid;
  v_project public.projects%rowtype; v_part public.project_parts%rowtype; v_active_work uuid; v_active_name text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='28000'; end if;
  select * into v_work from public.work_items where id=p_work_item_id and user_id=auth.uid();
  if not found or not private.can_read_counter_work_item(p_work_item_id) then raise exception 'work item not found' using errcode='P0002'; end if;
  select * into v_pref from public.work_timer_preferences where work_item_id=p_work_item_id and user_id=auth.uid();
  select * into v_part from public.project_parts where work_item_id=p_work_item_id and user_id=auth.uid();
  select * into v_project from public.projects where id=v_part.project_id and user_id=auth.uid();
  select id into v_own from public.work_sessions where work_item_id=p_work_item_id and user_id=auth.uid() order by (status in ('running','paused')) desc,started_at desc,updated_at desc,id desc limit 1;
  select id,work_item_id into v_active,v_active_work from public.work_sessions where user_id=auth.uid() and status in ('running','paused');
  select p.name||' · '||part.name into v_active_name from public.project_parts part join public.projects p on p.id=part.project_id where part.work_item_id=v_active_work and part.user_id=auth.uid();
  return jsonb_build_object('mode',coalesce(v_pref.mode,'manual'),'modeRevision',coalesce(v_pref.revision,0),
    'activationRevision',coalesce(v_pref.activation_revision,0),'counterRevision',v_work.revision,
    'state',private.work_session_state(v_own),'active',private.work_session_state(v_active),
    'activeName',coalesce(v_active_name,'계정 카운터'),'workName',coalesce(v_project.name||' · '||v_part.name,'계정 카운터'),
    'canStart',v_project.id is null or (v_project.status='active' and v_project.deleted_at is null and v_part.deleted_at is null),
    'serverNow',date_trunc('milliseconds',clock_timestamp()));
end;
$fn$;
revoke all on function public.get_work_timer_context(uuid) from public,anon,service_role;
grant execute on function public.get_work_timer_context(uuid) to authenticated;
