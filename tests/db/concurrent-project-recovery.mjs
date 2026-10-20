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
const userId=randomUUID(), projectRequestId=randomUUID();
let projectId;
const asOwner=(query)=>`begin; set local role authenticated; set local request.jwt.claim.sub='${userId}'; ${query} commit;`;
try {
  await sql(`insert into auth.users(id,email) values ('${userId}','${userId}@example.test');`);
  const project=JSON.parse(await sql(asOwner(`select public.create_project('${projectRequestId}','동시 복구',null);`)));
  projectId=project.id;
  const part=JSON.parse(await sql(asOwner(`select public.apply_project_part_command('${projectId}','${randomUUID()}',0,'{"type":"create","name":"소매"}');`)));
  await sql(asOwner(`select public.apply_project_part_command('${projectId}','${randomUUID()}',1,'{"type":"delete","partId":"${part.partId}"}');`));
  await sql(asOwner(`select public.delete_project('${projectId}',2);`));
  const restoreId=randomUUID();
  const command=asOwner(`select public.restore_project('${projectId}','${restoreId}',3);`);
  const results=(await Promise.all([sql(command),sql(command)])).map(JSON.parse);
  assert.deepEqual(results.map(r=>r.status).sort(),['duplicate','restored']);
  const partResults=(await Promise.all([randomUUID(),randomUUID()].map(id=>sql(asOwner(`select public.restore_project_part('${projectId}','${part.partId}','${id}',4);`))))).map(JSON.parse);
  assert.deepEqual(partResults.map(r=>r.status).sort(),['conflict','restored']);
  const detail=JSON.parse(await sql(asOwner(`select public.get_project_detail('${projectId}');`)));
  assert.equal(detail.revision,5);
  assert.equal(detail.parts.length,2);
  assert.equal(detail.parts[1].id,part.partId);
  assert.equal(detail.parts[1].workItemId,part.workItemId);
  console.log('PASS: concurrent project retries restored once; competing part recovery returned one revision conflict');
} finally {
  await sql(`begin;
    delete from public.project_recovery_commands where user_id='${userId}';
    delete from public.project_part_commands where user_id='${userId}';
    delete from public.project_parts where user_id='${userId}';
    delete from public.projects where user_id='${userId}';
    delete from public.counters where work_item_id in (select id from public.work_items where user_id='${userId}');
    delete from public.work_items where user_id='${userId}';
    delete from auth.users where id='${userId}'; commit;`);
}
