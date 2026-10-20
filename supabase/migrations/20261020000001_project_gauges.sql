-- Phase 2D: project gauge records only. No counter state/history is changed.
alter table public.projects add column gauge_revision bigint not null default 0
  check (gauge_revision between 0 and 9007199254740991);
create table public.project_gauges (
  id uuid primary key,
  project_id uuid not null,
  user_id uuid not null,
  kind text not null check (kind in ('pattern','sample')),
  name text check (name is null or (name=btrim(name) and char_length(name) between 1 and 120)),
  stitches integer not null check (stitches between 1 and 1000000),
  rows integer not null check (rows between 1 and 1000000),
  width numeric not null check (width>0 and width<=10000 and scale(width)<=3),
  height numeric not null check (height>0 and height<=10000 and scale(height)<=3),
  unit text not null check (unit in ('cm','inch')),
  needle_size_mm numeric check (needle_size_mm>0 and needle_size_mm<=100 and scale(needle_size_mm)<=3),
  needle_label text check (char_length(needle_label)<=80),
  yarn text check (char_length(yarn)<=200),
  technique text check (char_length(technique)<=200),
  blocking text not null default 'unspecified' check (blocking in ('before','after','unspecified')),
  measured_on date check (measured_on between date '1900-01-01' and date '9999-12-31'),
  notes text check (char_length(notes)<=5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (project_id,user_id) references public.projects(id,user_id) on delete restrict,
  check (kind<>'sample' or name is not null),
  check (kind<>'pattern' or (name is null and needle_size_mm is null and needle_label is null and yarn is null and blocking='unspecified' and measured_on is null))
);
create unique index project_gauges_one_pattern_idx on public.project_gauges(project_id) where kind='pattern' and deleted_at is null;
create index project_gauges_measurement_idx on public.project_gauges(project_id,measured_on desc nulls last,created_at desc) where deleted_at is null;
alter table public.project_gauges enable row level security;
revoke all on public.project_gauges from public,anon,authenticated;
grant select on public.project_gauges to authenticated;
create policy "read own visible project gauges" on public.project_gauges for select to authenticated
  using (user_id=(select auth.uid()) and deleted_at is null and exists (
    select 1 from public.projects p where p.id=project_id and p.user_id=(select auth.uid()) and p.deleted_at is null
  ));
create table public.project_gauge_commands (
  user_id uuid not null,
  request_id uuid not null,
  project_id uuid not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,request_id),
  foreign key(project_id,user_id) references public.projects(id,user_id) on delete restrict
);
alter table public.project_gauge_commands enable row level security;
revoke all on public.project_gauge_commands from public,anon,authenticated;

create function public.get_project_gauges(p_project_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare v_project public.projects%rowtype; v_items jsonb;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='28000'; end if;
  select * into v_project from public.projects where id=p_project_id and user_id=auth.uid() and deleted_at is null;
  if not found then raise exception 'project not found' using errcode='P0002'; end if;
  select coalesce(jsonb_agg(to_jsonb(g) order by g.measured_on desc nulls last,g.created_at desc,g.id),'[]'::jsonb) into v_items
    from public.project_gauges g where g.project_id=p_project_id and g.user_id=auth.uid() and g.deleted_at is null;
  return jsonb_build_object('revision',v_project.gauge_revision,'items',v_items);
end;
$fn$;
revoke all on function public.get_project_gauges(uuid) from public,anon,service_role;
grant execute on function public.get_project_gauges(uuid) to authenticated;

create function public.apply_project_gauge_command(p_project_id uuid,p_request_id uuid,p_expected_revision bigint,p_action jsonb)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  v_user uuid:=auth.uid(); v_project public.projects%rowtype; v_receipt public.project_gauge_commands%rowtype;
  v_old public.project_gauges%rowtype; v_gauge public.project_gauges%rowtype;
  v_payload jsonb; v_result jsonb; v_id uuid; v_kind text;
begin
  if v_user is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_request_id is null or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740990
    or p_action is null or jsonb_typeof(p_action)<>'object' or coalesce(p_action->>'type','') not in ('save','delete') then
    raise exception 'invalid gauge command' using errcode='22023'; end if;
  v_id:=(p_action->>'id')::uuid;
  if v_id is null then raise exception 'gauge ID required' using errcode='22023'; end if;
  v_payload:=jsonb_build_object('projectId',p_project_id,'expectedRevision',p_expected_revision,'action',p_action);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text||':gauge:'||p_request_id::text,0));
  -- Locking the project serializes gauge mutations against deletion/recovery too.
  select * into v_project from public.projects where id=p_project_id and user_id=v_user for update;
  if not found or v_project.deleted_at is not null then raise exception 'project not found' using errcode='P0002'; end if;
  select * into v_receipt from public.project_gauge_commands where user_id=v_user and request_id=p_request_id;
  if found then
    if v_receipt.payload<>v_payload then raise exception 'request ID reused with different content' using errcode='22023'; end if;
    return jsonb_set(v_receipt.result,'{status}','"duplicate"'::jsonb);
  end if;
  if v_project.gauge_revision<>p_expected_revision then
    return jsonb_build_object('status','conflict','latestRevision',v_project.gauge_revision);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gauge-id:'||v_id::text,0));
  select * into v_old from public.project_gauges where id=v_id;
  if found and (v_old.project_id<>p_project_id or v_old.user_id<>v_user or v_old.deleted_at is not null) then
    raise exception 'gauge not found' using errcode='P0002'; end if;
  if p_action->>'type'='delete' then
    if v_old.id is null then raise exception 'gauge not found' using errcode='P0002'; end if;
    update public.project_gauges set deleted_at=clock_timestamp(),updated_at=clock_timestamp() where id=v_id;
  else
    if jsonb_typeof(p_action->'data') is distinct from 'object' then raise exception 'gauge data required' using errcode='22023'; end if;
    -- No client-supplied owner, project, timestamp or deletion fields are accepted.
    v_gauge:=jsonb_populate_record(null::public.project_gauges,p_action->'data');
    v_kind:=v_gauge.kind;
    if v_old.id is not null and v_old.kind is distinct from v_kind then raise exception 'gauge kind cannot change' using errcode='22023'; end if;
    insert into public.project_gauges(id,project_id,user_id,kind,name,stitches,rows,width,height,unit,
      needle_size_mm,needle_label,yarn,technique,blocking,measured_on,notes)
    values(v_id,p_project_id,v_user,v_kind,v_gauge.name,v_gauge.stitches,v_gauge.rows,v_gauge.width,v_gauge.height,v_gauge.unit,
      v_gauge.needle_size_mm,v_gauge.needle_label,v_gauge.yarn,v_gauge.technique,coalesce(v_gauge.blocking,'unspecified'),v_gauge.measured_on,v_gauge.notes)
    on conflict(id) do update set name=excluded.name,stitches=excluded.stitches,rows=excluded.rows,
      width=excluded.width,height=excluded.height,unit=excluded.unit,needle_size_mm=excluded.needle_size_mm,
      needle_label=excluded.needle_label,yarn=excluded.yarn,technique=excluded.technique,blocking=excluded.blocking,
      measured_on=excluded.measured_on,notes=excluded.notes,updated_at=clock_timestamp();
  end if;
  update public.projects set gauge_revision=gauge_revision+1 where id=p_project_id;
  v_result:=jsonb_build_object('status','applied','revision',v_project.gauge_revision+1,'gaugeId',v_id);
  insert into public.project_gauge_commands(user_id,request_id,project_id,payload,result) values(v_user,p_request_id,p_project_id,v_payload,v_result);
  return v_result;
end;
$fn$;
revoke all on function public.apply_project_gauge_command(uuid,uuid,bigint,jsonb) from public,anon,service_role;
grant execute on function public.apply_project_gauge_command(uuid,uuid,bigint,jsonb) to authenticated;
