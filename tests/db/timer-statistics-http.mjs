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
  const client=await auth(),uid=(await client.auth.getUser()).data.user.id;
  const work=(await rpc(client,'create_counter_work_item')).state.workItemId,session=randomUUID(),startId=randomUUID();
  const started=new Date(Date.now()-31*60000).toISOString();
  await sql(`begin;insert into public.work_sessions(id,user_id,work_item_id,status,started_at,accumulated_ms,last_resumed_at,last_transition_at,revision,last_command_id,created_at,updated_at)
    values('${session}','${uid}','${work}','running','${started}',0,'${started}','${started}',1,'${startId}','${started}','${started}');
    insert into public.work_session_events(user_id,command_id,session_id,work_item_id,revision_after,event_type,occurred_at,effective_at,device_id,command,after_state,result)
    values('${uid}','${startId}','${session}','${work}',1,'start','${started}','${started}','http-fixture','{}','{}','{}');commit;`);
  const context=await rpc(client,'get_work_inactivity',{p_session_id:session});
  const args={p_session_id:session,p_baseline:context.baseline,p_choice:'show'};
  const result=await Promise.all([rpc(client,'ack_work_inactivity',args),rpc(client,'ack_work_inactivity',args)]);
  assert.deepEqual(result.map(r=>r.status).sort(),['applied','skipped']);
  assert.equal((await rpc(client,'get_work_inactivity',{p_session_id:session})).session.status,'running');
  assert.equal((await rpc(client,'ack_work_inactivity',{...args,p_choice:'pause'})).status,'applied');
  assert.equal((await rpc(client,'ack_work_inactivity',args)).status,'skipped');
  const receipt=await rpc(client,'ack_work_inactivity',{...args,p_choice:'pause'});assert.equal(receipt.status,'duplicate');assert.equal(receipt.choice,'pause');
  const stats=await rpc(client,'get_work_time_statistics',{p_work_item_id:work});
  assert.equal(stats.zone,'Asia/Seoul');assert.equal(stats.works[0].savedMs,0);assert.ok(stats.works[0].liveMs>=31*60000);assert.equal(stats.recent.length,0);
  assert.ok((await client.from('work_session_activity').update({shown:false}).eq('session_id',session)).error);
  const other=await auth();
  assert.equal((await rpc(other,'get_work_time_statistics')).works.length,0);
  assert.ok((await other.rpc('get_work_inactivity',{p_session_id:session})).error);
  assert.ok((await other.rpc('ack_work_inactivity',args)).error);
  const pause={p_command_id:randomUUID(),p_session_id:session,p_work_item_id:work,p_expected_revision:1,p_occurred_at:new Date().toISOString(),p_device_id:'http',p_action:'pause'};
  assert.equal((await rpc(client,'apply_work_session_command',pause)).status,'applied');
  const paused=await rpc(client,'get_work_time_statistics',{p_work_item_id:work});assert.ok(paused.works[0].savedMs>=31*60000);assert.equal(paused.works[0].liveMs,0);
  assert.equal((await rpc(client,'ack_work_inactivity',args)).status,'stale');
  assert.equal((await rpc(client,'apply_work_session_command',{...pause,p_command_id:randomUUID(),p_expected_revision:2,p_action:'end'})).status,'applied');
  const ended=await rpc(client,'get_work_time_statistics',{p_work_item_id:work});assert.equal(ended.recent.length,1);assert.equal(ended.works[0].savedMs,paused.works[0].savedMs);
  console.log('PASS Phase 3C HTTP: concurrent inactivity claim, durable choice/lost-response retry, actual stats, pause/end, ownership and direct-write denial');
}finally{
  if(users.length){const ids=users.map(id=>`'${id}'`).join(',');await sql(`begin;
    set constraints all deferred;
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
