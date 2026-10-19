-- Phase 1B-2: replay an immutable local snapshot into a new owner-scoped work item.
-- The original Phase 1B-1 command RPC and append-only event table are unchanged.
create table public.counter_imports (
  user_id uuid not null references auth.users (id) on delete restrict,
  import_id uuid not null,
  local_work_item_id uuid not null,
  server_work_item_id uuid not null unique references public.work_items (id) on delete restrict,
  imported_revision bigint not null check (imported_revision between 0 and 9007199254740991),
  source_payload jsonb not null check (jsonb_typeof(source_payload) = 'object'),
  created_at timestamptz not null default now(),
  primary key (user_id, import_id)
);
create index counter_imports_user_created_idx on public.counter_imports (user_id, created_at desc);
alter table public.counter_imports enable row level security;
revoke all on public.counter_imports from public, anon, authenticated;
grant select on public.counter_imports to authenticated;
create policy "read own counter imports" on public.counter_imports
  for select to authenticated using ((select auth.uid()) = user_id);

create function private.import_counter_snapshot_internal(p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_import_id uuid;
  v_local_id uuid;
  v_server_id uuid;
  v_existing public.counter_imports%rowtype;
  v_source_state jsonb;
  v_event jsonb;
  v_action jsonb;
  v_result jsonb;
  v_source_id text;
  v_undo_source_id text;
  v_server_event_id uuid;
  v_map jsonb := '{}'::jsonb;
  v_event_count integer;
begin
  if v_user_id is null then
    return jsonb_build_object('status', 'rejected', 'reason', '로그인이 필요합니다.');
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or jsonb_typeof(p_payload->'events') is distinct from 'array'
     or jsonb_typeof(p_payload->'state') is distinct from 'object'
     or coalesce(p_payload->>'importId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(p_payload->>'localWorkItemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception '유효하지 않은 가져오기 요청입니다.' using errcode = '22023';
  end if;
  v_import_id := (p_payload->>'importId')::uuid;
  v_local_id := (p_payload->>'localWorkItemId')::uuid;
  v_event_count := jsonb_array_length(p_payload->'events');

  -- A retry uses the identical frozen payload. The lock closes the concurrent request race.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || v_import_id::text, 1));
  select * into v_existing from public.counter_imports
    where user_id = v_user_id and import_id = v_import_id;
  if found then
    if v_existing.source_payload is distinct from p_payload then
      raise exception '동일한 가져오기 ID에 다른 기록을 보낼 수 없습니다.' using errcode = '22023';
    end if;
    return jsonb_build_object(
      'status', 'duplicate', 'importId', v_import_id,
      'localWorkItemId', v_existing.local_work_item_id,
      'serverWorkItemId', v_existing.server_work_item_id,
      'importedRevision', v_existing.imported_revision
    );
  end if;

  v_source_state := private.counter_state_json(v_local_id, 0, 0, null, 0, null);
  if p_payload->'state'->>'workItemId' is distinct from v_local_id::text
     or p_payload->'state'->>'revision' is distinct from v_event_count::text then
    raise exception '최종 상태와 이벤트 개수가 일치하지 않습니다.' using errcode = '22023';
  end if;
  v_result := private.create_counter_work_item_internal();
  if v_result->>'status' <> 'created' then
    raise exception '서버 작업을 만들 수 없습니다.' using errcode = '22023';
  end if;
  v_server_id := (v_result->'state'->>'workItemId')::uuid;

  for v_event in select value from jsonb_array_elements(p_payload->'events') loop
    v_source_id := v_event->>'eventId';
    if jsonb_typeof(v_event) <> 'object'
       or coalesce(v_source_id, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or v_event->>'commandId' is distinct from v_source_id
       or v_event->>'workItemId' is distinct from v_local_id::text
       or v_event->'before' is distinct from v_source_state
       or v_event->'after'->>'workItemId' is distinct from v_local_id::text
       or v_map ? v_source_id then
      raise exception '로컬 이벤트의 ID 또는 이전 상태가 올바르지 않습니다.' using errcode = '22023';
    end if;
    v_action := v_event->'action';
    if jsonb_typeof(v_action) <> 'object' then
      raise exception '로컬 이벤트 동작이 올바르지 않습니다.' using errcode = '22023';
    end if;
    if v_action->>'type' = 'undo' then
      v_undo_source_id := v_action->>'eventId';
      if not (v_map ? coalesce(v_undo_source_id, '')) then
        raise exception '실행 취소 대상 이벤트가 존재하지 않습니다.' using errcode = '22023';
      end if;
      v_action := jsonb_set(v_action, '{eventId}', to_jsonb(v_map->>v_undo_source_id));
    end if;
    v_server_event_id := gen_random_uuid();
    v_result := private.apply_counter_command_internal(
      v_server_event_id, v_server_id, (v_source_state->>'revision')::bigint,
      (v_event->>'occurredAt')::timestamptz, v_event->>'deviceId', v_action
    );
    if v_result->>'status' <> 'applied'
       or v_result->'state' is distinct from jsonb_set(v_event->'after', '{workItemId}', to_jsonb(v_server_id::text)) then
      raise exception '로컬 이벤트의 변경 후 상태가 명령 결과와 일치하지 않습니다.' using errcode = '22023';
    end if;
    v_map := v_map || jsonb_build_object(v_source_id, v_server_event_id);
    v_source_state := v_event->'after';
  end loop;
  if v_source_state is distinct from p_payload->'state' then
    raise exception '최종 카운터 값이 이벤트 이력과 일치하지 않습니다.' using errcode = '22023';
  end if;

  insert into public.counter_imports (
    user_id, import_id, local_work_item_id, server_work_item_id,
    imported_revision, source_payload
  ) values (v_user_id, v_import_id, v_local_id, v_server_id, v_event_count, p_payload);
  return jsonb_build_object(
    'status', 'imported', 'importId', v_import_id,
    'localWorkItemId', v_local_id, 'serverWorkItemId', v_server_id,
    'importedRevision', v_event_count
  );
end;
$function$;
revoke all on function private.import_counter_snapshot_internal(jsonb) from public, anon, service_role;
grant execute on function private.import_counter_snapshot_internal(jsonb) to authenticated;

create function public.import_counter_snapshot(p_payload jsonb)
returns jsonb language sql security invoker set search_path = ''
as $function$
  select private.import_counter_snapshot_internal(p_payload)
$function$;
revoke all on function public.import_counter_snapshot(jsonb) from public, anon, service_role;
grant execute on function public.import_counter_snapshot(jsonb) to authenticated;
