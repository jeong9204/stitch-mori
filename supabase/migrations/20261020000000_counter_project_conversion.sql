-- Phase 2C-2: attach an existing work item; never recreate its counters or history.
create table public.counter_project_conversions (
  user_id uuid not null references auth.users(id) on delete restrict,
  request_id uuid not null,
  work_item_id uuid not null,
  project_id uuid not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,request_id),
  foreign key(work_item_id,user_id) references public.work_items(id,user_id) on delete restrict,
  foreign key(project_id,user_id) references public.projects(id,user_id) on delete restrict
);
alter table public.counter_project_conversions enable row level security;
revoke all on public.counter_project_conversions from public,anon,authenticated;

create function public.get_counter_project_link(p_work_item_id uuid)
returns jsonb language sql stable security definer set search_path='' as $f$
  select jsonb_build_object('projectId',p.id,'partId',part.id,'projectName',p.name,
    'deleted',p.deleted_at is not null or part.deleted_at is not null)
  from public.project_parts part join public.projects p on p.id=part.project_id
  where part.work_item_id=p_work_item_id and part.user_id=auth.uid() and p.user_id=auth.uid()
$f$;
revoke all on function public.get_counter_project_link(uuid) from public,anon,service_role;
grant execute on function public.get_counter_project_link(uuid) to authenticated;

create function public.list_account_counters()
returns jsonb language sql stable security definer set search_path='' as $f$
  select coalesce(jsonb_agg(jsonb_build_object('id',wi.id,'revision',wi.revision,'createdAt',wi.created_at,
    'stitch',s.current_value,'row',r.current_value) order by wi.created_at desc),'[]'::jsonb)
  from public.work_items wi
  join public.counters s on s.work_item_id=wi.id and s.counter_type='stitch'
  join public.counters r on r.work_item_id=wi.id and r.counter_type='row'
  where wi.user_id=auth.uid() and not exists(select 1 from public.project_parts part where part.work_item_id=wi.id)
$f$;
revoke all on function public.list_account_counters() from public,anon,service_role;
grant execute on function public.list_account_counters() to authenticated;

create function public.convert_counter_to_project(
  p_work_item_id uuid,p_request_id uuid,p_expected_revision bigint,p_name text
) returns jsonb language plpgsql security definer set search_path='' as $f$
declare
  v_user uuid:=auth.uid(); v_name text:=btrim(coalesce(p_name,''));
  v_work public.work_items%rowtype; v_receipt public.counter_project_conversions%rowtype;
  v_payload jsonb; v_project_id uuid; v_part_id uuid; v_result jsonb;
begin
  if v_user is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_work_item_id is null or p_request_id is null or p_expected_revision is null
    or p_expected_revision not between 0 and 9007199254740991 or char_length(v_name) not between 1 and 120 then
    raise exception 'invalid conversion request' using errcode='22023';
  end if;
  v_payload:=jsonb_build_object('workItemId',p_work_item_id,'expectedRevision',p_expected_revision,'name',v_name);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text||':'||p_request_id::text,0));
  select * into v_receipt from public.counter_project_conversions where user_id=v_user and request_id=p_request_id;
  if found then
    if v_receipt.payload<>v_payload then raise exception 'request ID reused with different content' using errcode='22023'; end if;
    return jsonb_set(v_receipt.result,'{status}','"duplicate"'::jsonb);
  end if;
  select * into v_work from public.work_items where id=p_work_item_id and user_id=v_user for update;
  if not found then raise exception 'work item not found' using errcode='P0002'; end if;
  if exists(select 1 from public.project_parts where work_item_id=p_work_item_id) then
    raise exception 'work item already belongs to a project' using errcode='22023';
  end if;
  if v_work.revision<>p_expected_revision then return jsonb_build_object('status','conflict','latestRevision',v_work.revision); end if;
  if (select count(*) from public.counters where work_item_id=p_work_item_id)<>2 then
    raise exception 'incomplete counter pair' using errcode='22023';
  end if;
  insert into public.projects(user_id,creation_request_id,creation_payload,name)
    values(v_user,gen_random_uuid(),jsonb_build_object('name',v_name,'notes',null),v_name) returning id into v_project_id;
  insert into public.project_parts(project_id,user_id,work_item_id,name,is_default,position)
    values(v_project_id,v_user,p_work_item_id,'기본 파트',true,0) returning id into v_part_id;
  v_result:=jsonb_build_object('status','converted','projectId',v_project_id,'partId',v_part_id,'workItemId',p_work_item_id,'revision',v_work.revision);
  insert into public.counter_project_conversions(user_id,request_id,work_item_id,project_id,payload,result)
    values(v_user,p_request_id,p_work_item_id,v_project_id,v_payload,v_result);
  return v_result;
end;
$f$;
revoke all on function public.convert_counter_to_project(uuid,uuid,bigint,text) from public,anon,service_role;
grant execute on function public.convert_counter_to_project(uuid,uuid,bigint,text) to authenticated;
