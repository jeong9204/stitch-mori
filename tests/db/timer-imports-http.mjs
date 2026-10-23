import {timerBundle,counterSnapshot} from './timer-import-fixture.mjs';
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
async function auth(){const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});const email=`timer-import-http-${randomUUID()}@example.test`;const sent=await client.auth.signInWithOtp({email});assert.ifError(sent.error);let token;
  for(let i=0;i<20&&!token;i++){const mails=await(await fetch('http://127.0.0.1:54324/api/v1/messages')).json();token=mails.messages.find(m=>m.To.some(t=>t.Address===email))?.Snippet.match(/\b\d{6}\b/)?.[0];if(!token)await new Promise(r=>setTimeout(r,250));}
  assert.ok(token);const verified=await client.auth.verifyOtp({email,token,type:'email'});assert.ifError(verified.error);users.push(verified.data.user.id);return client;}
async function rpc(client,name,args){const result=await client.rpc(name,args);assert.ifError(result.error);return result.data;}
try {
 const client=await auth(),counter=counterSnapshot(),bundle=timerBundle(counter.localWorkItemId),second=timerBundle(counter.localWorkItemId,10);
 const payload={importId:randomUUID(),counterImportId:counter.importId,localWorkItemId:counter.localWorkItemId,sessions:[bundle,second]};
 assert.ok((await client.rpc('import_timer_snapshot',{p_payload:payload})).error,'counter must be imported first');
 const imported=await rpc(client,'import_counter_snapshot',{p_payload:counter}),work=imported.serverWorkItemId;
 const calls=await Promise.all([rpc(client,'import_timer_snapshot',{p_payload:payload}),rpc(client,'import_timer_snapshot',{p_payload:payload})]);
 assert.deepEqual(calls.map(r=>r.status).sort(),['duplicate','imported']);
 const concurrentBatches=await Promise.all([rpc(client,'import_timer_snapshot',{p_payload:{...payload,importId:randomUUID()}}),rpc(client,'import_timer_snapshot',{p_payload:{...payload,importId:randomUUID()}})]);assert.deepEqual(concurrentBatches[0].mappings,concurrentBatches[1].mappings);assert.deepEqual(calls[0].mappings,calls[1].mappings);
 const receipt=calls[0];assert.equal(receipt.mappings.length,2);
 for(const source of payload.sessions){
  const sid=receipt.mappings.find(m=>m.localSessionId===source.state.sessionId).serverSessionId;
  const server=await rpc(client,'get_work_session',{p_session_id:sid});assert.equal(server.state.accumulatedMs,source.state.accumulatedMs);assert.equal(server.events.length,4);assert.equal(Date.parse(server.events[0].effectiveAt),Date.parse(source.events[0].effectiveAt));
  const corrections=await rpc(client,'get_work_time_adjustments',{p_session_id:sid});assert.equal(corrections.effectiveMs,5400000);assert.equal(corrections.adjustments.length,2);assert.equal(corrections.adjustments[0].reason,source.adjustments[0].reason);assert.equal(corrections.adjustments[0].sourceLocalAdjustmentId,source.adjustments[0].adjustmentId);
 }
 assert.equal((await rpc(client,'get_work_session')).state,null,'historical import never starts a timer');
 const stats=await rpc(client,'get_work_time_statistics',{p_work_item_id:work,p_day:'2026-10-23'});assert.equal(stats.works[0].savedMs,10800000);
 const lost=await rpc(client,'import_timer_snapshot',{p_payload:payload});assert.equal(lost.status,'duplicate');
 const newId=await rpc(client,'import_timer_snapshot',{p_payload:{...payload,importId:randomUUID()}});assert.deepEqual(newId.mappings,receipt.mappings);assert.equal((await rpc(client,'get_work_time_statistics',{p_work_item_id:work})).works[0].savedMs,10800000);
 const invalid=timerBundle(counter.localWorkItemId);invalid.events[2].after.accumulatedMs++;
 const third=timerBundle(counter.localWorkItemId);const failing={...payload,importId:randomUUID(),sessions:[third,invalid]};
 assert.ok((await client.rpc('import_timer_snapshot',{p_payload:failing})).error);assert.equal((await client.from('timer_import_sessions').select('local_session_id').eq('local_session_id',third.state.sessionId)).data.length,0,'batch rolls back first session');
 failing.sessions=[third];assert.equal((await rpc(client,'import_timer_snapshot',{p_payload:failing})).status,'imported');
 for(const mutate of [b=>b.state.status='paused',b=>b.events.reverse(),b=>b.adjustments[1].previousAdjustedMs=1,b=>b.events[0].command.sessionId=randomUUID(),b=>b.state.accumulatedMs=-1]){
  const b=timerBundle(counter.localWorkItemId);mutate(b);assert.ok((await client.rpc('import_timer_snapshot',{p_payload:{...payload,importId:randomUUID(),sessions:[b]}})).error);
 }
 assert.ok((await client.rpc('import_timer_snapshot',{p_payload:{...payload,sessions:[third]}})).error,'changed same ID is rejected');
 const other=await auth();assert.ok((await other.rpc('import_timer_snapshot',{p_payload:payload})).error);assert.equal((await other.from('timer_import_sessions').select('server_session_id')).data.length,0);await rpc(other,'import_counter_snapshot',{p_payload:counter});assert.equal((await other.rpc('import_timer_snapshot',{p_payload:payload})).error.code,'23505','same local session cannot be transferred to a second account');
 assert.ok((await client.from('timer_import_sessions').insert({})).error);assert.ok((await client.from('work_session_events').insert({})).error);
 const converted=await rpc(client,'convert_counter_to_project',{p_work_item_id:work,p_request_id:randomUUID(),p_expected_revision:0,p_name:'타이머 가져오기 HTTP 프로젝트'});
 const activeWork=(await rpc(client,'create_counter_work_item')).state.workItemId,activeId=randomUUID();await rpc(client,'apply_work_session_command',{p_command_id:randomUUID(),p_session_id:activeId,p_work_item_id:activeWork,p_expected_revision:0,p_occurred_at:new Date().toISOString(),p_device_id:'http',p_action:'start'});
 const extra={...payload,importId:randomUUID(),sessions:[timerBundle(counter.localWorkItemId)]};const projectImport=await rpc(client,'import_timer_snapshot',{p_payload:extra});assert.equal(projectImport.serverWorkItemId,work);assert.equal((await rpc(client,'get_work_session')).state.sessionId,activeId);await rpc(client,'apply_work_session_command',{p_command_id:randomUUID(),p_session_id:activeId,p_work_item_id:activeWork,p_expected_revision:1,p_occurred_at:new Date().toISOString(),p_device_id:'http',p_action:'end'});
 const detail=await rpc(client,'get_project_detail',{p_project_id:converted.projectId});assert.equal(detail.parts[0].workItemId,work);
 assert.equal((await rpc(client,'delete_project',{p_project_id:converted.projectId,p_expected_revision:0})).result,'deleted');
 assert.ok((await client.rpc('import_timer_snapshot',{p_payload:{...payload,importId:randomUUID(),sessions:[timerBundle(counter.localWorkItemId)]}})).error);
 assert.equal((await rpc(client,'import_timer_snapshot',{p_payload:extra})).status,'duplicate');
 const anon=createClient(url,key,{auth:{persistSession:false}});assert.ok((await anon.rpc('import_timer_snapshot',{p_payload:payload})).error);
 console.log('PASS timer import HTTP: two sessions, corrections, concurrent replay, lost acknowledgement, duplicate sources, rollback/retry, validation, owner/RLS, conversion and deletion');
}finally{
  if(users.length){const ids=users.map(id=>`'${id}'`).join(',');await sql(`begin;
    set constraints all deferred;
    alter table public.timer_import_sessions disable trigger timer_import_sessions_append_only;
    alter table public.timer_imports disable trigger timer_imports_append_only;
    delete from public.timer_import_sessions where user_id in (${ids});
    delete from public.timer_imports where user_id in (${ids});
    alter table public.work_session_time_adjustments disable trigger work_session_adjustments_append_only;
    delete from public.work_session_time_adjustments where user_id in (${ids});
    alter table public.work_session_time_adjustments enable trigger work_session_adjustments_append_only;
    alter table public.work_session_events disable trigger work_session_events_append_only;
    delete from public.work_session_events where user_id in (${ids});
    delete from public.work_sessions where user_id in (${ids});
    set constraints all immediate;
    alter table public.timer_import_sessions enable trigger timer_import_sessions_append_only;
    alter table public.timer_imports enable trigger timer_imports_append_only;
    alter table public.work_session_events enable trigger work_session_events_append_only;
    delete from public.project_gauge_commands where user_id in (${ids});
    delete from public.project_gauges where user_id in (${ids});
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
