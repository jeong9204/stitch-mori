begin;
create table public.timer_imports (
 user_id uuid not null references auth.users(id) on delete restrict,
 import_id uuid not null,counter_import_id uuid not null,local_work_item_id uuid not null,
 server_work_item_id uuid not null,source_payload jsonb not null,result jsonb not null,
 created_at timestamptz not null default clock_timestamp(),primary key(user_id,import_id),
 foreign key(user_id,counter_import_id) references public.counter_imports(user_id,import_id),
 foreign key(server_work_item_id,user_id) references public.work_items(id,user_id)
);
create table public.timer_import_sessions (
 user_id uuid not null,local_session_id uuid not null,server_session_id uuid not null unique,
 import_id uuid not null,source_payload jsonb not null,primary key(user_id,local_session_id),
 -- A device session identity cannot be transferred to a second account.
 unique(local_session_id),
 foreign key(user_id,import_id) references public.timer_imports(user_id,import_id) deferrable initially deferred,
 foreign key(server_session_id,user_id) references public.work_sessions(id,user_id)
);
create index timer_import_sessions_receipt_idx on public.timer_import_sessions(user_id,import_id);
alter table public.timer_imports enable row level security;
alter table public.timer_import_sessions enable row level security;
revoke all on public.timer_imports,public.timer_import_sessions from public,anon,authenticated;
grant select on public.timer_imports,public.timer_import_sessions to authenticated;
create policy "read own timer imports" on public.timer_imports for select to authenticated using(user_id=(select auth.uid()));
create policy "read own imported sessions" on public.timer_import_sessions for select to authenticated using(user_id=(select auth.uid()));
create trigger timer_imports_append_only before update or delete on public.timer_imports for each row execute function private.reject_work_session_history_change();
create trigger timer_import_sessions_append_only before update or delete on public.timer_import_sessions for each row execute function private.reject_work_session_history_change();
alter table public.work_session_time_adjustments add column source_local_adjustment_id uuid;
-- The owner is the importing account; the original actor was this device, retained in source_payload.
create or replace function private.work_time_adjustment_json(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $fn$
 select jsonb_build_object('adjustmentId',id,'commandId',command_id,'sessionId',session_id,'userId',user_id,'previousAdjustedMs',previous_adjusted_ms,
 'adjustedMs',adjusted_ms,'reason',reason,'createdAt',created_at,'revision',adjustment_revision,'sourceLocalAdjustmentId',source_local_adjustment_id)
 from public.work_session_time_adjustments where id=p_id and user_id=auth.uid()
$fn$;
create function private.timer_import_ms(v jsonb) returns bigint language plpgsql immutable set search_path='' as $fn$
begin
 if v is null or jsonb_typeof(v)<>'number' or v::text !~ '^[0-9]+$' or v::numeric>9007199254740991 then raise exception 'invalid timer integer' using errcode='22023';end if;
 return v::text::bigint;
end;$fn$;
create function private.timer_import_at(v text) returns timestamptz language plpgsql immutable set search_path='' as $fn$
declare t timestamptz;
begin
 if v is null or v !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$' then raise exception 'invalid timer timestamp' using errcode='22023';end if;
 t:=v::timestamptz;
 if not isfinite(t) or t<timestamptz '1970-01-01Z' or t>=timestamptz '10000-01-01Z' then raise exception 'invalid timer timestamp' using errcode='22023';end if;
 return t;
end;$fn$;
create function private.timer_import_state(v jsonb) returns jsonb language plpgsql immutable set search_path='' as $fn$
begin
 if v is null or v='null'::jsonb then return null;end if;
 if jsonb_typeof(v)<>'object' or v->'userId' is distinct from 'null'::jsonb then raise exception 'local session required' using errcode='22023';end if;
 return jsonb_build_object('sessionId',(v->>'sessionId')::uuid,'workItemId',(v->>'workItemId')::uuid,'userId',null,'status',v->>'status',
 'startedAt',private.timer_import_at(v->>'startedAt'),'endedAt',case when v->>'endedAt' is not null then private.timer_import_at(v->>'endedAt') end,
 'accumulatedMs',private.timer_import_ms(v->'accumulatedMs'),'lastResumedAt',case when v->>'lastResumedAt' is not null then private.timer_import_at(v->>'lastResumedAt') end,
 'lastTransitionAt',private.timer_import_at(v->>'lastTransitionAt'),'revision',private.timer_import_ms(v->'revision'),
 'createdAt',private.timer_import_at(v->>'createdAt'),'updatedAt',private.timer_import_at(v->>'updatedAt'));
end;$fn$;
create function public.import_timer_snapshot(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare u uuid:=auth.uid(); iid uuid; cid uuid; lid uuid; wid uuid; pid uuid; old public.timer_imports%rowtype; mapped public.timer_import_sessions%rowtype;
 b jsonb;e jsonb;a jsonb;source_state jsonb;state jsonb;next_state jsonb;before_state jsonb;command jsonb;answer jsonb; maps jsonb:='[]';
 sid uuid;local_sid uuid;eid uuid;last_id uuid;rev bigint;ms bigint;at timestamptz;last_at timestamptz;started timestamptz;resumed timestamptz;status text;action text;effective bigint;ar bigint;seen text[];adjust_seen text[]:='{}';total integer:=0;
begin
 if u is null then raise exception 'authentication required' using errcode='28000';end if;
 if p_payload is null or jsonb_typeof(p_payload->'sessions') is distinct from 'array' or jsonb_array_length(p_payload->'sessions') not between 1 and 50 then raise exception 'invalid import sessions' using errcode='22023';end if;
 iid:=(p_payload->>'importId')::uuid;cid:=(p_payload->>'counterImportId')::uuid;lid:=(p_payload->>'localWorkItemId')::uuid;
 if iid is null or cid is null or lid is null then raise exception 'import identities required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text||':timer-import',0));
 select * into old from public.timer_imports where user_id=u and import_id=iid;
 if found then
  if old.source_payload<>p_payload then raise exception 'import id reused' using errcode='22023';end if;
  return old.result||jsonb_build_object('status','duplicate');
 end if;
 select server_work_item_id into wid from public.counter_imports where user_id=u and import_id=cid and local_work_item_id=lid;
 if wid is null then raise exception 'owned counter import required' using errcode='P0002';end if;
 select project_id into pid from public.project_parts where work_item_id=wid and user_id=u;
 if pid is not null then perform 1 from public.projects where id=pid and user_id=u for update;end if;
 perform 1 from public.work_items where id=wid and user_id=u for update;
 if not private.can_read_counter_work_item(wid) then raise exception 'restore project or part before import' using errcode='22023';end if;
 for b in select value from jsonb_array_elements(p_payload->'sessions') loop
  local_sid:=(b->'state'->>'sessionId')::uuid;
  if local_sid is null or exists(select 1 from jsonb_array_elements(maps) m where m->>'localSessionId'=local_sid::text) then raise exception 'duplicate source session' using errcode='22023';end if;
  select * into mapped from public.timer_import_sessions where user_id=u and local_session_id=local_sid;
  if found then
   if mapped.source_payload<>b or not exists(select 1 from public.work_sessions where id=mapped.server_session_id and work_item_id=wid and user_id=u) then raise exception 'source session already imported with different data or target' using errcode='22023';end if;
   maps:=maps||jsonb_build_array(jsonb_build_object('localSessionId',local_sid,'serverSessionId',mapped.server_session_id));continue;
  end if;
  if jsonb_typeof(b->'events') is distinct from 'array' or jsonb_typeof(b->'adjustments') is distinct from 'array' or jsonb_array_length(b->'events')<2 then raise exception 'invalid session history' using errcode='22023';end if;
  total:=total+jsonb_array_length(b->'events')+jsonb_array_length(b->'adjustments');
  if total>5000 then raise exception 'import history limit' using errcode='22023';end if;
  source_state:=private.timer_import_state(b->'state');
  if source_state->>'workItemId'<>lid::text or source_state->>'status'<>'ended' then raise exception 'ended local session required' using errcode='22023';end if;
  sid:=gen_random_uuid();state:=null;rev:=0;ms:=0;seen:='{}';resumed:=null;
  -- Store only an ended session: importing historical transitions never occupies the active-session slot.
  last_id:=gen_random_uuid();
  insert into public.work_sessions(id,user_id,work_item_id,status,started_at,ended_at,accumulated_ms,last_resumed_at,last_transition_at,revision,last_command_id,created_at,updated_at)
  values(sid,u,wid,'ended',(source_state->>'startedAt')::timestamptz,(source_state->>'endedAt')::timestamptz,(source_state->>'accumulatedMs')::bigint,null,(source_state->>'lastTransitionAt')::timestamptz,(source_state->>'revision')::bigint,last_id,(source_state->>'createdAt')::timestamptz,(source_state->>'updatedAt')::timestamptz);
  for e in select value from jsonb_array_elements(b->'events') loop
   command:=e->'command';action:=command->>'action';at:=private.timer_import_at(e->>'effectiveAt');
   perform private.timer_import_at(command->>'occurredAt');
   if (command->>'commandId')::uuid is null or e->>'eventId' is distinct from command->>'commandId' or command->>'commandId'=any(seen) or command->>'sessionId' is distinct from local_sid::text or command->>'workItemId' is distinct from lid::text or private.timer_import_ms(command->'expectedRevision')<>rev or char_length(coalesce(command->>'deviceId','')) not between 1 and 120 then raise exception 'invalid timer command' using errcode='22023';end if;
   seen:=array_append(seen,command->>'commandId');
   if private.timer_import_state(e->'before') is distinct from state then raise exception 'invalid before state' using errcode='22023';end if;
   if rev=0 then
    if action is distinct from 'start' then raise exception 'start required' using errcode='22023';end if;
    started:=at;resumed:=at;status:='running';
   else
    if status='ended' or at<last_at or action not in ('pause','resume','end') or action is null or (action='pause' and status<>'running') or (action='resume' and status<>'paused') then raise exception 'invalid timer transition' using errcode='22023';end if;
    if status='running' then ms:=ms+floor(extract(epoch from (at-resumed))*1000)::bigint;end if;
    status:=case action when 'pause' then 'paused' when 'resume' then 'running' else 'ended' end;
    resumed:=case when status='running' then at else null end;
   end if;
   rev:=rev+1;last_at:=at;
   next_state:=jsonb_build_object('sessionId',local_sid,'workItemId',lid,'userId',null,'status',status,'startedAt',started,'endedAt',case when status='ended' then at end,'accumulatedMs',ms,'lastResumedAt',resumed,'lastTransitionAt',at,'revision',rev,'createdAt',started,'updatedAt',at);
   if private.timer_import_state(e->'after') is distinct from next_state then raise exception 'invalid after state or measured duration' using errcode='22023';end if;
   eid:=case when rev=(source_state->>'revision')::bigint then last_id else gen_random_uuid() end;
   before_state:=case when state is not null then state||jsonb_build_object('sessionId',sid,'workItemId',wid,'userId',u) end;
   state:=next_state;
   next_state:=next_state||jsonb_build_object('sessionId',sid,'workItemId',wid,'userId',u);
   command:=command||jsonb_build_object('commandId',eid,'sessionId',sid,'workItemId',wid);
   insert into public.work_session_events(user_id,command_id,session_id,work_item_id,revision_after,event_type,occurred_at,effective_at,device_id,command,before_state,after_state,result)
   values(u,eid,sid,wid,rev,action,(command->>'occurredAt')::timestamptz,at,command->>'deviceId',command,before_state,next_state,jsonb_build_object('status','applied','state',next_state,'eventId',eid));
  end loop;
  if state is distinct from source_state then raise exception 'final session mismatch' using errcode='22023';end if;
  effective:=ms;ar:=0;
  for a in select value from jsonb_array_elements(b->'adjustments') loop
   ar:=ar+1;
   if a->>'sessionId' is distinct from local_sid::text or a->'userId' is distinct from 'null'::jsonb or private.timer_import_ms(a->'revision')<>ar or private.timer_import_ms(a->'previousAdjustedMs')<>effective or char_length(coalesce(a->>'reason',''))>1000 or a->>'commandId'=any(adjust_seen) or (a->>'commandId')::uuid is null or (a->>'adjustmentId')::uuid is null then raise exception 'invalid adjustment chain' using errcode='22023';end if;
   adjust_seen:=array_append(adjust_seen,a->>'commandId');effective:=private.timer_import_ms(a->'adjustedMs');
   insert into public.work_session_time_adjustments(id,user_id,session_id,command_id,previous_adjusted_ms,adjusted_ms,reason,created_at,adjustment_revision,source_local_adjustment_id)
   values(gen_random_uuid(),u,sid,gen_random_uuid(),(a->>'previousAdjustedMs')::bigint,effective,coalesce(a->>'reason',''),private.timer_import_at(a->>'createdAt'),ar,(a->>'adjustmentId')::uuid);
  end loop;
  insert into public.timer_import_sessions values(u,local_sid,sid,iid,b);
  maps:=maps||jsonb_build_array(jsonb_build_object('localSessionId',local_sid,'serverSessionId',sid));
 end loop;
 answer:=jsonb_build_object('status','imported','importId',iid,'serverWorkItemId',wid,'mappings',maps);
 insert into public.timer_imports values(u,iid,cid,lid,wid,p_payload,answer,clock_timestamp());return answer;
end;$fn$;
revoke all on function private.timer_import_ms(jsonb),private.timer_import_at(text),private.timer_import_state(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.import_timer_snapshot(jsonb) from public,anon,service_role;
grant execute on function public.import_timer_snapshot(jsonb) to authenticated;
commit;
