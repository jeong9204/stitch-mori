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
async function auth(){const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});const email=`timer-http-${randomUUID()}@example.test`;const sent=await client.auth.signInWithOtp({email});assert.ifError(sent.error);let token;
  for(let i=0;i<20&&!token;i++){const mails=await(await fetch('http://127.0.0.1:54324/api/v1/messages')).json();token=mails.messages.find(m=>m.To.some(t=>t.Address===email))?.Snippet.match(/\b\d{6}\b/)?.[0];if(!token)await new Promise(r=>setTimeout(r,250));}
  assert.ok(token);const verified=await client.auth.verifyOtp({email,token,type:'email'});assert.ifError(verified.error);users.push(verified.data.user.id);return client;}
async function rpc(client,name,args){const result=await client.rpc(name,args);assert.ifError(result.error);return result.data;}
try {
  const client=await auth();
  const project=await rpc(client,'create_project',{p_request_id:randomUUID(),p_name:'HTTP adjustment',p_notes:null});
  const detail=await rpc(client,'get_project_detail',{p_project_id:project.id}),work=detail.parts[0].workItemId,session=randomUUID();
  const timer=(action,revision,sid=session)=>rpc(client,'apply_work_session_command',{p_command_id:randomUUID(),p_session_id:sid,p_work_item_id:work,p_expected_revision:revision,p_occurred_at:new Date().toISOString(),p_device_id:'adjustment-http',p_action:action});
  await timer('start',0);await new Promise(resolve=>setTimeout(resolve,20));await timer('pause',1);await timer('resume',2);await timer('end',3);
  const original=await rpc(client,'get_work_session',{p_session_id:session});
  const correction=(revision,value,request=randomUUID())=>({p_request_id:request,p_session_id:session,p_expected_revision:revision,p_adjusted_ms:value,p_reason:'HTTP audit'});
  const first=correction(0,1000000),same=await Promise.all([rpc(client,'adjust_work_session_time',first),rpc(client,'adjust_work_session_time',first)]);
  assert.deepEqual(same.map(r=>r.status).sort(),['applied','duplicate']);assert.equal(same[0].adjustment.adjustmentId,same[1].adjustment.adjustmentId);
  const after=await rpc(client,'get_work_session',{p_session_id:session});assert.deepEqual(after.state,original.state);assert.deepEqual(after.events,original.events);
  const stats=await rpc(client,'get_work_time_statistics',{p_work_item_id:work});assert.equal(stats.works[0].savedMs,1000000);assert.equal(stats.works[0].todaySavedMs,1000000);assert.equal(stats.recent[0].effectiveMs,1000000);assert.equal(stats.recent[0].accumulatedMs,original.state.accumulatedMs);
  const competing=await Promise.all([rpc(client,'adjust_work_session_time',correction(1,2000000)),rpc(client,'adjust_work_session_time',correction(1,3000000))]);assert.deepEqual(competing.map(r=>r.status).sort(),['applied','conflict']);
  const lost=correction(2,4000000);await rpc(client,'adjust_work_session_time',lost);const retried=await rpc(client,'adjust_work_session_time',lost);assert.equal(retried.status,'duplicate');
  assert.equal((await rpc(client,'get_work_time_adjustments',{p_session_id:session})).adjustments.length,3);
  assert.ok((await client.rpc('adjust_work_session_time',{...lost,p_adjusted_ms:1})).error);
  for(const value of [-1,0.5,9007199254740992])assert.ok((await client.rpc('adjust_work_session_time',correction(3,value))).error);
  assert.equal((await rpc(client,'adjust_work_session_time',correction(3,0))).status,'applied');
  assert.equal((await rpc(client,'get_work_time_statistics',{p_work_item_id:work})).works[0].savedMs,0);
  const next=randomUUID();await timer('start',0,next);
  assert.equal((await rpc(client,'adjust_work_session_time',{...correction(0,1),p_session_id:next})).reason,'session_not_ended');await timer('pause',1,next);
  assert.equal((await rpc(client,'adjust_work_session_time',{...correction(0,1),p_session_id:next})).reason,'session_not_ended');await timer('end',2,next);
  const other=await auth(),otherWork=(await rpc(other,'create_counter_work_item')).state.workItemId,otherSession=randomUUID();
  for(const [action,revision] of [['start',0],['end',1]])await rpc(other,'apply_work_session_command',{p_command_id:randomUUID(),p_session_id:otherSession,p_work_item_id:otherWork,p_expected_revision:revision,p_occurred_at:new Date().toISOString(),p_device_id:'http',p_action:action});
  assert.ok((await other.rpc('get_work_time_adjustments',{p_session_id:session})).error);
  assert.ok((await other.rpc('adjust_work_session_time',correction(4,1))).error);
  assert.equal((await rpc(other,'adjust_work_session_time',{...first,p_session_id:otherSession})).status,'applied');
  assert.equal((await other.from('work_session_time_adjustments').select('id')).data.length,1);
  assert.ok((await client.from('work_session_time_adjustments').update({adjusted_ms:1}).eq('session_id',session)).error);
  assert.equal((await rpc(client,'delete_project',{p_project_id:project.id,p_expected_revision:0})).result,'deleted');
  assert.equal((await rpc(client,'get_work_time_adjustments',{p_session_id:session})).canAdjust,false);
  assert.ok((await client.rpc('adjust_work_session_time',correction(4,1))).error);
  assert.equal((await rpc(client,'adjust_work_session_time',first)).status,'duplicate');
  assert.equal((await rpc(client,'restore_project',{p_project_id:project.id,p_request_id:randomUUID(),p_expected_revision:1})).status,'restored');
  assert.equal((await rpc(client,'adjust_work_session_time',correction(4,1000))).status,'applied');
  const anon=createClient(url,key,{auth:{persistSession:false}});assert.ok((await anon.rpc('get_work_time_adjustments',{p_session_id:session})).error);
  console.log('PASS adjustments HTTP: same-ID concurrency, competing revisions, lost-response retry, original preservation, stats, zero/invalid inputs, state guards, ownership, delete/restore');
}finally{
  if(users.length){const ids=users.map(id=>`'${id}'`).join(',');await sql(`begin;
    set constraints all deferred;
    alter table public.work_session_time_adjustments disable trigger work_session_adjustments_append_only;
    delete from public.work_session_time_adjustments where user_id in (${ids});
    alter table public.work_session_time_adjustments enable trigger work_session_adjustments_append_only;
    alter table public.work_session_events disable trigger work_session_events_append_only;
    delete from public.work_session_events where user_id in (${ids});
    delete from public.work_sessions where user_id in (${ids});
    set constraints all immediate;
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
