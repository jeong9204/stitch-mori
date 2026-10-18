begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(25);

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'stitch-a@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'stitch-b@example.test');

insert into public.work_items (id, user_id, revision) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 1),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 1);

insert into public.counters (id, work_item_id, counter_type, current_value) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'stitch', 3),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'stitch', 5);

insert into public.counter_events (
  id, work_item_id, command_id, device_id, event_type,
  previous_state, next_state, revision_before, revision_after, occurred_at
) values
  ('aaaaaaaa-0000-4000-8000-000000000011', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'aaaaaaaa-0000-4000-8000-000000000021', 'test-device-a', 'change',
   '{"stitch":0,"row":0}', '{"stitch":3,"row":0}', 0, 1, now()),
  ('aaaaaaaa-0000-4000-8000-000000000012', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   'aaaaaaaa-0000-4000-8000-000000000022', 'test-device-b', 'change',
   '{"stitch":0,"row":0}', '{"stitch":5,"row":0}', 0, 1, now());

select has_table('public', 'work_items', 'work_items exists');
select has_table('public', 'counters', 'counters exists');
select has_table('public', 'counter_events', 'counter_events exists');
select ok((select relrowsecurity from pg_class where oid = 'public.work_items'::regclass), 'work_items RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.counters'::regclass), 'counters RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.counter_events'::regclass), 'counter_events RLS enabled');

select throws_ok(
  $$insert into public.work_items (user_id, revision) values ('11111111-1111-4111-8111-111111111111', -1)$$,
  '23514', null, 'negative revision is rejected');
select throws_ok(
  $$insert into public.work_items (user_id) values ('33333333-3333-4333-8333-333333333333')$$,
  '23503', null, 'unknown user is rejected by FK');
select throws_ok(
  $$insert into public.counters (work_item_id, counter_type, current_value) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'row', -1)$$,
  '23514', null, 'negative count is rejected');
select throws_ok(
  $$insert into public.counters (work_item_id, counter_type, target_value) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'row', 0)$$,
  '23514', null, 'zero target is rejected');
select throws_ok(
  $$insert into public.counters (work_item_id, counter_type) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'stitch')$$,
  '23505', null, 'duplicate counter type is rejected');
select throws_ok(
  $$insert into public.counter_events (work_item_id, command_id, device_id, event_type, previous_state, next_state, revision_before, revision_after, occurred_at)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000021', 'test', 'change', '{}', '{}', 1, 2, now())$$,
  '23505', null, 'duplicate command ID is rejected');
select throws_ok(
  $$insert into public.counter_events (work_item_id, command_id, device_id, event_type, previous_state, next_state, revision_before, revision_after, occurred_at)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000023', 'test', 'change', '{}', '{}', 0, 1, now())$$,
  '23505', null, 'duplicate work item revision is rejected');
select throws_ok(
  $$update public.counter_events set device_id = 'changed' where id = 'aaaaaaaa-0000-4000-8000-000000000011'$$,
  'P0001', null, 'event update is rejected');
select throws_ok(
  $$delete from public.counter_events where id = 'aaaaaaaa-0000-4000-8000-000000000011'$$,
  'P0001', null, 'event deletion is rejected');

select ok(not has_table_privilege('authenticated', 'public.work_items', 'INSERT'), 'authenticated cannot insert work items directly');
select ok(not has_table_privilege('authenticated', 'public.counters', 'UPDATE'), 'authenticated cannot update counters directly');
select ok(not has_table_privilege('authenticated', 'public.counter_events', 'INSERT'), 'authenticated cannot insert events directly');
select ok(not has_table_privilege('anon', 'public.work_items', 'SELECT'), 'anon cannot read server work items');

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select results_eq('select id::text from public.work_items', array['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], 'user A sees only own work item');
select results_eq('select work_item_id::text from public.counters', array['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], 'user A sees only own counter');
select results_eq('select work_item_id::text from public.counter_events', array['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], 'user A sees only own event');

set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
select results_eq('select id::text from public.work_items', array['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], 'user B sees only own work item');
select results_eq('select work_item_id::text from public.counters', array['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], 'user B sees only own counter');
select results_eq('select work_item_id::text from public.counter_events', array['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], 'user B sees only own event');

select * from finish();
rollback;
