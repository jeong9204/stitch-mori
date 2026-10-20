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
async function auth(){const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});const email=`gauge-http-${randomUUID()}@example.test`;const sent=await client.auth.signInWithOtp({email});assert.ifError(sent.error);let token;
  for(let i=0;i<20&&!token;i++){const mails=await(await fetch('http://127.0.0.1:54324/api/v1/messages')).json();token=mails.messages.find(m=>m.To.some(t=>t.Address===email))?.Snippet.match(/\b\d{6}\b/)?.[0];if(!token)await new Promise(r=>setTimeout(r,250));}
  assert.ok(token);const verified=await client.auth.verifyOtp({email,token,type:'email'});assert.ifError(verified.error);users.push(verified.data.user.id);return client;}
async function rpc(client,name,args){const result=await client.rpc(name,args);assert.ifError(result.error);return result.data;}
try {
  const client=await auth(); const project=await rpc(client,'create_project',{p_request_id:randomUUID(),p_name:'게이지 HTTP 검증'});
  const projectId=project.id;
  const make=(name,date)=>({type:'save',id:randomUUID(),data:{kind:'sample',name,stitches:20,rows:28,width:10,height:10,unit:'cm',needle_size_mm:4,blocking:'before',measured_on:date}});
  const action=make('첫 샘플','2026-10-20');
  const args={p_project_id:projectId,p_request_id:randomUUID(),p_expected_revision:0,p_action:action};
  const same=await Promise.all([rpc(client,'apply_project_gauge_command',args),rpc(client,'apply_project_gauge_command',args)]);
  assert.deepEqual(same.map(x=>x.status).sort(),['applied','duplicate']);
  assert.equal((await rpc(client,'get_project_gauges',{p_project_id:projectId})).items.length,1);
  const calls=await Promise.all(['둘째','셋째'].map(name=>rpc(client,'apply_project_gauge_command',{p_project_id:projectId,p_request_id:randomUUID(),p_expected_revision:1,p_action:make(name,'2026-10-19')})));
  assert.deepEqual(calls.map(x=>x.status).sort(),['applied','conflict']);
  // Simulate an acknowledgement lost to the caller: resend the exact successful request.
  assert.equal((await rpc(client,'apply_project_gauge_command',args)).status,'duplicate');
  const list=await rpc(client,'get_project_gauges',{p_project_id:projectId});assert.equal(list.revision,2);assert.equal(list.items.length,2);assert.equal(list.items[0].id,action.id);
  const invalid=await client.rpc('apply_project_gauge_command',{p_project_id:projectId,p_request_id:randomUUID(),p_expected_revision:2,p_action:{...action,data:{...action.data,stitches:1.5}}});assert.ok(invalid.error,'fractional stitch count rejected');
  const other=await auth();assert.equal((await other.rpc('get_project_gauges',{p_project_id:projectId})).error.code,'P0002');
  assert.equal((await other.from('project_gauges').select('id')).data.length,0);
  assert.ok((await client.from('project_gauges').update({stitches:99}).eq('id',action.id)).error);
  console.log('PASS gauge HTTP: concurrent duplicate requests, competing revision conflict, lost-response retry, sorted measurements, invalid integer, RLS and direct write denial');
}finally{
  if(users.length){const ids=users.map(id=>`'${id}'`).join(',');await sql(`begin;
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
