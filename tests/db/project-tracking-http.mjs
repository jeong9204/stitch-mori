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
async function auth(){const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});const email=`tracking-http-${randomUUID()}@example.test`;const sent=await client.auth.signInWithOtp({email});assert.ifError(sent.error);let token;
  for(let i=0;i<20&&!token;i++){const mails=await(await fetch('http://127.0.0.1:54324/api/v1/messages')).json();token=mails.messages.find(m=>m.To.some(t=>t.Address===email))?.Snippet.match(/\b\d{6}\b/)?.[0];if(!token)await new Promise(r=>setTimeout(r,250));}
  assert.ok(token);const verified=await client.auth.verifyOtp({email,token,type:'email'});assert.ifError(verified.error);users.push(verified.data.user.id);return client;}
async function rpc(client,name,args){const result=await client.rpc(name,args);assert.ifError(result.error);return result.data;}
try {
  const a=await auth(), b=await auth();
  const project=await rpc(a,'create_project',{p_request_id:randomUUID(),p_name:'진행률 HTTP 검증 전용',p_notes:null});
  const get=()=>rpc(a,'get_project_detail',{p_project_id:project.id});
  const make=(revision,action,request=randomUUID())=>({p_project_id:project.id,p_request_id:request,p_expected_revision:revision,p_action:action});
  const apply=args=>rpc(a,'apply_project_tracking_command',args);
  assert.equal(project.progressPercent,null);
  assert.equal((await get()).parts[0].status,'not_started');
  const args=make(0,{type:'setProgress',value:50});
  const duplicate=await Promise.all([apply(args),apply(args)]);
  assert.deepEqual(duplicate.map(r=>r.status).sort(),['applied','duplicate']);
  assert.deepEqual(duplicate[0].change,duplicate[1].change);
  assert.equal((await get()).revision,1);
  // Simulate losing an already committed reply; retry retains original ID and revision.
  const lost=make(1,{type:'setProgress',value:100});
  await apply(lost);
  const retry=await apply(lost);assert.equal(retry.status,'duplicate');assert.equal(retry.projectRevision,2);
  assert.equal((await get()).status,'active');
  const competing=await Promise.all([apply(make(2,{type:'setProgress',value:25})),apply(make(2,{type:'setProgress',value:75}))]);
  assert.deepEqual(competing.map(r=>r.status).sort(),['applied','conflict']);
  let detail=await get();assert.equal(detail.revision,3);assert.ok([25,75].includes(detail.progressPercent));
  assert.equal(competing.find(r=>r.status==='conflict').latestRevision,3);
  const part=detail.parts[0];
  const statusArgs=make(3,{type:'setPartStatus',partId:part.id,status:'in_progress'});
  const statuses=await Promise.all([apply(statusArgs),apply(statusArgs)]);
  assert.deepEqual(statuses.map(r=>r.status).sort(),['applied','duplicate']);
  const statusRace=await Promise.all([apply(make(4,{type:'setPartStatus',partId:part.id,status:'paused'})),apply(make(4,{type:'setPartStatus',partId:part.id,status:'completed'}))]);
  assert.deepEqual(statusRace.map(r=>r.status).sort(),['applied','conflict']);
  // Existing metadata edits contend on precisely the same project revision.
  const race=await Promise.all([
    a.rpc('update_project',{p_project_id:project.id,p_expected_revision:5,p_name:'이름 수정 경합',p_notes:null,p_status:'active'}),
    a.rpc('apply_project_tracking_command',make(5,{type:'setProgress',value:0})),
  ]);
  assert.equal(race.filter(r=>!r.error&&['applied','active'].includes(r.data?.status)).length,1);
  assert.ok(race.some(r=>r.error?.code==='40001'||r.data?.status==='conflict'));
  detail=await get();assert.equal(detail.revision,6);
  const before=(await a.from('counters').select('*').eq('work_item_id',part.workItemId)).data;
  const count=await rpc(a,'apply_counter_command',{p_command_id:randomUUID(),p_work_item_id:part.workItemId,p_expected_revision:0,p_occurred_at:new Date().toISOString(),p_device_id:'tracking-http',p_action:{type:'change',counter:'stitch',delta:1}});
  assert.equal(count.status,'applied');
  const workBefore=(await a.from('work_items').select('*').eq('id',part.workItemId).single()).data;
  const countersBefore=(await a.from('counters').select('*').eq('work_item_id',part.workItemId)).data;
  const eventsBefore=(await a.from('counter_events').select('*').eq('work_item_id',part.workItemId)).data;
  assert.equal(before.length,2);
  const statusNew=make(6,{type:'setPartStatus',partId:part.id,status:'not_started'});
  await apply(statusNew);
  assert.deepEqual((await a.from('work_items').select('*').eq('id',part.workItemId).single()).data,workBefore);
  assert.deepEqual((await a.from('counters').select('*').eq('work_item_id',part.workItemId)).data,countersBefore);
  assert.deepEqual((await a.from('counter_events').select('*').eq('work_item_id',part.workItemId)).data,eventsBefore);
  for(const action of [{type:'setProgress',value:-1},{type:'setProgress',value:101},{type:'setProgress',value:1.5},{type:'setProgress',value:'50'},{type:'setProgress'},{type:'setPartStatus',partId:part.id,status:'active'}]) {
    const invalid=await a.rpc('apply_project_tracking_command',make(7,action));assert.equal(invalid.error?.code,'22023');
  }
  assert.ok((await a.from('projects').update({progress_percent:10}).eq('id',project.id)).error);
  assert.ok((await a.from('project_parts').update({status:'completed'}).eq('id',part.id)).error);
  assert.ok((await b.rpc('apply_project_tracking_command',make(7,{type:'setProgress',value:0}))).error);
  assert.ok((await b.rpc('apply_project_tracking_command',make(7,{type:'setPartStatus',partId:part.id,status:'paused'}))).error);
  assert.deepEqual((await b.from('projects').select('id,progress_percent').eq('id',project.id)).data,[]);
  assert.deepEqual((await b.from('project_parts').select('id,status').eq('id',part.id)).data,[]);
  const anonymous=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  assert.ok((await anonymous.rpc('apply_project_tracking_command',make(7,{type:'setProgress',value:0}))).error);
  const otherProject=await rpc(b,'create_project',{p_request_id:randomUUID(),p_name:'독립 계정',p_notes:null});
  assert.equal((await rpc(b,'apply_project_tracking_command',{...args,p_project_id:otherProject.id})).status,'applied');
  const cleared=await apply(make(7,{type:'setProgress',value:null}));assert.equal(cleared.projectRevision,8);
  const list=await a.from('projects').select('id,progress_percent').eq('id',project.id).single();assert.ifError(list.error);assert.equal(list.data.progress_percent,null);
  await rpc(a,'delete_project',{p_project_id:project.id,p_expected_revision:8});
  assert.ok((await a.rpc('apply_project_tracking_command',make(9,{type:'setProgress',value:10}))).error);
  await rpc(a,'restore_project',{p_project_id:project.id,p_request_id:randomUUID(),p_expected_revision:9});
  detail=await get();assert.equal(detail.progressPercent,null);assert.equal(detail.parts[0].status,'not_started');assert.equal(detail.parts[0].stitch,1);
  console.log('PASS tracking HTTP: real OTP/auth, concurrent progress and part status CAS, identical-ID races, lost-response idempotency, shared revision with legacy edits, null/reset, payload guards, ownership/RLS/direct-write denial, counter data preservation and soft delete/restore.');
}finally{
  if(users.length){const ids=users.map(id=>`'${id}'`).join(',');await sql(`begin;
    delete from public.project_recovery_commands where user_id in (${ids});
    delete from public.project_part_commands where user_id in (${ids});
    alter table public.counter_events disable trigger counter_events_append_only;
    delete from public.counter_events where work_item_id in(select id from public.work_items where user_id in (${ids}));
    alter table public.counter_events enable trigger counter_events_append_only;
    delete from public.project_parts where user_id in (${ids});delete from public.projects where user_id in (${ids});
    delete from public.counters where work_item_id in(select id from public.work_items where user_id in (${ids}));
    delete from public.work_items where user_id in (${ids});delete from auth.users where id in (${ids});commit;`);}
}
