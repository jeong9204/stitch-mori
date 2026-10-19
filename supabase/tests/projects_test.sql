begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(35);

insert into auth.users (id, email) values
  ('12121212-1212-4121-8121-121212121212', 'project-a@example.test'),
  ('34343434-3434-4343-8343-343434343434', 'project-b@example.test');

select ok(has_function_privilege('authenticated', 'public.create_project(uuid,text,text)', 'EXECUTE'), 'signed-in user can create by RPC');
select ok(not has_function_privilege('anon', 'public.create_project(uuid,text,text)', 'EXECUTE'), 'anonymous cannot create');
select ok(not has_table_privilege('authenticated', 'public.projects', 'INSERT'), 'clients cannot insert projects directly');
select ok(not has_table_privilege('authenticated', 'public.projects', 'UPDATE'), 'clients cannot bypass project revision');
select ok(not has_table_privilege('authenticated', 'public.project_parts', 'INSERT'), 'clients cannot link arbitrary parts');
select ok(not has_table_privilege('authenticated', 'public.work_items', 'INSERT'), 'counter work items stay RPC-only');
select ok(not has_table_privilege('authenticated', 'public.counter_events', 'INSERT'), 'counter events stay RPC-only');

set local role authenticated;
set local request.jwt.claim.sub = '12121212-1212-4121-8121-121212121212';
select set_config('test.project_a', public.create_project('11111111-1111-4111-8111-111111111111', '  봄 카디건  ', '  메모  ')::text, true);
select is(current_setting('test.project_a')::jsonb->>'result', 'created', 'creation succeeds');
select is(current_setting('test.project_a')::jsonb->>'name', '봄 카디건', 'name is normalized');
select is(current_setting('test.project_a')::jsonb->>'notes', '메모', 'notes are normalized');
select is((select count(*) from public.project_parts), 1::bigint, 'one default part created');
select is((select count(*) from public.project_parts where is_default), 1::bigint, 'part is marked default');
select is((select count(*) from public.counters where work_item_id = (current_setting('test.project_a')::jsonb->>'workItemId')::uuid), 2::bigint, 'both counter types created');
select is((select revision from public.work_items where id = (current_setting('test.project_a')::jsonb->>'workItemId')::uuid), 0::bigint, 'new counter revision zero');
select is(public.apply_counter_command('abababab-abab-4aba-8aba-abababababab', (current_setting('test.project_a')::jsonb->>'workItemId')::uuid, 0, now(), 'project-test', '{"type":"change","counter":"stitch","delta":1}'::jsonb)->>'status', 'applied', 'default part uses existing counter command RPC');
select is((select current_value from public.counters where work_item_id = (current_setting('test.project_a')::jsonb->>'workItemId')::uuid and counter_type = 'stitch'), 1::bigint, 'counter command updates default part');
select is(public.create_project('11111111-1111-4111-8111-111111111111', '봄 카디건', '메모')->>'result', 'duplicate', 'same request returns existing project');
select is((select count(*) from public.projects), 1::bigint, 'duplicate creates no extra project');
select throws_ok($$select public.create_project('11111111-1111-4111-8111-111111111111', '다른 이름', '메모')$$, '22023', null, 'same request ID cannot change payload');
select throws_ok($$select public.create_project('22222222-2222-4222-8222-222222222222', '  ', null)$$, '22023', null, 'blank name rejected');
select is((select count(*) from public.work_items), 1::bigint, 'invalid creation leaves no counter work item');
select set_config('test.project_updated', public.update_project((current_setting('test.project_a')::jsonb->>'id')::uuid, 0, '새 이름', '새 메모', 'paused')::text, true);
select is(current_setting('test.project_updated')::jsonb->>'status', 'paused', 'status changes');
select is((current_setting('test.project_updated')::jsonb->>'revision')::bigint, 1::bigint, 'project revision increments');
select throws_ok(format('select public.update_project(%L::uuid,0,%L,%L,%L)', current_setting('test.project_a')::jsonb->>'id', '옛 이름', '메모', 'active'), '40001', null, 'stale update rejected');

set local request.jwt.claim.sub = '34343434-3434-4343-8343-343434343434';
select is((select count(*) from public.projects), 0::bigint, 'other account cannot list project');
select is((select count(*) from public.project_parts), 0::bigint, 'other account cannot list part');
select throws_ok(format('select public.update_project(%L::uuid,1,%L,%L,%L)', current_setting('test.project_a')::jsonb->>'id', '탈취', '', 'active'), 'P0002', null, 'other account cannot edit project');
select set_config('test.project_b', public.create_project('11111111-1111-4111-8111-111111111111', '내 작업', null)::text, true);
select isnt(current_setting('test.project_b')::jsonb->>'id', current_setting('test.project_a')::jsonb->>'id', 'request IDs scoped by user');
select set_config('test.unused_work_b', public.create_counter_work_item()->'state'->>'workItemId', true);
set local role postgres;
select throws_ok(format(
  'insert into public.project_parts(project_id,user_id,work_item_id,name,is_default) values (%L::uuid,%L::uuid,%L::uuid,%L,false)',
  current_setting('test.project_a')::jsonb->>'id', '12121212-1212-4121-8121-121212121212',
  current_setting('test.unused_work_b'), '잘못된 연결'
), '23503', null, 'part cannot link another owner work item');
select throws_ok(format(
  'insert into public.project_parts(project_id,user_id,work_item_id,name,is_default) values (%L::uuid,%L::uuid,%L::uuid,%L,false)',
  current_setting('test.project_a')::jsonb->>'id', '34343434-3434-4343-8343-343434343434',
  current_setting('test.unused_work_b'), '잘못된 연결'
), '23503', null, 'part owner must match project owner');
set local role authenticated;


set local request.jwt.claim.sub = '12121212-1212-4121-8121-121212121212';
select is(public.delete_project((current_setting('test.project_a')::jsonb->>'id')::uuid, 1)->>'result', 'deleted', 'delete marks project');
select is((select count(*) from public.projects where deleted_at is null), 0::bigint, 'deleted project hidden from normal list query');
set local role postgres;
select is((select count(*) from public.counters where work_item_id = (current_setting('test.project_a')::jsonb->>'workItemId')::uuid), 2::bigint, 'soft delete retains counters');
select is((select count(*) from public.counter_events where work_item_id = (current_setting('test.project_a')::jsonb->>'workItemId')::uuid), 1::bigint, 'soft delete retains counter history');
set local role authenticated;
select is(public.delete_project((current_setting('test.project_a')::jsonb->>'id')::uuid, 1)->>'result', 'duplicate', 'delete retry is idempotent');
select * from finish();
rollback;
