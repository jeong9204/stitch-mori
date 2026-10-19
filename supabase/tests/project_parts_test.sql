begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users(id,email) values
 ('71717171-7171-4171-8171-717171717171','parts-a@example.test'),
 ('72727272-7272-4272-8272-727272727272','parts-b@example.test');
select ok(has_function_privilege('authenticated','public.apply_project_part_command(uuid,uuid,bigint,jsonb)','EXECUTE'),'owner can use part RPC');
select ok(not has_function_privilege('anon','public.apply_project_part_command(uuid,uuid,bigint,jsonb)','EXECUTE'),'anon cannot use part RPC');
select ok(not has_table_privilege('authenticated','public.project_part_commands','SELECT'),'receipts not directly readable');
select ok(not has_table_privilege('authenticated','public.project_parts','UPDATE'),'parts not directly writable');
select ok(not has_function_privilege('authenticated','private.apply_counter_command_internal(uuid,uuid,bigint,timestamptz,text,jsonb)','EXECUTE'),'internal counter RPC cannot bypass status gate');

set local role authenticated;
set local request.jwt.claim.sub = '71717171-7171-4171-8171-717171717171';
select set_config('test.project_a',public.create_project('71717171-0000-4000-8000-000000000001','가디건',null)::text,true);
select is((select count(*) from public.project_parts where project_id=(current_setting('test.project_a')::jsonb->>'id')::uuid),1::bigint,'old default part survives migration');
select is((public.get_project_detail((current_setting('test.project_a')::jsonb->>'id')::uuid)->'parts'->0->>'name'),'기본 파트','detail includes old default part');
select is((public.get_project_detail((current_setting('test.project_a')::jsonb->>'id')::uuid)->'parts'->0->>'position')::bigint,0::bigint,'default part starts at position zero');
select set_config('test.create_a',public.apply_project_part_command((current_setting('test.project_a')::jsonb->>'id')::uuid,'71717171-0000-4000-8000-000000000011',0,'{"type":"create","name":"소매"}'::jsonb)::text,true);
select is(current_setting('test.create_a')::jsonb->>'status','applied','part creation succeeds');
select is((select count(*) from public.counters where work_item_id=(current_setting('test.create_a')::jsonb->>'workItemId')::uuid),2::bigint,'part creates independent counter pair');
select is((select sum(current_value) from public.counters where work_item_id=(current_setting('test.create_a')::jsonb->>'workItemId')::uuid),0::numeric,'new part counters start at zero');
select is(public.apply_project_part_command((current_setting('test.project_a')::jsonb->>'id')::uuid,'71717171-0000-4000-8000-000000000011',0,'{"type":"create","name":"소매"}'::jsonb)->>'status','duplicate','retry returns receipt');
select is((select count(*) from public.project_parts where project_id=(current_setting('test.project_a')::jsonb->>'id')::uuid),2::bigint,'retry did not add a part');
select throws_ok(format('select public.apply_project_part_command(%L::uuid,%L::uuid,0,%L::jsonb)',current_setting('test.project_a')::jsonb->>'id','71717171-0000-4000-8000-000000000011','{"type":"create","name":"다른 이름"}'),'22023',null,'request ID cannot change payload');
select is(public.apply_project_part_command((current_setting('test.project_a')::jsonb->>'id')::uuid,'71717171-0000-4000-8000-000000000012',0,'{"type":"create","name":"늦은 요청"}'::jsonb)->>'status','conflict','stale project revision conflicts');
select set_config('test.create_b',public.apply_project_part_command((current_setting('test.project_a')::jsonb->>'id')::uuid,'71717171-0000-4000-8000-000000000013',1,'{"type":"create","name":"소매"}'::jsonb)::text,true);
select is(current_setting('test.create_b')::jsonb->>'status','applied','duplicate part names are allowed');
select isnt(current_setting('test.create_a')::jsonb->>'workItemId',current_setting('test.create_b')::jsonb->>'workItemId','same-named parts have separate work items');
select is((public.get_project_detail((current_setting('test.project_a')::jsonb->>'id')::uuid)->'parts'->2->>'id'),current_setting('test.create_b')::jsonb->>'partId','part order is persisted');
select is(public.apply_project_part_command((current_setting('test.project_a')::jsonb->>'id')::uuid,'71717171-0000-4000-8000-000000000014',2,jsonb_build_object('type','move','partId',current_setting('test.create_b')::jsonb->>'partId','direction','up'))->>'status','applied','move up succeeds');
select is((public.get_project_detail((current_setting('test.project_a')::jsonb->>'id')::uuid)->'parts'->1->>'id'),current_setting('test.create_b')::jsonb->>'partId','move order visible after reload');
select is(public.apply_project_part_command((current_setting('test.project_a')::jsonb->>'id')::uuid,'71717171-0000-4000-8000-000000000014',2,jsonb_build_object('type','move','partId',current_setting('test.create_b')::jsonb->>'partId','direction','up'))->>'status','duplicate','move retry does not move twice');
select is(public.apply_project_part_command((current_setting('test.project_a')::jsonb->>'id')::uuid,'71717171-0000-4000-8000-000000000015',3,jsonb_build_object('type','rename','partId',current_setting('test.project_a')::jsonb->>'defaultPartId','name','몸판'))->>'status','applied','default part can be renamed');
select is((public.get_project_detail((current_setting('test.project_a')::jsonb->>'id')::uuid)->'parts'->0->>'name'),'몸판','renamed default appears in detail');
select throws_ok(format('select public.apply_project_part_command(%L::uuid,%L::uuid,4,%L::jsonb)',current_setting('test.project_a')::jsonb->>'id','71717171-0000-4000-8000-000000000016',jsonb_build_object('type','rename','partId',current_setting('test.create_a')::jsonb->>'partId','name','  ')::text),'22023',null,'blank part name rejected');
select throws_ok(format('select public.apply_project_part_command(%L::uuid,%L::uuid,4,%L::jsonb)',current_setting('test.project_a')::jsonb->>'id','71717171-0000-4000-8000-000000000017',jsonb_build_object('type','delete','partId',current_setting('test.project_a')::jsonb->>'defaultPartId')::text),'22023',null,'default part cannot be deleted');
select is(public.apply_project_part_command((current_setting('test.project_a')::jsonb->>'id')::uuid,'71717171-0000-4000-8000-000000000018',4,jsonb_build_object('type','move','partId',current_setting('test.project_a')::jsonb->>'defaultPartId','direction','up'))->>'status','unchanged','boundary move is unchanged');
select is(public.apply_project_part_command((current_setting('test.project_a')::jsonb->>'id')::uuid,'71717171-0000-4000-8000-000000000018',4,jsonb_build_object('type','move','partId',current_setting('test.project_a')::jsonb->>'defaultPartId','direction','up'))->>'status','duplicate','boundary retry is idempotent');
select set_config('test.project_same_owner',public.create_project('71717171-0000-4000-8000-000000000019','다른 프로젝트',null)::text,true);
select throws_ok(format('select public.apply_project_part_command(%L::uuid,%L::uuid,0,%L::jsonb)',current_setting('test.project_same_owner')::jsonb->>'id','71717171-0000-4000-8000-000000000020',jsonb_build_object('type','rename','partId',current_setting('test.create_a')::jsonb->>'partId','name','침범')::text),'P0002',null,'part cannot be edited through another same-owner project');
select is((select count(*) from public.project_parts where project_id=(current_setting('test.project_same_owner')::jsonb->>'id')::uuid),1::bigint,'other project default remains independent');
select is(public.apply_counter_command('71717171-0000-4000-8000-000000000041',(current_setting('test.project_same_owner')::jsonb->>'workItemId')::uuid,0,now(),'parts-test','{"type":"setTarget","counter":"stitch","value":20}'::jsonb)->>'status','applied','goal can be set on separate project');
select ok((public.get_project_detail((current_setting('test.project_same_owner')::jsonb->>'id')::uuid)->'parts'->0->>'lastCountAt') is null,'target-only event does not mark a part as last counted');



select is(public.apply_counter_command('71717171-0000-4000-8000-000000000021',(current_setting('test.create_a')::jsonb->>'workItemId')::uuid,0,now(),'parts-test','{"type":"change","counter":"stitch","delta":1}'::jsonb)->>'status','applied','part A counter increments through existing RPC');
select is(public.apply_counter_command('71717171-0000-4000-8000-000000000022',(current_setting('test.create_b')::jsonb->>'workItemId')::uuid,0,now(),'parts-test','{"type":"completeRow","stitch":"reset"}'::jsonb)->>'status','applied','part B row completion uses existing RPC');
select is((select current_value from public.counters where work_item_id=(current_setting('test.create_a')::jsonb->>'workItemId')::uuid and counter_type='stitch'),1::bigint,'part A stitch count isolated');
select is((select current_value from public.counters where work_item_id=(current_setting('test.create_b')::jsonb->>'workItemId')::uuid and counter_type='stitch'),0::bigint,'part B stitch count isolated');
select is((select current_value from public.counters where work_item_id=(current_setting('test.create_b')::jsonb->>'workItemId')::uuid and counter_type='row'),1::bigint,'part B row count isolated');
select ok((public.get_project_detail((current_setting('test.project_a')::jsonb->>'id')::uuid)->'parts'->2->>'lastCountAt') is not null,'last event time is returned');
select is((public.get_project_detail((current_setting('test.project_a')::jsonb->>'id')::uuid)->'parts'->2->>'lastCountAt')::timestamptz,
  (select occurred_at from public.counter_events where work_item_id=(current_setting('test.create_a')::jsonb->>'workItemId')::uuid order by revision_after desc limit 1),
  'detail last count time matches command occurrence time');

select set_config('test.event_b',(select id::text from public.counter_events where work_item_id=(current_setting('test.create_b')::jsonb->>'workItemId')::uuid limit 1),true);
select is(public.apply_counter_command('71717171-0000-4000-8000-000000000023',(current_setting('test.create_b')::jsonb->>'workItemId')::uuid,1,now(),'parts-test',jsonb_build_object('type','undo','eventId',current_setting('test.event_b')))->>'status','applied','part B undo works');
select is((select current_value from public.counters where work_item_id=(current_setting('test.create_b')::jsonb->>'workItemId')::uuid and counter_type='row'),0::bigint,'undo restores part B row');

set local request.jwt.claim.sub = '72727272-7272-4272-8272-727272727272';
select is((select count(*) from public.project_parts),0::bigint,'other user cannot list parts');
select ok(public.get_project_detail((current_setting('test.project_a')::jsonb->>'id')::uuid) is null,'other user cannot read detail');
select throws_ok(format('select public.apply_project_part_command(%L::uuid,%L::uuid,4,%L::jsonb)',current_setting('test.project_a')::jsonb->>'id','72727272-0000-4000-8000-000000000001',jsonb_build_object('type','rename','partId',current_setting('test.create_a')::jsonb->>'partId','name','탈취')::text),'P0002',null,'other user cannot rename part');
select is(public.apply_counter_command('72727272-0000-4000-8000-000000000002',(current_setting('test.create_a')::jsonb->>'workItemId')::uuid,1,now(),'parts-test','{"type":"change","counter":"stitch","delta":1}'::jsonb)->>'status','rejected','other user cannot count part');

set local request.jwt.claim.sub = '71717171-7171-4171-8171-717171717171';
select is(public.apply_project_part_command((current_setting('test.project_a')::jsonb->>'id')::uuid,'71717171-0000-4000-8000-000000000031',4,jsonb_build_object('type','delete','partId',current_setting('test.create_a')::jsonb->>'partId'))->>'status','applied','nondefault part soft-deleted');
select is((select count(*) from public.project_parts where id=(current_setting('test.create_a')::jsonb->>'partId')::uuid),0::bigint,'soft-deleted part hidden by RLS');
select is((select count(*) from public.work_items where id=(current_setting('test.create_a')::jsonb->>'workItemId')::uuid),0::bigint,'deleted part work item hidden by RLS');
select is((select count(*) from public.counter_events where work_item_id=(current_setting('test.create_a')::jsonb->>'workItemId')::uuid),0::bigint,'deleted part events hidden by RLS');
select is(public.apply_counter_command('71717171-0000-4000-8000-000000000032',(current_setting('test.create_a')::jsonb->>'workItemId')::uuid,1,now(),'parts-test','{"type":"change","counter":"stitch","delta":1}'::jsonb)->>'status','rejected','deleted part cannot receive new count');
set local role postgres;
select is((select count(*) from public.counter_events where work_item_id=(current_setting('test.create_a')::jsonb->>'workItemId')::uuid),1::bigint,'deleted part event preserved physically');
set local role authenticated;
select set_config('test.rev',(select revision::text from public.projects where id=(current_setting('test.project_a')::jsonb->>'id')::uuid),true);
select is(public.update_project((current_setting('test.project_a')::jsonb->>'id')::uuid,current_setting('test.rev')::bigint,'가디건',null,'paused')->>'status','paused','project can be paused');
select is(public.apply_counter_command('71717171-0000-4000-8000-000000000033',(current_setting('test.create_b')::jsonb->>'workItemId')::uuid,2,now(),'parts-test','{"type":"change","counter":"stitch","delta":1}'::jsonb)->>'status','rejected','paused project cannot count');
select is(public.apply_counter_command('71717171-0000-4000-8000-000000000022',(current_setting('test.create_b')::jsonb->>'workItemId')::uuid,0,now(),'parts-test','{"type":"completeRow","stitch":"reset"}'::jsonb)->>'status','duplicate','paused project acknowledges previously committed command');


select is(public.update_project((current_setting('test.project_a')::jsonb->>'id')::uuid,current_setting('test.rev')::bigint+1,'가디건',null,'completed')->>'status','completed','project can be completed');
select is(public.apply_counter_command('71717171-0000-4000-8000-000000000036',(current_setting('test.create_b')::jsonb->>'workItemId')::uuid,2,now(),'parts-test','{"type":"change","counter":"stitch","delta":1}'::jsonb)->>'status','rejected','completed project cannot count');
select is(public.update_project((current_setting('test.project_a')::jsonb->>'id')::uuid,current_setting('test.rev')::bigint+2,'가디건',null,'active')->>'status','active','completed project can return to active');

select is(public.apply_counter_command('71717171-0000-4000-8000-000000000034',(current_setting('test.create_b')::jsonb->>'workItemId')::uuid,2,now(),'parts-test','{"type":"change","counter":"stitch","delta":1}'::jsonb)->>'status','applied','resumed project can count');
select is(public.delete_project((current_setting('test.project_a')::jsonb->>'id')::uuid,current_setting('test.rev')::bigint+3)->>'result','deleted','project can be soft-deleted');
select is((select count(*) from public.work_items where id=(current_setting('test.create_b')::jsonb->>'workItemId')::uuid),0::bigint,'deleted project work item hidden');
select is(public.apply_counter_command('71717171-0000-4000-8000-000000000035',(current_setting('test.create_b')::jsonb->>'workItemId')::uuid,3,now(),'parts-test','{"type":"change","counter":"stitch","delta":1}'::jsonb)->>'status','rejected','deleted project cannot count');
select is(public.apply_counter_command('71717171-0000-4000-8000-000000000034',(current_setting('test.create_b')::jsonb->>'workItemId')::uuid,2,now(),'parts-test','{"type":"change","counter":"stitch","delta":1}'::jsonb)->>'status','duplicate','deleted project acknowledges previously committed command');

set local role postgres;
select is((select count(*) from public.counter_events where work_item_id=(current_setting('test.create_b')::jsonb->>'workItemId')::uuid),3::bigint,'deleted project history preserved physically');
select * from finish();
rollback;
