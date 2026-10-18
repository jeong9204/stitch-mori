-- Phase 1B-1: authenticated, atomic server counter commands.
-- The existing tables and their read-only client grants remain unchanged.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- Historical rows may not have an action payload. New RPC events always do.
alter table public.counter_events
  add column action jsonb
  constraint counter_events_action_object check (action is null or jsonb_typeof(action) = 'object');

create unique index counter_events_one_undo_per_event_idx
  on public.counter_events (undo_of_event_id)
  where undo_of_event_id is not null;

create function private.counter_state_json(
  p_work_item_id uuid, p_revision bigint,
  p_stitch bigint, p_stitch_target bigint,
  p_row bigint, p_row_target bigint
) returns jsonb
language sql immutable
set search_path = ''
as $function$
  select jsonb_build_object(
    'workItemId', p_work_item_id, 'revision', p_revision,
    'stitch', jsonb_build_object('current', p_stitch, 'target', p_stitch_target),
    'row', jsonb_build_object('current', p_row, 'target', p_row_target)
  )
$function$;

revoke all on function private.counter_state_json(uuid,bigint,bigint,bigint,bigint,bigint)
  from public, anon, authenticated, service_role;

create function private.create_counter_work_item_internal()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_work_item_id uuid;
begin
  if v_user_id is null then
    return jsonb_build_object('status', 'rejected', 'reason', '로그인이 필요합니다.');
  end if;

  insert into public.work_items (user_id)
    values (v_user_id) returning id into v_work_item_id;
  insert into public.counters (work_item_id, counter_type)
    values (v_work_item_id, 'stitch'), (v_work_item_id, 'row');

  return jsonb_build_object(
    'status', 'created',
    'state', private.counter_state_json(v_work_item_id, 0, 0, null, 0, null),
    'revision', 0
  );
end;
$function$;

revoke all on function private.create_counter_work_item_internal()
  from public, anon, service_role;
grant execute on function private.create_counter_work_item_internal() to authenticated;

create function public.create_counter_work_item()
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.create_counter_work_item_internal()
$function$;

revoke all on function public.create_counter_work_item()
  from public, anon, service_role;
grant execute on function public.create_counter_work_item() to authenticated;

create function private.apply_counter_command_internal(
  p_command_id uuid,
  p_work_item_id uuid,
  p_expected_revision bigint,
  p_occurred_at timestamptz,
  p_device_id text,
  p_action jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_work_item public.work_items%rowtype;
  v_existing public.counter_events%rowtype;
  v_undo public.counter_events%rowtype;
  v_stitch bigint;
  v_row bigint;
  v_stitch_target bigint;
  v_row_target bigint;
  v_counter_count integer;
  v_before jsonb;
  v_after jsonb;
  v_action_type text;
  v_event_type text;
  v_counter text;
  v_number_text text;
  v_number bigint;
  v_key_count integer;
  v_undo_id uuid;
  v_max constant bigint := 9007199254740991;
begin
  if auth.uid() is null or p_work_item_id is null then
    return jsonb_build_object('status', 'rejected', 'reason', '작업을 사용할 수 없습니다.');
  end if;

  -- The definer bypasses RLS, so ownership must be checked before any event lookup.
  select * into v_work_item
    from public.work_items
    where id = p_work_item_id and user_id = auth.uid()
    for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', '작업을 사용할 수 없습니다.');
  end if;

  if p_command_id is null or p_expected_revision is null
     or p_expected_revision < 0 or p_expected_revision > v_max
     or p_occurred_at is null or p_device_id is null
     or char_length(p_device_id) not between 1 and 128
     or p_action is null or jsonb_typeof(p_action) <> 'object' then
    return jsonb_build_object('status', 'rejected', 'reason', '유효하지 않은 카운터 명령입니다.');
  end if;

  -- Same command ID on another work item is serialized before the global UNIQUE check.
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text, 0));
  select * into v_existing from public.counter_events where command_id = p_command_id;
  if found then
    if v_existing.work_item_id <> p_work_item_id
       or v_existing.revision_before <> p_expected_revision
       or v_existing.device_id <> p_device_id
       or v_existing.occurred_at <> p_occurred_at
       or v_existing.action is distinct from p_action then
      return jsonb_build_object('status', 'rejected', 'reason', '이미 다른 명령에 사용된 ID입니다.');
    end if;
    return jsonb_build_object(
      'status', 'duplicate', 'state', v_existing.next_state,
      'eventId', v_existing.id, 'revision', v_existing.revision_after,
      'latestRevision', v_work_item.revision
    );
  end if;

  select count(*) into v_counter_count from public.counters where work_item_id = p_work_item_id;
  if v_counter_count <> 2 then
    return jsonb_build_object('status', 'rejected', 'reason', '카운터 데이터가 완전하지 않습니다.');
  end if;
  select current_value, target_value into v_stitch, v_stitch_target
    from public.counters where work_item_id = p_work_item_id and counter_type = 'stitch';
  select current_value, target_value into v_row, v_row_target
    from public.counters where work_item_id = p_work_item_id and counter_type = 'row';
  v_before := private.counter_state_json(
    p_work_item_id, v_work_item.revision, v_stitch, v_stitch_target, v_row, v_row_target
  );

  if v_work_item.revision <> p_expected_revision then
    return jsonb_build_object(
      'status', 'conflict', 'current', v_before, 'latestRevision', v_work_item.revision
    );
  end if;
  if v_work_item.revision >= v_max then
    return jsonb_build_object('status', 'rejected', 'reason', 'revision 한도에 도달했습니다.');
  end if;

  v_action_type := p_action->>'type';
  select count(*) into v_key_count from jsonb_object_keys(p_action);
  if v_action_type = 'change' then
    v_counter := p_action->>'counter';
    if v_key_count <> 3 or jsonb_typeof(p_action->'counter') is distinct from 'string'
       or coalesce(v_counter, '') not in ('stitch', 'row')
       or jsonb_typeof(p_action->'delta') is distinct from 'number'
       or coalesce(p_action->>'delta', '') not in ('1', '-1') then
      return jsonb_build_object('status', 'rejected', 'reason', '유효하지 않은 증가·감소 명령입니다.');
    end if;
    if v_counter = 'stitch' then
      v_stitch := v_stitch + (p_action->>'delta')::bigint;
      if v_stitch < 0 or v_stitch > v_max then
        return jsonb_build_object('status', 'rejected', 'reason', '코수 범위를 벗어났습니다.');
      end if;
    else
      v_row := v_row + (p_action->>'delta')::bigint;
      if v_row < 0 or v_row > v_max then
        return jsonb_build_object('status', 'rejected', 'reason', '단수 범위를 벗어났습니다.');
      end if;
    end if;
    v_event_type := 'change';

  elsif v_action_type = 'completeRow' then
    if v_key_count <> 2 or jsonb_typeof(p_action->'stitch') is distinct from 'string'
       or coalesce(p_action->>'stitch', '') not in ('reset', 'keep') then
      return jsonb_build_object('status', 'rejected', 'reason', '유효하지 않은 단 완료 명령입니다.');
    end if;
    if v_row >= v_max then
      return jsonb_build_object('status', 'rejected', 'reason', '단수 범위를 벗어났습니다.');
    end if;
    v_row := v_row + 1;
    if p_action->>'stitch' = 'reset' then v_stitch := 0; end if;
    v_event_type := 'complete_row';

  elsif v_action_type in ('setValue', 'setTarget') then
    v_counter := p_action->>'counter';
    if v_key_count <> 3 or jsonb_typeof(p_action->'counter') is distinct from 'string'
       or coalesce(v_counter, '') not in ('stitch', 'row') or not (p_action ? 'value') then
      return jsonb_build_object('status', 'rejected', 'reason', '유효하지 않은 값 수정 명령입니다.');
    end if;
    if v_action_type = 'setTarget' and jsonb_typeof(p_action->'value') = 'null' then
      v_number := null;
    else
      v_number_text := p_action->>'value';
      if jsonb_typeof(p_action->'value') is distinct from 'number'
         or coalesce(char_length(v_number_text), 17) > 16
         or coalesce(v_number_text, '') !~ '^[0-9]+$' then
        return jsonb_build_object('status', 'rejected', 'reason', '0 이상의 정수를 입력해 주세요.');
      end if;
      v_number := v_number_text::bigint;
      if v_number > v_max or (v_action_type = 'setTarget' and v_number = 0) then
        return jsonb_build_object('status', 'rejected', 'reason', '값 범위를 벗어났습니다.');
      end if;
    end if;
    if v_action_type = 'setValue' then
      if v_counter = 'stitch' then v_stitch := v_number; else v_row := v_number; end if;
      v_event_type := 'set_value';
    else
      if v_counter = 'stitch' then v_stitch_target := v_number; else v_row_target := v_number; end if;
      v_event_type := 'set_target';
    end if;

  elsif v_action_type = 'undo' then
    if v_key_count <> 2 or jsonb_typeof(p_action->'eventId') is distinct from 'string'
       or coalesce(p_action->>'eventId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return jsonb_build_object('status', 'rejected', 'reason', '유효하지 않은 실행 취소 명령입니다.');
    end if;
    select e.* into v_undo
      from public.counter_events e
      where e.work_item_id = p_work_item_id
        and e.event_type <> 'undo'
        and not exists (
          select 1 from public.counter_events u where u.undo_of_event_id = e.id
        )
      order by e.revision_after desc limit 1;
    if not found or v_undo.id <> (p_action->>'eventId')::uuid then
      return jsonb_build_object('status', 'rejected', 'reason', '직전 변경만 실행 취소할 수 있습니다.');
    end if;
    if v_undo.previous_state #>> '{stitch,current}' is null
       or v_undo.previous_state #>> '{row,current}' is null then
      return jsonb_build_object('status', 'rejected', 'reason', '과거 이벤트 상태를 복원할 수 없습니다.');
    end if;
    v_stitch := (v_undo.previous_state #>> '{stitch,current}')::bigint;
    v_row := (v_undo.previous_state #>> '{row,current}')::bigint;
    v_stitch_target := (v_undo.previous_state #>> '{stitch,target}')::bigint;
    v_row_target := (v_undo.previous_state #>> '{row,target}')::bigint;
    v_undo_id := v_undo.id;
    v_event_type := 'undo';
  else
    return jsonb_build_object('status', 'rejected', 'reason', '알 수 없는 카운터 명령입니다.');
  end if;

  v_after := private.counter_state_json(
    p_work_item_id, v_work_item.revision + 1,
    v_stitch, v_stitch_target, v_row, v_row_target
  );
  update public.counters
    set current_value = v_stitch, target_value = v_stitch_target, updated_at = now()
    where work_item_id = p_work_item_id and counter_type = 'stitch';
  update public.counters
    set current_value = v_row, target_value = v_row_target, updated_at = now()
    where work_item_id = p_work_item_id and counter_type = 'row';
  update public.work_items
    set revision = revision + 1, updated_at = now()
    where id = p_work_item_id;
  insert into public.counter_events (
    id, work_item_id, command_id, device_id, event_type, action,
    previous_state, next_state, revision_before, revision_after,
    undo_of_event_id, occurred_at
  ) values (
    p_command_id, p_work_item_id, p_command_id, p_device_id, v_event_type, p_action,
    v_before, v_after, v_work_item.revision, v_work_item.revision + 1,
    v_undo_id, p_occurred_at
  );
  return jsonb_build_object(
    'status', 'applied', 'state', v_after, 'eventId', p_command_id,
    'revision', v_work_item.revision + 1, 'latestRevision', v_work_item.revision + 1
  );
end;
$function$;

revoke all on function private.apply_counter_command_internal(uuid,uuid,bigint,timestamptz,text,jsonb)
  from public, anon, service_role;
grant execute on function private.apply_counter_command_internal(uuid,uuid,bigint,timestamptz,text,jsonb)
  to authenticated;

create function public.apply_counter_command(
  p_command_id uuid,
  p_work_item_id uuid,
  p_expected_revision bigint,
  p_occurred_at timestamptz,
  p_device_id text,
  p_action jsonb
) returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.apply_counter_command_internal(
    p_command_id, p_work_item_id, p_expected_revision,
    p_occurred_at, p_device_id, p_action
  )
$function$;

revoke all on function public.apply_counter_command(uuid,uuid,bigint,timestamptz,text,jsonb)
  from public, anon, service_role;
grant execute on function public.apply_counter_command(uuid,uuid,bigint,timestamptz,text,jsonb)
  to authenticated;
