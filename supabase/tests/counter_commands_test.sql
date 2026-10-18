begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(47);

insert into auth.users (id, email) values
  ('33333333-3333-4333-8333-333333333333', 'rpc-a@example.test'),
  ('44444444-4444-4444-8444-444444444444', 'rpc-b@example.test');

select ok(has_function_privilege('authenticated', 'public.create_counter_work_item()', 'EXECUTE'), 'authenticated may create a work item by RPC');
select ok(has_function_privilege('authenticated', 'public.apply_counter_command(uuid,uuid,bigint,timestamptz,text,jsonb)', 'EXECUTE'), 'authenticated may apply a command by RPC');
select ok(not has_function_privilege('anon', 'public.create_counter_work_item()', 'EXECUTE'), 'anon may not create a server work item');
select ok(not has_function_privilege('anon', 'public.apply_counter_command(uuid,uuid,bigint,timestamptz,text,jsonb)', 'EXECUTE'), 'anon may not apply a server command');
select ok(not has_table_privilege('authenticated', 'public.counters', 'UPDATE'), 'authenticated still cannot update counters directly');
select ok(not has_table_privilege('authenticated', 'public.counter_events', 'INSERT'), 'authenticated still cannot insert events directly');

set local role authenticated;
set local request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
select set_config('test.rpc_work_item_a', public.create_counter_work_item()->'state'->>'workItemId', true);
select is((select revision from public.work_items where id = current_setting('test.rpc_work_item_a')::uuid), 0::bigint, 'new work item starts at revision zero');
select is((select count(*) from public.counters where work_item_id = current_setting('test.rpc_work_item_a')::uuid), 2::bigint, 'creation makes both counter rows');
select is((select count(*) from public.work_items where user_id = auth.uid()), 1::bigint, 'new work item belongs to signed-in user');

select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000001', current_setting('test.rpc_work_item_a')::uuid, 0,
    '2026-10-18 12:00:00+00', 'test-device', '{"type":"change","counter":"stitch","delta":1}'
  )->>'status'
), 'applied', 'stitch increase applies');
select is((select current_value from public.counters where work_item_id = current_setting('test.rpc_work_item_a')::uuid and counter_type = 'stitch'), 1::bigint, 'stitch is one');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000001', current_setting('test.rpc_work_item_a')::uuid, 0,
    '2026-10-18 12:00:00+00', 'test-device', '{"type":"change","counter":"stitch","delta":1}'
  )->>'status'
), 'duplicate', 'same command ID returns duplicate');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000001', current_setting('test.rpc_work_item_a')::uuid, 0,
    '2026-10-18 12:00:00+00', 'test-device', '{"type":"change","counter":"stitch","delta":-1}'
  )->>'status'
), 'rejected', 'same command ID with different action is rejected');
select is((select count(*) from public.counter_events where work_item_id = current_setting('test.rpc_work_item_a')::uuid), 1::bigint, 'duplicate does not add an event');

select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000002', current_setting('test.rpc_work_item_a')::uuid, 1,
    '2026-10-18 12:00:01+00', 'test-device', '{"type":"change","counter":"stitch","delta":-1}'
  )->'state'->'stitch'->>'current'
), '0', 'stitch decrease reaches zero');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000003', current_setting('test.rpc_work_item_a')::uuid, 2,
    '2026-10-18 12:00:02+00', 'test-device', '{"type":"change","counter":"stitch","delta":-1}'
  )->>'status'
), 'rejected', 'decrease below zero is rejected');

select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000004', current_setting('test.rpc_work_item_a')::uuid, 2,
    '2026-10-18 12:00:03+00', 'test-device', '{"type":"setValue","counter":"stitch","value":7}'
  )->'state'->'stitch'->>'current'
), '7', 'direct value edit applies');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000005', current_setting('test.rpc_work_item_a')::uuid, 3,
    '2026-10-18 12:00:04+00', 'test-device', '{"type":"completeRow","stitch":"keep"}'
  )->'state'->'stitch'->>'current'
), '7', 'row completion can retain stitch');
select is((select current_value from public.counters where work_item_id = current_setting('test.rpc_work_item_a')::uuid and counter_type = 'row'), 1::bigint, 'row completion increments row');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000006', current_setting('test.rpc_work_item_a')::uuid, 4,
    '2026-10-18 12:00:05+00', 'test-device', '{"type":"completeRow","stitch":"reset"}'
  )->'state'->'stitch'->>'current'
), '0', 'row completion can reset stitch');
select is((select current_value from public.counters where work_item_id = current_setting('test.rpc_work_item_a')::uuid and counter_type = 'row'), 2::bigint, 'reset completion also increments row');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000007', current_setting('test.rpc_work_item_a')::uuid, 5,
    '2026-10-18 12:00:06+00', 'test-device',
    '{"type":"undo","eventId":"33333333-0000-4000-8000-000000000006"}'
  )->'state'->'stitch'->>'current'
), '7', 'undo restores stitch from previous state');
select is((select current_value from public.counters where work_item_id = current_setting('test.rpc_work_item_a')::uuid and counter_type = 'row'), 1::bigint, 'undo also restores row');
select is((select undo_of_event_id::text from public.counter_events where command_id = '33333333-0000-4000-8000-000000000007'), '33333333-0000-4000-8000-000000000006', 'undo event links to original');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000008', current_setting('test.rpc_work_item_a')::uuid, 6,
    '2026-10-18 12:00:07+00', 'test-device',
    '{"type":"undo","eventId":"33333333-0000-4000-8000-000000000005"}'
  )->'state'->'row'->>'current'
), '0', 'second undo restores the preceding row');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000009', current_setting('test.rpc_work_item_a')::uuid, 7,
    '2026-10-18 12:00:08+00', 'test-device',
    '{"type":"undo","eventId":"33333333-0000-4000-8000-000000000006"}'
  )->>'status'
), 'rejected', 'already undone event cannot be undone twice');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000010', current_setting('test.rpc_work_item_a')::uuid, 5,
    '2026-10-18 12:00:09+00', 'test-device', '{"type":"change","counter":"stitch","delta":1}'
  )->>'status'
), 'conflict', 'stale revision returns conflict');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000011', current_setting('test.rpc_work_item_a')::uuid, 7,
    '2026-10-18 12:00:10+00', 'test-device', '{"type":"setTarget","counter":"row","value":1}'
  )->'state'->'row'->>'target'
), '1', 'target can be set');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000012', current_setting('test.rpc_work_item_a')::uuid, 8,
    '2026-10-18 12:00:11+00', 'test-device', '{"type":"change","counter":"row","delta":1}'
  )->'state'->'row'->>'current'
), '1', 'target does not cap current value');
select is((select revision from public.work_items where id = current_setting('test.rpc_work_item_a')::uuid), 9::bigint, 'work item revision matches accepted events');
select is((select count(*) from public.counter_events where work_item_id = current_setting('test.rpc_work_item_a')::uuid), 9::bigint, 'one event exists per accepted command');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000001', current_setting('test.rpc_work_item_a')::uuid, 0,
    '2026-10-18 12:00:00+00', 'test-device', '{"type":"change","counter":"stitch","delta":1}'
  )->>'revision'
), '1', 'replay returns original applied revision');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000001', current_setting('test.rpc_work_item_a')::uuid, 0,
    '2026-10-18 12:00:00+00', 'test-device', '{"type":"change","counter":"stitch","delta":1}'
  )->>'latestRevision'
), '9', 'replay also reports latest revision');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000013', current_setting('test.rpc_work_item_a')::uuid, 9,
    '2026-10-18 12:00:13+00', 'test-device',
    '{"type":"change","counter":"stitch","delta":1,"after":{"stitch":999}}'
  )->>'status'
), 'rejected', 'client-supplied next state is not accepted');

select set_config('test.rpc_work_item_extra', public.create_counter_work_item()->'state'->>'workItemId', true);
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000020', current_setting('test.rpc_work_item_extra')::uuid, 0,
    '2026-10-18 12:01:00+00', 'test-device', '{"type":"setTarget","counter":"stitch","value":1}'
  )->'state'->'stitch'->>'target'
), '1', 'stitch target can be set');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000021', current_setting('test.rpc_work_item_extra')::uuid, 1,
    '2026-10-18 12:01:01+00', 'test-device', '{"type":"setValue","counter":"stitch","value":5}'
  )->'state'->'stitch'->>'current'
), '5', 'current value may exceed target');
select ok((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000022', current_setting('test.rpc_work_item_extra')::uuid, 2,
    '2026-10-18 12:01:02+00', 'test-device', '{"type":"setTarget","counter":"stitch","value":null}'
  )->'state'->'stitch'->'target'
) = 'null'::jsonb, 'target can be cleared');
select is((
  public.apply_counter_command(
    '33333333-0000-4000-8000-000000000023', current_setting('test.rpc_work_item_extra')::uuid, 3,
    '2026-10-18 12:01:03+00', 'test-device', '{"type":"setValue","counter":"row","value":4}'
  )->'state'->'row'->>'current'
), '4', 'row can be edited directly');
select is((select count(*) from public.counter_events where work_item_id = current_setting('test.rpc_work_item_extra')::uuid), 4::bigint, 'all extra edits have append-only events');

set local request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';
select is((
  public.apply_counter_command(
    '44444444-0000-4000-8000-000000000001', current_setting('test.rpc_work_item_a')::uuid, 9,
    '2026-10-18 12:00:12+00', 'other-device', '{"type":"change","counter":"stitch","delta":1}'
  )->>'status'
), 'rejected', 'other user cannot modify work item');
select is((select count(*) from public.work_items), 0::bigint, 'RLS hides other user work items');
select set_config('test.rpc_work_item_b', public.create_counter_work_item()->'state'->>'workItemId', true);
select is((select count(*) from public.counters where work_item_id = current_setting('test.rpc_work_item_b')::uuid), 2::bigint, 'other user can create own work item');

reset role;
select is((select count(*) from public.counter_events where work_item_id = current_setting('test.rpc_work_item_a')::uuid and previous_state->>'workItemId' = current_setting('test.rpc_work_item_a')), 9::bigint, 'all event snapshots belong to work item');
select is((select count(*) from public.counter_events where work_item_id = current_setting('test.rpc_work_item_a')::uuid and revision_after = revision_before + 1), 9::bigint, 'all event revisions advance by one');

-- Force the final event INSERT to fail after the RPC updates both counters.
-- The statement must roll back its earlier updates.
insert into public.counter_events (
  id, work_item_id, command_id, device_id, event_type, previous_state,
  next_state, revision_before, revision_after, occurred_at
) values (
  '33333333-0000-4000-8000-000000000099', current_setting('test.rpc_work_item_a')::uuid,
  '33333333-0000-4000-8000-000000000099', 'test-device', 'change', '{}', '{}', 9, 10, now()
);
set local role authenticated;
set local request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
select throws_ok(
  format(
    'select public.apply_counter_command(%L::uuid, current_setting(''test.rpc_work_item_a'')::uuid, 9, %L::timestamptz, %L, %L::jsonb)',
    '33333333-0000-4000-8000-000000000014', '2026-10-18 12:00:14+00',
    'test-device', '{"type":"change","counter":"stitch","delta":1}'
  ),
  '23505', null, 'event insert failure rolls back the entire RPC'
);
select is((select revision from public.work_items where id = current_setting('test.rpc_work_item_a')::uuid), 9::bigint, 'failed event insert leaves work item revision unchanged');
select is((select current_value from public.counters where work_item_id = current_setting('test.rpc_work_item_a')::uuid and counter_type = 'stitch'), 7::bigint, 'failed event insert leaves counter unchanged');
reset role;

select * from finish();
rollback;
