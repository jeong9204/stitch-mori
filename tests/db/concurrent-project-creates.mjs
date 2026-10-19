import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const container = "supabase_db_stitch-mori";
function sql(query) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-t", "-A"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output.trim().split("\n").at(-1)) : reject(new Error(error || `psql exited ${code}`)));
    child.stdin.end(query);
  });
}
const userId = randomUUID();
const requestId = randomUUID();
try {
  await sql(`insert into auth.users (id, email) values ('${userId}', '${userId}@example.test');`);
  const command = `begin; set local role authenticated; set local request.jwt.claim.sub = '${userId}'; select public.create_project('${requestId}', '동시 생성', null); commit;`;
  const results = (await Promise.all([sql(command), sql(command)])).map(JSON.parse);
  assert.deepEqual(results.map((result) => result.result).sort(), ["created", "duplicate"]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(results[0].workItemId, results[1].workItemId);
  const counts = JSON.parse(await sql(`select jsonb_build_object(
    'projects', (select count(*) from public.projects where user_id = '${userId}'),
    'parts', (select count(*) from public.project_parts where user_id = '${userId}'),
    'workItems', (select count(*) from public.work_items where user_id = '${userId}'),
    'counters', (select count(*) from public.counters where work_item_id = '${results[0].workItemId}')
  );`));
  assert.deepEqual(counts, { projects: 1, parts: 1, workItems: 1, counters: 2 });
  console.log("PASS: simultaneous project creation made one project, part, work item, and two counters");
} finally {
  await sql(`begin;
    delete from public.project_parts where user_id = '${userId}';
    delete from public.projects where user_id = '${userId}';
    delete from public.counters where work_item_id in (select id from public.work_items where user_id = '${userId}');
    delete from public.work_items where user_id = '${userId}';
    delete from auth.users where id = '${userId}';
    commit;`);
}
