begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(24);

insert into auth.users (id, email) values
  ('55555555-5555-4555-8555-555555555555', 'import-a@example.test'),
  ('66666666-6666-4666-8666-666666666666', 'import-b@example.test');

select ok(has_function_privilege('authenticated', 'public.import_counter_snapshot(jsonb)', 'EXECUTE'), 'authenticated may import by RPC');
select ok(not has_function_privilege('anon', 'public.import_counter_snapshot(jsonb)', 'EXECUTE'), 'anonymous cannot import');
select ok(not has_table_privilege('authenticated', 'public.counter_imports', 'INSERT'), 'receipt table is not directly writable');
select ok(not has_table_privilege('authenticated', 'public.counter_events', 'INSERT'), 'events remain read-only to clients');
select ok(not has_table_privilege('authenticated', 'public.counter_events', 'UPDATE'), 'events remain append-only to clients');

select set_config('test.import_payload', jsonb_build_object(
  'importId', '77777777-7777-4777-8777-777777777777',
  'localWorkItemId', '88888888-8888-4888-8888-888888888888',
  'state', private.counter_state_json('88888888-8888-4888-8888-888888888888', 4, 1, 5, 0, null),
  'events', jsonb_build_array(
    jsonb_build_object('eventId','99999999-0000-4000-8000-000000000001','commandId','99999999-0000-4000-8000-000000000001','workItemId','88888888-8888-4888-8888-888888888888','occurredAt','2026-10-18T12:00:01.000Z','deviceId','local-device','action',jsonb_build_object('type','change','counter','stitch','delta',1),'before',private.counter_state_json('88888888-8888-4888-8888-888888888888',0,0,null,0,null),'after',private.counter_state_json('88888888-8888-4888-8888-888888888888',1,1,null,0,null)),
    jsonb_build_object('eventId','99999999-0000-4000-8000-000000000002','commandId','99999999-0000-4000-8000-000000000002','workItemId','88888888-8888-4888-8888-888888888888','occurredAt','2026-10-18T12:00:02.000Z','deviceId','local-device','action',jsonb_build_object('type','completeRow','stitch','reset'),'before',private.counter_state_json('88888888-8888-4888-8888-888888888888',1,1,null,0,null),'after',private.counter_state_json('88888888-8888-4888-8888-888888888888',2,0,null,1,null)),
    jsonb_build_object('eventId','99999999-0000-4000-8000-000000000003','commandId','99999999-0000-4000-8000-000000000003','workItemId','88888888-8888-4888-8888-888888888888','occurredAt','2026-10-18T12:00:03.000Z','deviceId','local-device','action',jsonb_build_object('type','undo','eventId','99999999-0000-4000-8000-000000000002'),'before',private.counter_state_json('88888888-8888-4888-8888-888888888888',2,0,null,1,null),'after',private.counter_state_json('88888888-8888-4888-8888-888888888888',3,1,null,0,null)),
    jsonb_build_object('eventId','99999999-0000-4000-8000-000000000004','commandId','99999999-0000-4000-8000-000000000004','workItemId','88888888-8888-4888-8888-888888888888','occurredAt','2026-10-18T12:00:04.000Z','deviceId','local-device','action',jsonb_build_object('type','setTarget','counter','stitch','value',5),'before',private.counter_state_json('88888888-8888-4888-8888-888888888888',3,1,null,0,null),'after',private.counter_state_json('88888888-8888-4888-8888-888888888888',4,1,5,0,null))
  )
)::text, true);

set local role authenticated;
set local request.jwt.claim.sub = '55555555-5555-4555-8555-555555555555';
select set_config('test.preexisting_id', public.create_counter_work_item()->'state'->>'workItemId', true);
select set_config('test.import_result_a', public.import_counter_snapshot(current_setting('test.import_payload')::jsonb)::text, true);
select is((current_setting('test.import_result_a')::jsonb->>'status'), 'imported', 'snapshot imported');
select is((select count(*) from public.work_items), 2::bigint, 'existing account work item was not overwritten');
select is((select revision from public.work_items where id = (current_setting('test.import_result_a')::jsonb->>'serverWorkItemId')::uuid), 4::bigint, 'revision matches imported event count');
select is((select current_value from public.counters where work_item_id = (current_setting('test.import_result_a')::jsonb->>'serverWorkItemId')::uuid and counter_type = 'stitch'), 1::bigint, 'final stitch count preserved');
select is((select target_value from public.counters where work_item_id = (current_setting('test.import_result_a')::jsonb->>'serverWorkItemId')::uuid and counter_type = 'stitch'), 5::bigint, 'target preserved');
select is((select current_value from public.counters where work_item_id = (current_setting('test.import_result_a')::jsonb->>'serverWorkItemId')::uuid and counter_type = 'row'), 0::bigint, 'row count preserved after undo');
select is((select count(*) from public.counter_events where work_item_id = (current_setting('test.import_result_a')::jsonb->>'serverWorkItemId')::uuid), 4::bigint, 'all four events preserved');
select is((select occurred_at::text from public.counter_events where work_item_id = (current_setting('test.import_result_a')::jsonb->>'serverWorkItemId')::uuid and revision_after = 1), '2026-10-18 12:00:01+00', 'original command occurrence time preserved');
select is((select undo_of_event_id from public.counter_events where work_item_id = (current_setting('test.import_result_a')::jsonb->>'serverWorkItemId')::uuid and revision_after = 3), (select id from public.counter_events where work_item_id = (current_setting('test.import_result_a')::jsonb->>'serverWorkItemId')::uuid and revision_after = 2), 'undo relationship remapped correctly');
select is((select source_payload->'events'->2->'action'->>'eventId' from public.counter_imports where user_id = auth.uid()), '99999999-0000-4000-8000-000000000002', 'original event IDs retained in immutable receipt');
select is(public.import_counter_snapshot(current_setting('test.import_payload')::jsonb)->>'status', 'duplicate', 'lost acknowledgment retry returns existing result');
select is((select count(*) from public.work_items), 2::bigint, 'duplicate does not create another work item');
select throws_ok(format('select public.import_counter_snapshot(%L::jsonb)', jsonb_set(current_setting('test.import_payload')::jsonb, '{state,stitch,current}', '2'::jsonb)::text), '22023', null, 'same import ID with changed payload is rejected');
select throws_ok(format('select public.import_counter_snapshot(%L::jsonb)', jsonb_set(jsonb_set(current_setting('test.import_payload')::jsonb, '{importId}', '"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"'::jsonb), '{events,0,after,stitch,current}', '99'::jsonb)::text), '22023', null, 'forged event after-state is rejected atomically');
select is((select count(*) from public.work_items), 2::bigint, 'invalid import left no partial work item');

set local request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';
select is((select count(*) from public.counter_imports), 0::bigint, 'RLS hides other account receipts');
select is((select count(*) from public.work_items), 0::bigint, 'RLS hides other account work items');
select set_config('test.import_result_b', public.import_counter_snapshot(current_setting('test.import_payload')::jsonb)::text, true);
select is((current_setting('test.import_result_b')::jsonb->>'status'), 'imported', 'another user may independently import same source ID');
select isnt((current_setting('test.import_result_a')::jsonb->>'serverWorkItemId'), (current_setting('test.import_result_b')::jsonb->>'serverWorkItemId'), 'users receive distinct server work items');

select * from finish();
rollback;
