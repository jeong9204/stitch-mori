import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const container = "supabase_db_stitch-mori";

function sql(query) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [
      "exec", "-i", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1",
      "-U", "postgres", "-d", "postgres", "-t", "-A",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(error || `psql exited ${code}`));
      else resolve(output.trim().split("\n").at(-1));
    });
    child.stdin.end(query);
  });
}

const userId = randomUUID();
let workItemId;
const occurredAt = new Date().toISOString();

function command(id, revision, action, delay = false) {
  return `
    begin;
    set local role authenticated;
    set local request.jwt.claim.sub = '${userId}';
    ${delay ? "select pg_sleep(0.3);" : ""}
    select public.apply_counter_command(
      '${id}', '${workItemId}', ${revision}, '${occurredAt}', 'concurrency-test',
      '${JSON.stringify(action)}'::jsonb
    );
    commit;
  `;
}

try {
  await sql(`insert into auth.users (id, email) values ('${userId}', '${userId}@example.test');`);
  const created = JSON.parse(await sql(`
    begin;
    set local role authenticated;
    set local request.jwt.claim.sub = '${userId}';
    select public.create_counter_work_item();
    commit;
  `));
  assert.equal(created.status, "created");
  workItemId = created.state.workItemId;

  const first = await Promise.all([
    sql(command(randomUUID(), 0, { type: "change", counter: "stitch", delta: 1 }, true)),
    sql(command(randomUUID(), 0, { type: "change", counter: "stitch", delta: 1 }, true)),
  ]);
  assert.deepEqual(first.map((value) => JSON.parse(value).status).sort(), ["applied", "conflict"]);
  const afterFirst = JSON.parse(await sql(`
    select jsonb_build_object(
      'revision', (select revision from public.work_items where id = '${workItemId}'),
      'stitch', (select current_value from public.counters where work_item_id = '${workItemId}' and counter_type = 'stitch'),
      'events', (select count(*) from public.counter_events where work_item_id = '${workItemId}')
    );
  `));
  assert.deepEqual(afterFirst, { revision: 1, stitch: 1, events: 1 });

  const repeatedId = randomUUID();
  const second = await Promise.all([
    sql(command(repeatedId, 1, { type: "completeRow", stitch: "reset" }, true)),
    sql(command(repeatedId, 1, { type: "completeRow", stitch: "reset" }, true)),
  ]);
  assert.deepEqual(second.map((value) => JSON.parse(value).status).sort(), ["applied", "duplicate"]);
  const afterSecond = JSON.parse(await sql(`
    select jsonb_build_object(
      'revision', (select revision from public.work_items where id = '${workItemId}'),
      'stitch', (select current_value from public.counters where work_item_id = '${workItemId}' and counter_type = 'stitch'),
      'row', (select current_value from public.counters where work_item_id = '${workItemId}' and counter_type = 'row'),
      'events', (select count(*) from public.counter_events where work_item_id = '${workItemId}')
    );
  `));
  assert.deepEqual(afterSecond, { revision: 2, stitch: 0, row: 1, events: 2 });
  console.log("PASS: concurrent stale revisions and duplicate command IDs preserve one event per applied command");
} finally {
  if (workItemId) {
    // Only test-owned rows are removed. Trigger suspension is transactional and local.
    await sql(`
      begin;
      alter table public.counter_events disable trigger counter_events_append_only;
      delete from public.counter_events where work_item_id = '${workItemId}';
      alter table public.counter_events enable trigger counter_events_append_only;
      delete from public.counters where work_item_id = '${workItemId}';
      delete from public.work_items where id = '${workItemId}';
      delete from auth.users where id = '${userId}';
      commit;
    `);
  } else {
    await sql(`delete from auth.users where id = '${userId}';`);
  }
}
