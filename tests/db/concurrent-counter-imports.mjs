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
const localWorkItemId = randomUUID();
const importId = randomUUID();
const eventId = randomUUID();
const occurredAt = new Date().toISOString();
const before = { workItemId: localWorkItemId, revision: 0, stitch: { current: 0, target: null }, row: { current: 0, target: null } };
const after = { ...before, revision: 1, stitch: { current: 1, target: null } };
const payload = { importId, localWorkItemId, state: after, events: [{
  eventId, commandId: eventId, workItemId: localWorkItemId, occurredAt, deviceId: "concurrent-import-test",
  action: { type: "change", counter: "stitch", delta: 1 }, before, after,
}] };
let serverWorkItemId;
try {
  await sql(`insert into auth.users (id, email) values ('${userId}', '${userId}@example.test');`);
  const command = `begin; set local role authenticated; set local request.jwt.claim.sub = '${userId}'; select public.import_counter_snapshot('${JSON.stringify(payload)}'::jsonb); commit;`;
  const results = await Promise.all([sql(command), sql(command)]);
  const parsed = results.map((result) => JSON.parse(result));
  assert.deepEqual(parsed.map((result) => result.status).sort(), ["duplicate", "imported"]);
  assert.equal(parsed[0].serverWorkItemId, parsed[1].serverWorkItemId);
  serverWorkItemId = parsed[0].serverWorkItemId;
  const counts = JSON.parse(await sql(`select jsonb_build_object(
    'receipts', (select count(*) from public.counter_imports where user_id = '${userId}'),
    'workItems', (select count(*) from public.work_items where user_id = '${userId}'),
    'events', (select count(*) from public.counter_events where work_item_id = '${serverWorkItemId}')
  );`));
  assert.deepEqual(counts, { receipts: 1, workItems: 1, events: 1 });
  console.log("PASS: two concurrent import requests created one receipt, work item, and event");
} finally {
  if (serverWorkItemId) {
    await sql(`begin;
      alter table public.counter_events disable trigger counter_events_append_only;
      delete from public.counter_imports where user_id = '${userId}';
      delete from public.counter_events where work_item_id = '${serverWorkItemId}';
      alter table public.counter_events enable trigger counter_events_append_only;
      delete from public.counters where work_item_id = '${serverWorkItemId}';
      delete from public.work_items where id = '${serverWorkItemId}';
      delete from auth.users where id = '${userId}';
      commit;`);
  } else {
    // A failed assertion may still have committed an import. Resolve only this test user's rows.
    await sql(`begin;
      alter table public.counter_events disable trigger counter_events_append_only;
      delete from public.counter_imports where user_id = '${userId}';
      delete from public.counter_events where work_item_id in (select id from public.work_items where user_id = '${userId}');
      alter table public.counter_events enable trigger counter_events_append_only;
      delete from public.counters where work_item_id in (select id from public.work_items where user_id = '${userId}');
      delete from public.work_items where user_id = '${userId}';
      delete from auth.users where id = '${userId}';
      commit;`);
  }
}
