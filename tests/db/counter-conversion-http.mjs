import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
const env=Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(line=>line.includes('=')&&!line.startsWith('#')).map(line=>{const i=line.indexOf('=');return[line.slice(0,i).trim(),line.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
const url=env.NEXT_PUBLIC_SUPABASE_URL,key=env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(url),'local Supabase only');
const users=[];
function sql(query){return new Promise((resolve,reject)=>{const child=spawn('docker',['exec','-i','supabase_db_stitch-mori','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],{stdio:['pipe','pipe','pipe']});let err='';child.stdout.resume();child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(err)));child.stdin.end(query);});}
async function auth(){const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});const email=`conversion-http-${randomUUID()}@example.test`;const sent=await client.auth.signInWithOtp({email});assert.ifError(sent.error);let token;
  for(let i=0;i<20&&!token;i++){const mails=await(await fetch('http://127.0.0.1:54324/api/v1/messages')).json();token=mails.messages.find(m=>m.To.some(t=>t.Address===email))?.Snippet.match(/\b\d{6}\b/)?.[0];if(!token)await new Promise(r=>setTimeout(r,250));}
  assert.ok(token);const verified=await client.auth.verifyOtp({email,token,type:'email'});assert.ifError(verified.error);users.push(verified.data.user.id);return client;}
async function rpc(client,name,args){const result=await client.rpc(name,args);assert.ifError(result.error);return result.data;}
try{
  const client=await auth();const source=(await rpc(client,'create_counter_work_item')).state.workItemId;
  let revision=0,last;
  for(const action of [{type:'setValue',counter:'stitch',value:7},{type:'setTarget',counter:'stitch',value:5},{type:'completeRow',stitch:'reset'}]){last=await rpc(client,'apply_counter_command',{p_command_id:randomUUID(),p_work_item_id:source,p_expected_revision:revision++,p_occurred_at:new Date().toISOString(),p_device_id:'conversion-http',p_action:action});assert.equal(last.status,'applied');}
  await rpc(client,'apply_counter_command',{p_command_id:randomUUID(),p_work_item_id:source,p_expected_revision:revision++,p_occurred_at:new Date().toISOString(),p_device_id:'conversion-http',p_action:{type:'undo',eventId:last.eventId}});
  const beforeCounters=(await client.from('counters').select('*').eq('work_item_id',source).order('counter_type')).data;
  const beforeEvents=(await client.from('counter_events').select('*').eq('work_item_id',source).order('revision_after')).data;
  const ids=[randomUUID(),randomUUID()];const calls=await Promise.all(ids.map(id=>client.rpc('convert_counter_to_project',{p_work_item_id:source,p_request_id:id,p_expected_revision:revision,p_name:'HTTP 계정 전환'})));
  assert.equal(calls.filter(r=>!r.error).length,1);assert.equal(calls.filter(r=>r.error?.code==='22023').length,1);
  const winner=calls.findIndex(r=>!r.error);const converted=calls[winner].data;assert.equal(converted.workItemId,source);
  const duplicate=await rpc(client,'convert_counter_to_project',{p_work_item_id:source,p_request_id:ids[winner],p_expected_revision:revision,p_name:'HTTP 계정 전환'});assert.equal(duplicate.status,'duplicate');assert.equal(duplicate.projectId,converted.projectId);
  assert.deepEqual((await client.from('counters').select('*').eq('work_item_id',source).order('counter_type')).data,beforeCounters);
  assert.deepEqual((await client.from('counter_events').select('*').eq('work_item_id',source).order('revision_after')).data,beforeEvents);
  assert.equal((await rpc(client,'list_account_counters')).length,0);
  console.log('PASS account HTTP: concurrent requests, idempotent retry, exact counter/event/undo preservation, standalone list exclusion');
  const localId=randomUUID(),importId=randomUUID();let state={workItemId:localId,revision:0,stitch:{current:0,target:null},row:{current:0,target:null}};const events=[];
  const actions=[{type:'setValue',counter:'stitch',value:9},{type:'setTarget',counter:'stitch',value:8},{type:'completeRow',stitch:'reset'}];
  for(let i=0;i<4;i++){const action=i<3?actions[i]:{type:'undo',eventId:events[2].eventId};const before=structuredClone(state);state=structuredClone(state);state.revision++;
    if(i===0)state.stitch.current=9;if(i===1)state.stitch.target=8;if(i===2){state.stitch.current=0;state.row.current=1;}if(i===3){state.stitch.current=9;state.row.current=0;}
    const id=randomUUID();events.push({eventId:id,commandId:id,workItemId:localId,occurredAt:`2026-10-20T02:00:0${i}.000Z`,deviceId:'http-local-source',action,before,after:structuredClone(state)});}
  const payload={importId,localWorkItemId:localId,state,events};const imported=await rpc(client,'import_counter_snapshot',{p_payload:payload});
  const req=randomUUID();const invalid=await client.rpc('convert_counter_to_project',{p_work_item_id:imported.serverWorkItemId,p_request_id:req,p_expected_revision:4,p_name:' '});assert.equal(invalid.error.code,'22023');
  const importedAgain=await rpc(client,'import_counter_snapshot',{p_payload:payload});assert.equal(importedAgain.status,'duplicate');assert.equal(importedAgain.serverWorkItemId,imported.serverWorkItemId);
  const args={p_work_item_id:imported.serverWorkItemId,p_request_id:req,p_expected_revision:4,p_name:'HTTP 로컬 전환'};const conversions=await Promise.all([rpc(client,'convert_counter_to_project',args),rpc(client,'convert_counter_to_project',args)]);assert.deepEqual(conversions.map(r=>r.status).sort(),['converted','duplicate']);assert.equal(conversions[0].projectId,conversions[1].projectId);
  const importedCounters=(await client.from('counters').select('*').eq('work_item_id',imported.serverWorkItemId)).data;
  assert.equal(importedCounters.find(c=>c.counter_type==='stitch').current_value,9);assert.equal(importedCounters.find(c=>c.counter_type==='stitch').target_value,8);
  const importedEvents=(await client.from('counter_events').select('*').eq('work_item_id',imported.serverWorkItemId).order('revision_after')).data;assert.equal(importedEvents.length,4);assert.equal(importedEvents[3].undo_of_event_id,importedEvents[2].id);assert.equal(importedEvents[3].occurred_at,'2026-10-20T02:00:03+00:00');
  console.log('PASS local HTTP: import success followed by conversion failure, same receipt/work item reused, concurrent same-ID conversion, goal/undo/time preserved');
  const other=await auth();const denied=await other.rpc('convert_counter_to_project',{p_work_item_id:source,p_request_id:randomUUID(),p_expected_revision:4,p_name:'denied'});assert.equal(denied.error.code,'P0002');assert.equal(await rpc(other,'get_counter_project_link',{p_work_item_id:source}),null);
  const anon=createClient(url,key,{auth:{persistSession:false}});assert.ok((await anon.rpc('convert_counter_to_project',args)).error);console.log('PASS security HTTP: other account and anonymous conversion denied');
}finally{
  if(users.length){const ids=users.map(id=>`'${id}'`).join(',');await sql(`begin;
    delete from public.counter_project_conversions where user_id in (${ids});
    delete from public.project_recovery_commands where user_id in (${ids});
    delete from public.project_part_commands where user_id in (${ids});
    delete from public.counter_imports where user_id in (${ids});
    alter table public.counter_events disable trigger counter_events_append_only;
    delete from public.counter_events where work_item_id in(select id from public.work_items where user_id in (${ids}));
    alter table public.counter_events enable trigger counter_events_append_only;
    delete from public.project_parts where user_id in (${ids});delete from public.projects where user_id in (${ids});
    delete from public.counters where work_item_id in(select id from public.work_items where user_id in (${ids}));
    delete from public.work_items where user_id in (${ids});delete from auth.users where id in (${ids});commit;`);}
}
