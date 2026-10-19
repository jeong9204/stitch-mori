import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
const container = "supabase_db_stitch-mori";
function sql(query) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-t", "-A"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", chunk => error += chunk);
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output.trim().split("\n").at(-1)) : reject(new Error(error || `psql exited ${code}`)));
    child.stdin.end(query);
  });
}
const userId=randomUUID(), requestId=randomUUID(), projectRequestId=randomUUID();
let projectId;
try {
  await sql(`insert into auth.users(id,email) values ('${userId}','${userId}@example.test');`);
  const create=`begin; set local role authenticated; set local request.jwt.claim.sub='${userId}'; select public.create_project('${projectRequestId}','동시 파트',null); commit;`;
  projectId=JSON.parse(await sql(create)).id;
  const command=`begin; set local role authenticated; set local request.jwt.claim.sub='${userId}'; select public.apply_project_part_command('${projectId}','${requestId}',0,'{"type":"create","name":"왼쪽 소매"}'::jsonb); commit;`;
  const results=(await Promise.all([sql(command),sql(command)])).map(JSON.parse);
  assert.deepEqual(results.map(r=>r.status).sort(),["applied","duplicate"]);
  assert.equal(results[0].partId,results[1].partId);
  assert.equal(results[0].workItemId,results[1].workItemId);
  const counts=JSON.parse(await sql(`select jsonb_build_object('parts',(select count(*) from public.project_parts where project_id='${projectId}'),'workItems',(select count(*) from public.work_items where user_id='${userId}'),'counters',(select count(*) from public.counters where work_item_id='${results[0].workItemId}'),'receipts',(select count(*) from public.project_part_commands where project_id='${projectId}'));`));
  assert.deepEqual(counts,{parts:2,workItems:2,counters:2,receipts:1});
  console.log('PASS: concurrent duplicate part creation created one additional part and counter pair');
} finally {
  await sql(`begin;
    delete from public.project_part_commands where user_id='${userId}';
    delete from public.project_parts where user_id='${userId}';
    delete from public.projects where user_id='${userId}';
    delete from public.counters where work_item_id in (select id from public.work_items where user_id='${userId}');
    delete from public.work_items where user_id='${userId}';
    delete from auth.users where id='${userId}';
    commit;`);
}
