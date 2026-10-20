import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Fixed local Docker target; never loads a cloud URL or a service key.
const container='supabase_db_stitch-mori', userId=randomUUID();
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
function sql(query,onResult) {
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['exec','-i',container,'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-t','-A'],{stdio:['pipe','pipe','pipe']});
    let output='',error='',signaled=false;
    child.stdout.on('data',chunk=>{
      output+=chunk;
      const line=output.split('\n').find(line=>line.startsWith('{') && line.endsWith('}'));
      if(line && !signaled){signaled=true;onResult?.(JSON.parse(line));}
    });
    child.stderr.on('data',chunk=>error+=chunk);child.on('error',reject);
    child.on('close',code=>code===0?resolve(output.trim().split('\n').filter(line=>line.startsWith('{')).map(JSON.parse).at(-1)):reject(new Error(error||`psql ${code}`)));
    child.stdin.end(query);
  });
}
function owner(expression,hold=false,onResult) {
  return sql(`begin; set local statement_timeout='10s';
    create function pg_temp.attempt(q text) returns jsonb language plpgsql as $fn$
    declare r jsonb; begin execute q into r; return r; exception when others then return jsonb_build_object('sqlstate',sqlstate); end; $fn$;
    set local role authenticated; set local request.jwt.claim.sub=${quote(userId)};
    select jsonb_build_object('pid',pg_backend_pid(),'result',${expression});
    ${hold?'select pg_sleep(0.5);':''} commit;`,onResult);
}
// First connection has applied its operation and still holds locks; second is started before it commits.
async function race(first,second) {
  let ready,failed; const signal=new Promise((resolve,reject)=>{ready=resolve;failed=reject;});
  const a=owner(first,true,ready); a.catch(failed);
  const firstReply=await signal;
  const lock=await sql(`select jsonb_build_object('held',exists(select 1 from pg_stat_activity where pid=${firstReply.pid} and xact_start is not null and state<>'idle'));`);
  assert.equal(lock.held,true,'first backend still holds its transaction while the second request is dispatched');
  const results=await Promise.all([a,owner(second)]);
  assert.notEqual(results[0].pid,results[1].pid,'actual independent PostgreSQL connections');
  return results.map(x=>x.result);
}
const call=(session,work,revision,action,id=randomUUID())=>`public.apply_work_session_command(${quote(id)},${quote(session)},${quote(work)},${revision},'2000-01-01Z','two-connections',${quote(action)})`;
const run=async expression=>(await owner(expression)).result;
const attempt=query=>`pg_temp.attempt(${quote(query)})`;
const compiled=ts.transpileModule(readFileSync('src/domain/timer/engine.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {applyTimerCommand}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
function normalized(state) {
  if(!state)return state;
  const copy=structuredClone(state);
  for(const key of ['startedAt','endedAt','lastResumedAt','lastTransitionAt','createdAt','updatedAt']) if(copy[key])copy[key]=new Date(copy[key]).toISOString();
  return copy;
}
try {
  await sql(`insert into auth.users(id,email) values(${quote(userId)},${quote(`timer-concurrency-${userId}@example.test`)});`);
  const a=await run(`public.create_project('${randomUUID()}','타이머 동시 검증 A',null)`);
  const b=await run(`public.create_project('${randomUUID()}','타이머 동시 검증 B',null)`);
  let sa=randomUUID(),sb=randomUUID();
  let results=await race(call(sa,a.workItemId,0,'start'),call(sb,b.workItemId,0,'start'));
  assert.equal(results[0].status,'applied');assert.equal(results[1].reason,'active_session_exists');
  assert.equal((await run('public.get_work_session()')).state.sessionId,sa);
  await run(call(sa,a.workItemId,1,'end'));
  console.log('PASS two DB connections: different work items/projects cannot start two active sessions for one user');

  sa=randomUUID(); const startId=randomUUID();
  results=await race(call(sa,a.workItemId,0,'start',startId),call(sa,a.workItemId,0,'start',startId));
  assert.deepEqual(results.map(x=>x.status),['applied','duplicate']); assert.deepEqual(results[0].state,results[1].state);
  results=await race(call(sa,a.workItemId,1,'pause'),call(sa,a.workItemId,1,'pause'));
  assert.deepEqual(results.map(x=>x.status),['applied','conflict']);
  assert.equal((await run(call(randomUUID(),b.workItemId,0,'start'))).reason,'active_session_exists');
  await run(call(sa,a.workItemId,2,'resume'));await run(call(sa,a.workItemId,3,'end'));
  const snapshot=await run(`public.get_work_session('${sa}')`);
  let state=null;const history=[];
  for(const event of snapshot.events){
    const result=applyTimerCommand(state,history,event.command,event.effectiveAt,userId);
    assert.equal(result.status,'applied'); assert.deepEqual(normalized(result.state),normalized(event.after));
    state=result.state;history.push(event);
  }
  assert.deepEqual(normalized(state),normalized(snapshot.state));
  assert.equal((await run(call(sa,a.workItemId,0,'start',startId))).status,'duplicate');
  console.log('PASS two DB connections: duplicate start, stale pause conflict, paused slot, immutable retry and TypeScript/SQL replay parity');

  sa=randomUUID();
  results=await race(call(sa,a.workItemId,0,'start'),attempt(`select public.update_project('${a.id}',0,'타이머 A',null,'paused')`));
  assert.equal(results[1].sqlstate,'23514');await run(call(sa,a.workItemId,1,'end'));
  results=await race(`public.update_project('${a.id}',0,'타이머 A',null,'paused')`,call(randomUUID(),a.workItemId,0,'start'));
  assert.equal(results[1].reason,'project_or_part_unavailable');
  await run(`public.update_project('${a.id}',1,'타이머 A',null,'active')`);
  sa=randomUUID();
  results=await race(call(sa,a.workItemId,0,'start'),attempt(`select public.delete_project('${a.id}',2)`));
  assert.equal(results[1].sqlstate,'23514');await run(call(sa,a.workItemId,1,'end'));
  results=await race(`public.delete_project('${a.id}',2)`,call(randomUUID(),a.workItemId,0,'start'));
  assert.equal(results[1].reason,'project_or_part_unavailable');
  await run(`public.restore_project('${a.id}','${randomUUID()}',3)`);
  console.log('PASS two DB connections: project pause/deletion versus start is serialized safely in both orders');

  const part=await run(`public.apply_project_part_command('${a.id}','${randomUUID()}',4,'{"type":"create","name":"소매"}')`);
  sa=randomUUID();
  results=await race(call(sa,part.workItemId,0,'start'),attempt(`select public.apply_project_part_command('${a.id}','${randomUUID()}',5,'{"type":"delete","partId":"${part.partId}"}')`));
  assert.equal(results[1].sqlstate,'23514');await run(call(sa,part.workItemId,1,'end'));
  results=await race(`public.apply_project_part_command('${a.id}','${randomUUID()}',5,'{"type":"delete","partId":"${part.partId}"}')`,call(randomUUID(),part.workItemId,0,'start'));
  assert.equal(results[1].reason,'project_or_part_unavailable');
  console.log('PASS two DB connections: part soft deletion versus start is safe in both orders');

  const standalone=await run('public.create_counter_work_item()');const work=standalone.state.workItemId;sa=randomUUID();
  results=await race(call(sa,work,0,'start'),attempt(`select public.convert_counter_to_project('${work}','${randomUUID()}',0,'전환')`));
  assert.equal(results[1].sqlstate,'23514');await run(call(sa,work,1,'end'));
  // Conversion in the other order leaves a work-item identity intact; it becomes a valid active project target.
  const converted=await run(`public.convert_counter_to_project('${work}','${randomUUID()}',0,'전환')`);
  assert.equal(converted.workItemId,work);
  assert.equal((await run(call(randomUUID(),work,0,'start'))).status,'applied');
  const active=(await run('public.get_work_session()')).state;
  await run(call(active.sessionId,work,1,'end'));
  console.log('PASS conversion interlock: active standalone session cannot be silently reattached; ended history and work item remain intact');
} finally {
  await sql(`begin;
    set constraints all deferred;
    alter table public.work_session_events disable trigger work_session_events_append_only;
    alter table public.work_session_time_adjustments disable trigger work_session_adjustments_append_only;
    delete from public.work_session_time_adjustments where user_id='${userId}';
    delete from public.work_session_events where user_id='${userId}';
    delete from public.work_sessions where user_id='${userId}';
    set constraints all immediate;
    alter table public.work_session_events enable trigger work_session_events_append_only;
    alter table public.work_session_time_adjustments enable trigger work_session_adjustments_append_only;
    delete from public.counter_project_conversions where user_id='${userId}';
    delete from public.project_recovery_commands where user_id='${userId}';
    delete from public.project_part_commands where user_id='${userId}';
    delete from public.project_parts where user_id='${userId}';
    delete from public.projects where user_id='${userId}';
    delete from public.counters where work_item_id in(select id from public.work_items where user_id='${userId}');
    delete from public.work_items where user_id='${userId}';
    delete from auth.users where id='${userId}'; commit;`);
}
