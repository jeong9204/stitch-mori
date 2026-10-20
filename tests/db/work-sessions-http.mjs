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
  const client=await auth(), uid=(await client.auth.getUser()).data.user.id;
  const ts=await import('typescript');
  const js=ts.default.transpileModule(readFileSync('src/data/timer/server-timer-store.ts','utf8'),{compilerOptions:{target:ts.default.ScriptTarget.ES2022,module:ts.default.ModuleKind.ESNext}}).outputText;
  const {SupabaseTimerStore}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const remote=new SupabaseTimerStore(client,uid);
  const work=(await rpc(client,'create_counter_work_item')).state.workItemId;
  const sessionId=randomUUID();
  const command=(action,revision)=>({commandId:randomUUID(),sessionId,workItemId:work,expectedRevision:revision,occurredAt:'2000-01-01T00:00:00.000Z',deviceId:'http-timer',action});
  assert.equal((await remote.load()).state,null);
  const start=command('start',0);
  const [a,b]=await Promise.all([remote.apply(start),remote.apply(start)]);
  assert.deepEqual([a.status,b.status].sort(),['applied','duplicate']);
  assert.equal(a.state.sessionId,sessionId);assert.ok(Date.parse(a.state.startedAt)>Date.parse(start.occurredAt));
  assert.equal((await remote.apply(command('pause',0))).status,'conflict');
  assert.equal((await remote.apply(command('pause',1))).status,'applied');
  const snap=await remote.load();assert.equal(snap.state.status,'paused');assert.equal(snap.events.length,2);
  assert.equal((await remote.apply(command('resume',2))).status,'applied');
  assert.equal((await remote.apply(command('end',3))).status,'applied');
  assert.equal((await remote.load()).state,null);
  const ended=await remote.load(sessionId);assert.equal(ended.state.status,'ended');assert.equal(ended.events.length,4);
  assert.equal((await remote.apply(start)).status,'duplicate'); // lost acknowledgement retry
  assert.equal((await remote.load(sessionId)).state.revision,4);
  const other=await auth();assert.equal((await other.from('work_sessions').select('id')).data.length,0);
  assert.equal((await other.rpc('get_work_session',{p_session_id:sessionId})).error.code,'P0002');
  assert.ok((await client.from('work_sessions').update({accumulated_ms:1}).eq('id',sessionId)).error);
  assert.ok((await client.from('work_session_events').delete().eq('session_id',sessionId)).error);
  const anon=createClient(url,key,{auth:{persistSession:false}});
  assert.ok((await anon.rpc('get_work_session',{p_session_id:sessionId})).error);
  console.log('PASS timer HTTP: real authenticated adapter, duplicate RPC, revision conflict, start/pause/resume/end, restore, lost-ack retry, RLS and direct-write denial');
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
