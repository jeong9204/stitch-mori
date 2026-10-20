# StitchMori

Phase 1A includes a guest quick counter at `/quick`. Phase 1B-1 adds authenticated server counter RPCs, Phase 1B-2 adds explicit local-record import, and Phase 1B-3 lets signed-in users continue account counters. Projects and ongoing device sync remain in progress.

## Guest quick counter

Open `/quick` to count stitches and rows without logging in. The browser stores one quick work item, its current counter snapshot, stable work item/import/device IDs, and an append-only event for each accepted change in IndexedDB (`stitchmori-local-v1`). A row completion changes row and stitch values in one command. Undo adds another event. Rapid taps update the screen immediately and enter an ordered, in-memory write queue; the screen shows how many writes are pending. A failed write keeps the queue in this tab and can be retried with the same command IDs. Do not close or reload a tab while it reports an unsaved change: the in-memory queue cannot survive a failed IndexedDB write.

Guest data stays in this browser and is never sent to Supabase by the quick counter. The separate `/import` flow sends a frozen saved snapshot only after the signed-in user chooses to import it. Clearing site data or using a private browsing session can remove the local original. Ongoing synchronization across devices is a later phase.

## Local setup

This project uses a **local Supabase stack** for development. No hosted Supabase project is needed. Node.js 20+ and a running Docker-compatible runtime are required; Docker Desktop is installed on this machine. The Supabase CLI is a pinned project dev dependency.

1. Run `npm install` and start Docker Desktop (or OrbStack if installed later).
2. Once per machine, create a network that binds published ports to localhost:

   ```sh
   docker network create -o com.docker.network.bridge.host_binding_ipv4=127.0.0.1 stitch-mori-local
   ```

3. Run `npx supabase start --network-id stitch-mori-local` from this repository. The first run downloads container images and applies the migration in `supabase/migrations/` to the **local** DB.
4. Run `npx supabase status` to see local URLs and keys. Put the API URL (`http://127.0.0.1:54321`) and the **public** publishable/anon key in `.env.local` as `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Never use the service-role/secret key in `NEXT_PUBLIC_*` variables. `.env.local` is ignored by Git.
5. Run `npm run dev` and open `http://localhost:3000`.

The current machine's `.env.local` is configured for the local stack. If local keys change after a reset or reinstall, refresh it from `npx supabase status`. Set the public variables before a production build because Next.js embeds them in the browser bundle.

### Stop, resume, and reset

```sh
npx supabase stop                         # stop containers; keep local data
npx supabase start --network-id stitch-mori-local  # resume
npx supabase db reset --local --network-id stitch-mori-local  # delete local data; replay migrations
```

`db reset --local` removes local users and data. Do not add `--linked`, run `supabase link`, or run `supabase db push` for this local workflow. The local stack is for development only.

## Email OTP test

The local template in `supabase/templates/magic_link.html` uses `{{ .Token }}` and is enabled by `supabase/config.toml`. Restart the local stack after changing the template. Supabase captures local emails in Mailpit at `http://127.0.0.1:54324`; no message is delivered to a real inbox. Open `/login`, request a code for any test email, read the six-digit code in Mailpit, and enter it on the site. The form uses `signInWithOtp({ email })` and `verifyOtp({ email, token, type: 'email' })`. See the [Supabase local email guide](https://supabase.com/docs/guides/local-development/cli/testing-and-linting) and [template guide](https://supabase.com/docs/guides/local-development/customizing-email-templates).

## Database migration

`supabase/migrations/20261018000000_counter_foundation.sql` creates only `work_items`, `counters`, and `counter_events`. It adds FK, CHECK, UNIQUE, indexes, an append-only event trigger, SELECT-only grants and owner-based RLS. Anonymous visitors have no server table access. Direct insert/update/delete is revoked for authenticated clients too.

`supabase/migrations/20261018000001_counter_commands.sql` adds authenticated `create_counter_work_item()` and `apply_counter_command(...)` RPCs. Both are public invoker wrappers around private definer functions with an empty search path and explicit owner checks. The command RPC accepts the command envelope and action, reads the server state under a work item row lock, checks `command_id` and `expected_revision`, and writes both counters, revision, and an append-only event in one transaction. A duplicate returns its original result and the latest revision. The client cannot submit a next-state snapshot. The original foundation migration is unchanged.

For an existing local stack, run `npx supabase migration up --local --network-id stitch-mori-local`. `supabase start` and `supabase db reset --local` also apply pending migrations locally, but reset deletes local users and data. Do not run these migrations against an online project without a separate deployment review. Phase 2 adds projects, parts, 1:1 linkage and soft deletion. Phase 3 adds work sessions.

## Commands

```sh
npm run lint
npm run typecheck
npm run build
npm test
```

DB constraint and RLS tests run against the local database with `npx supabase test db --network-id stitch-mori-local`; they do not contact a hosted project. The network flag is needed because this project starts the stack on its own localhost-bound network. The app test command covers counter rules and IndexedDB persistence with an in-memory IndexedDB implementation.

Run `node tests/db/concurrent-counter-commands.mjs` with the local stack running to test two independent PostgreSQL connections issuing commands simultaneously. It creates a temporary test user and work item, verifies revision contention and duplicate command IDs, then removes only its own test rows. The test briefly disables the append-only trigger inside a local cleanup transaction; application roles retain no event mutation privileges.

## Data boundary

- `src/domain` contains framework-independent work item and counter contracts.
- `src/data/local` implements the guest IndexedDB store with atomic snapshot/event writes.
- `src/data/import` defines stable import IDs and server receipts, so a retry cannot overwrite an account record or delete the local original before acknowledgment.
- `src/data/remote` contains an authenticated Supabase adapter for the new RPCs; `src/data/sync` remains a future sync boundary.
- `src/app` contains web routes. A future native shell can use the same domain rules and reusable UI without matching web URLs.

## Phase 1B-2 local record import

After email OTP login, `/import` shows the saved quick counter and separate account work items. Signing in does not upload local data. The user must choose **계정으로 가져오기**. The import page does not create an empty local counter just by opening it.

`supabase/migrations/20261019000000_counter_imports.sql` adds an owner-scoped import receipt and `import_counter_snapshot(jsonb)`. Apply it only to the local stack with `npx supabase migration up --local --network-id stitch-mori-local`; do not apply it to an online project without a separate review. The RPC creates a separate account work item, replays every action through the existing server command validator, checks each before/after snapshot and revision, and commits the events, counters, and receipt together. It remaps event IDs and undo links to server IDs; the original payload and IDs remain in the receipt. The existing account work items are not overwritten. A repeat request for the same user and import ID with the same payload returns the original server work item; a changed payload is rejected.

IndexedDB upgrades in place to version 2 and keeps the Phase 1A work item and events. The first import attempt freezes a saved snapshot under the existing import ID. Retries use that same snapshot even if the network response was lost or local counting later continues. While importing, local counter writes are temporarily blocked. If the tab closes mid-import, `/quick` offers a way to release the local lock and keep counting; the frozen snapshot stays available for an idempotent retry, and later local edits are not silently added to it. The local original is never deleted. After server acknowledgment, the local record stores the account user ID, server work item ID, and imported revision. If local counting continues afterward, those newer changes remain only on this device and are shown as separate from the imported snapshot. Server records on `/import` are currently read-only; Phase 1B-2 does not implement ongoing server counting or cross-device synchronization.

Run `npx supabase test db --network-id stitch-mori-local` to test import replay, undo mapping, duplicate requests, owner isolation, and the existing database policies. Run `node tests/db/concurrent-counter-imports.mjs` with the local stack running to test two simultaneous import requests against separate PostgreSQL connections; it cleans up only its temporary user and rows. The app tests cover IndexedDB upgrade, frozen snapshots, write blocking, response loss, retry, and account mismatch.

## Phase 1B-3 account counter continuation

After login, `/account` lists work items owned by the current user. Open an item at `/account/[workItemId]` to continue counting. `/quick` always remains the separate, local-only counter. The account counter reads owner-scoped `work_items`, `counters`, and `counter_events` through RLS and sends changes through the existing `apply_counter_command` RPC. No Phase 1B-3 DB migration is needed.

Before sending an account command, the browser commits its stable command ID, expected revision, action, device ID, and occurrence time to a separate IndexedDB outbox (`stitchmori-server-commands-v1`). Commands are sent in order. The display may show a preview while the status clearly distinguishes pending work from server-confirmed values. On a network failure, retry uses the same command ID. After a reload, the outbox is read for that account and work item; an already-applied command is acknowledged by the RPC without another count. Pending commands remain stored if the tab closes.

If another device changes the revision, the pending commands stay in the outbox. The screen shows the latest server state and the pending actions. It does not automatically apply those actions to the new revision. The user can check the latest state, or explicitly discard the pending commands after a confirmation. Logging out leaves the outbox under its original user ID and hides that account's server data. Account work items do not automatically synchronize the separate local quick counter or its post-import changes.

## Phase 2A projects (local development)

The `/projects` page lets a signed-in user create a project, edit its name and notes, change its status, and open its default part in the existing `/account/[workItemId]` counter. Anonymous visitors see a login prompt; `/quick` remains device-local. A project card shows only saved project fields. There is no project timer, progress estimate, or multi-part editor yet.

`supabase/migrations/20261019000001_projects.sql` adds `projects` and `project_parts`. Project creation is a single authenticated `create_project` transaction: it uses the existing work-item creation function, creates both counter rows, then links one default part. The owner-matching composite FKs prohibit connecting a part to another user's project or work item. Clients can read their own rows through RLS, but can only create, update, or soft-delete through RPCs. Project edits use a project revision separate from the counter revision. A stable creation request ID makes concurrent and retried creation idempotent; changing the payload for the same request ID is rejected. If a create request times out, use the on-screen retry without closing the form so the same request ID is reused.

Deletion sets `projects.deleted_at` and hides the project from the normal list. The part, work item, counters, and events remain stored; physical deletion is restricted by FKs. Phase 2C-1 provides an explicit recovery panel. Deleted project counters stay hidden through both project and account routes until recovery.

Apply the new migration only to the local stack with `npx supabase migration up --local --network-id stitch-mori-local`. Run `npx supabase test db --network-id stitch-mori-local` for RLS, constraints, RPC, and counter linkage. Run `node tests/db/concurrent-project-creates.mjs` to exercise two actual simultaneous DB connections; it removes only its temporary user and records. Do not use `db reset` if you need to retain local development records.

## Phase 2B parts (local development)

Each project keeps its Phase 2A default part. `/projects/[projectId]` lists active parts with their saved stitch and row counts and latest server activity. Add another part to create a separate work item and two zeroed counters in one database transaction. Part names may repeat. The default part may be renamed or reordered, but cannot be deleted; this guarantees every active project has a usable part. Other parts use soft deletion. Their counters and events remain in PostgreSQL, but RLS and the public counter RPC deny access while the part or project is deleted. Phase 2C-1 adds recovery controls to the project list and detail pages.

Part create, rename, move, and delete use `apply_project_part_command` with a stable request ID and expected project revision. The database stores a private receipt and returns it on an identical retry, including after a lost response. A stale revision returns a conflict; the UI asks the user to reload and resubmit rather than merging changes. Up/down ordering persists as `project_parts.position`. The most recently changed active part is offered under “이어서 작업하기”; if there is no history or that part was deleted, the active default part is offered. This recommendation is based on server counter event creation time, while the displayed change time is the command occurrence time.

Counting is allowed only while a project is **진행 중**. **보류** and **완료** are readable but cannot receive new counter commands until the project is changed back to 진행 중. Both `/projects/[projectId]/parts/[partId]` and the existing `/account/[workItemId]` path use the same server counter panel, command RPC, and account/work-item-scoped IndexedDB outbox. A soft-deleted part or project is hidden from reads through either path. Before deletion, the UI checks this device's IndexedDB outbox for every affected active part and blocks deletion if any command is pending. Other devices' unsent commands cannot be observed by this browser; the recovery flow makes their source work item accessible again and requires pending-command review. Ordinary account counters and the guest `/quick` counter remain separate.

Apply `supabase/migrations/20261019000002_project_parts.sql` to the local stack with `npx supabase migration up --local --network-id stitch-mori-local`. Run `npx supabase test db --network-id stitch-mori-local` and `node tests/db/concurrent-project-parts.mjs` for transaction, RLS, independent counters, and concurrent retry checks. Do not apply the migration to an online project without a separate deployment review.


## Phase 2C-1 recovery (local development)

Open “삭제된 프로젝트 보기” on `/projects`, or “삭제된 파트 보기” in an active project's detail. Recovery requires confirmation and preserves the original project, part, and work-item IDs, counter values, targets, revisions, and events. A project returns to its pre-deletion status (paused/completed remain read-only); parts individually deleted before project deletion stay deleted. Recover those parts separately after the parent is restored. A restored part is appended after all existing positions to avoid ordering collisions.

`20261019000003_project_recovery.sql` adds owner-only deleted-list RPCs and transaction-safe `restore_project` / `restore_project_part`. A private request receipt makes identical retries idempotent, including a lost response; conflicting project revisions require a fresh list and user action. Existing RLS continues to hide deleted records from ordinary reads and counter writes. The deleted-list RPCs expose only the signed-in owner's recovery summaries.

Recovery records `work_items.recovery_revision` without changing the counter revision or event stream. When a counter opens with pending commands at or before that recovery boundary, the session shows server-confirmed values and holds the queue for explicit review. Confirming retry still uses the original command IDs and expected revisions; it does not rebase conflicting commands. The IndexedDB queue schema and stored commands are unchanged. A failed first new command at the same recovery revision may also require review after reload; this conservative check avoids replaying an old command automatically.

Apply only locally with `npx supabase migration up --local --network-id stitch-mori-local`. Run `npx supabase test db --network-id stitch-mori-local`, `node tests/db/concurrent-project-recovery.mjs`, and `npm test` for recovery, ownership, idempotency, concurrency, and pending-command checks. The recovery UI is online-only and does not implement full offline synchronization.

## Phase 2C-2 counter → project conversion (local development)

A standalone account counter offers “프로젝트로 전환”. `/convert/account/[workItemId]` displays its saved values, goals, history count and last count time, asks for a project name, then requires confirmation. The new `convert_counter_to_project` RPC locks the existing work item, validates ownership and the expected counter revision, and creates only a project and default part. It preserves every counter/event row and the work item ID/revision. The existing unique part/work-item constraint prevents membership in multiple projects, including soft-deleted projects. Account counter lists now use `list_account_counters` to exclude project work items; projects remain accessible under `/projects`.

The local `/quick` link opens `/convert/quick`. Guests first see a login prompt; OTP login returns to that conversion screen without uploading anything. Only confirmation starts the existing frozen-snapshot import. A previously imported record reuses its server work item; later local edits are not uploaded again. The local original stays intact and `/quick` stays local-only. Continue new server counts in the project counter.

A separate `stitchmori-conversions-v1` IndexedDB journal stores the user/source-scoped request ID, fixed project name, original revision and server mapping before conversion. This does not modify either counter queue. Import success followed by conversion failure is recoverable: reload and retry use the same import receipt, server work item and conversion request. A server revision conflict requires reviewing the latest state and explicitly starting a new request; the client never rebases or clears counter commands. Current-device server pending commands and unsaved quick-tab changes block conversion. The server cannot inspect another device's IndexedDB queue, so its work-item revision and membership checks remain the final integrity boundary.

`supabase/migrations/20261020000000_counter_project_conversion.sql` adds private conversion receipts, the conversion RPC, standalone-counter listing and an owner-scoped membership lookup. Apply only to the local stack. Existing project deletion/recovery and counter authorization rules apply to converted records. Run `npx supabase test db --network-id stitch-mori-local`, `npm test`, and `node tests/db/counter-conversion-http.mjs`. The HTTP test refuses non-local URLs, authenticates through local Mailpit OTP, checks simultaneous requests and import/convert partial failure, and removes only its temporary test users/data. Conversion requires a network connection; no automatic multi-device merging or post-import local synchronization is provided.

### Phase 2D — 프로젝트 게이지 기록

- 프로젝트 상세의 **게이지 기록**에서 도안 게이지 1개와 측정 샘플 여러 개를 등록·수정·삭제합니다. 도안 게이지는 선택 사항입니다. 진행 중·보류·완료 프로젝트 모두 게이지 메모를 관리할 수 있으며, 프로젝트가 삭제되면 조회·수정을 차단합니다.
- `project_gauges`는 프로젝트·사용자 복합 FK, owner RLS, 서버 RPC 전용 쓰기를 사용합니다. 게이지 삭제는 soft delete이며 복구 UI는 제공하지 않습니다. 프로젝트 삭제·복구는 기존 게이지를 그대로 보존합니다.
- `projects.gauge_revision`은 게이지 컬렉션 전용 revision입니다. 프로젝트 메타데이터·카운터 revision과 분리되며, 프로젝트 row lock으로 삭제와 게이지 저장을 직렬화합니다. `project_gauge_commands` 영수증은 사용자+request ID 기준으로 중복 적용을 막고, 같은 ID에 다른 내용을 보내면 거부합니다.
- 충돌 시 자동 재적용하지 않습니다. 입력은 유지한 채 최신 게이지를 확인하고 다시 저장합니다. 응답 유실 시 화면에 보존된 동일 요청으로 재시도합니다. 미확정 요청은 게이지 화면에서 입력·취소를 잠시 제한합니다. **게이지 요청은 브라우저 재시작까지 영속 보관하지 않으므로 페이지를 떠나기 전에 결과를 확인해야 합니다.** 재접속 시 서버 목록을 확인한 후 새로운 기록을 작성합니다. 기존 카운터 영속 큐에는 영향이 없습니다.
- 코수·단수: 1~1,000,000 정수. 폭·높이: 0 초과~10,000, 소수 3자리. 단위는 `cm`/`inch`를 원본 그대로 저장합니다. 바늘 지름은 선택적 `needle_size_mm`(0 초과~100, 소수 3자리)와 `needle_label`(원래 호수 표기)을 분리합니다. 블로킹은 `before`/`after`/`unspecified`, 측정일은 시간대 없는 `date`입니다.
- 측정일 내림차순, 날짜가 없으면 뒤로, 동일 날짜는 생성 시각 내림차순으로 정렬합니다. 현재 사용 샘플 선택, 게이지 자동 환산·비교는 이번 단계에 포함하지 않습니다. 추후 계산기는 원본 치수·단위와 mm 수치를 읽어 계산하고 원본 기록을 덮어쓰지 않는 계층으로 확장할 수 있습니다.
- 로컬 검증: `npx supabase migration up --local`, `npx supabase test db --network-id stitch-mori-local`, `node tests/db/project-gauges-http.mjs`. HTTP 테스트는 localhost Supabase만 허용하며 테스트 계정·기록을 생성한 뒤 정리합니다. 온라인 Supabase에는 적용하지 않습니다.

### Phase 3A — 작업 세션 기반 (UI 미연결)

- `src/domain/timer`는 React·Next.js와 무관한 순수 엔진입니다. 저장된 세션이 없으면 idle이며, `start → running`, `pause → paused`, `resume → running`, `end → ended`만 지원합니다. 종료한 세션은 다시 열지 않고 새 session ID를 사용합니다. 카운터와 세션 revision은 독립적입니다.
- running 경과 시간은 `accumulatedMs + (현재 절대 시각 - lastResumedAt)`이며, paused/ended에서는 저장된 누적 시간을 사용합니다. interval/tick을 저장하거나 백그라운드에서 시간을 누적하지 않습니다. 로컬 재접속 시 running은 계속 경과한 것으로 복원하며 자동 일시정지·자동 재개·시간 상한 처리를 하지 않습니다. 따라서 탭 종료와 컴퓨터 절전도 running 구간에 포함됩니다.
- `work_sessions`는 `(work_item_id,user_id)` FK로 소유권을 보장합니다. 프로젝트/파트는 기존 work item 관계를 통해 조회하며 ID를 중복 저장하지 않습니다. `work_session_events`는 명령 봉투, 이전/이후 상태, revision, 요청 발생 시각, 서버 확정 시각을 추가 전용으로 보존하고 명령 영수증 역할도 합니다. 마지막 명령 FK는 이벤트와 스냅샷의 같은 트랜잭션 저장을 보장합니다.
- `apply_work_session_command(command_id,session_id,work_item_id,expected_revision,occurred_at,device_id,action)`은 클라이언트 최종 시간을 받지 않습니다. 서버 `clock_timestamp()`를 ms 정밀도로 확정하여 계산하고, `occurred_at`은 감사용으로 보존합니다. 명령 ID는 사용자 범위에서 유일하며, 동일 봉투 재시도는 과거 적용 결과를 반환합니다. ID를 다른 내용으로 재사용하면 거부합니다. **duplicate 응답은 최신 상태가 아닐 수 있으므로** `get_work_session(session_id)`로 최신 상태·이벤트·`serverNow`를 다시 읽습니다. ID 생략 시 현재 활성 세션을 반환합니다.
- **서버 타이머의 오프라인 pause/end 제한:** 오프라인 또는 네트워크 지연 중 입력한 pause/end는 기기에서 버튼을 누른 시각이 아니라, 요청이 서버에 도착해 최초 적용되는 서버 시각으로 처리합니다. 그때까지 running 시간이 계속 계산되며 과거 클라이언트 시각으로 소급 적용하지 않습니다. 이미 처리된 명령의 재전송은 최초 적용 결과를 반환하고 시간을 다시 더하지 않습니다. 실제 작업 시간과 달라진 기록의 정정은 후속 단계에서 다루며, 이번 단계에는 정정 RPC·UI가 없습니다.
- 사용자당 running 또는 paused인 미종료 세션은 최대 하나입니다. 사용자 타이머 잠금과 partial UNIQUE 인덱스가 다른 기기의 동시 시작을 차단합니다. 기존 활성 세션을 종료한 뒤 다른 work item에서 시작합니다. 파트 조회·선택·이름 수정·정렬은 세션을 옮기지 않습니다.
- 서버는 `project → work_item → user timer` 순서로 잠급니다. 진행 중이며 삭제되지 않은 프로젝트/파트에서만 start/resume을 허용합니다. 활성 세션이 있으면 프로젝트 보류·완료·소프트 삭제, 대상 파트 삭제를 DB 트리거가 거부합니다. 먼저 end 명령을 확정해야 합니다. 프로젝트/파트 복구는 종료한 세션을 재개하거나 시간을 변경하지 않습니다. 삭제된 프로젝트의 과거 세션도 본인은 읽을 수 있고 다른 사용자에게는 RLS로 숨깁니다.
- 일반 계정 카운터에서도 세션을 시작할 수 있습니다. 활성 세션을 가진 일반 계정 work item을 프로젝트에 연결하는 전환은 종료 전까지 차단합니다. 종료 후 전환은 기존 work item과 과거 세션을 보존합니다. 이전 마이그레이션·카운터 RPC·카운터 저장 큐는 변경하지 않습니다.
- `IndexedDbTimerStore`는 별도 `stitchmori-timers-v1` DB의 `sessions`, `events`, `meta`, `server_pending`을 사용합니다. 로컬 세션·이벤트·기기 활성 포인터는 같은 readwrite 트랜잭션으로 저장합니다. 한 브라우저 저장 영역에 미종료 로컬 세션 하나를 허용하며 여러 탭의 시작도 직렬화합니다. 저장 완료 전 성공을 반환하지 않고 저장 실패 시 모두 롤백합니다. 기존 간편 카운터 DB를 업그레이드하지 않습니다. Phase 3B 연결 시 기존 quick record의 안정적인 localWorkItemId를 세션 workItemId로 사용해야 하며 새 카운터를 만들지 않습니다.
- 서버 명령은 `ServerTimerCommands`가 RPC 전 계정별 미확정 봉투 하나를 IndexedDB에 보존합니다. 네트워크/응답 유실 후 재접속하면 `pending()`으로 확인하고 `retry()`를 명시적으로 호출합니다. 읽기만으로 전송하지 않으며 새 명령은 미확정 명령 해결 전 차단합니다. 충돌·거부 결과와 봉투를 자동 삭제·재적용하지 않습니다. 향후 UI가 최신 상태를 확인하고 명시적인 사용자 결정으로 정확한 command ID에 한해 해제해야 합니다. 로그아웃해도 다른 계정의 큐를 삭제하거나 전송하지 않습니다.
- 서버 스냅샷 표시에는 `serverNow`를 기준으로 `createTimerClock(serverNow, performance.now)`처럼 monotonic clock을 연결할 수 있습니다. 새로고침 후 다시 서버 기준점을 읽습니다. 기기 시각의 역행은 로컬 명령을 거부하며 자동 보정하지 않습니다. 임의의 로컬 시계 변경·기기 종료 동안의 실제 작업 여부를 이번 단계에서 판별하지 않습니다.
- 로컬 세션과 서버 세션은 독립적이므로 **동시에 실행되어 중복 시간이 기록될 수 있습니다.** 로그인·로컬 카운터 가져오기·프로젝트 전환은 로컬 타이머를 업로드·종료·이전하지 않습니다. 브라우저 데이터 삭제 시 로컬 세션도 유실될 수 있습니다. 세션 이전과 중복 시간 처리 정책은 후속 단계에서 별도로 정해야 합니다.
- `work_session_time_adjustments`는 추후 확정 시간 정정을 위한 추가 전용 구조입니다. 원래 `accumulated_ms`와 이전/수정 시간, 이유, 명령 ID를 구분합니다. 정정 RPC·정정 UI·복구 결정 명령은 아직 없고 클라이언트 직접 쓰기도 금지합니다. 시각적 타이머/자동 시작 UI는 Phase 3B, 비활동 확인·통계는 Phase 3C 범위입니다.
- 검증: `npx supabase migration up --local`, `npx supabase test db --network-id stitch-mori-local`, `node tests/db/concurrent-work-sessions.mjs`, `node tests/db/work-sessions-http.mjs`, `npm test`. 동시성 스크립트는 고정된 로컬 Docker DB에서 서로 다른 backend PID의 두 연결을 사용하고, 첫 트랜잭션 잠금을 유지한 상태로 두 번째 요청을 실행합니다. 생성한 검증 계정의 데이터만 정리합니다. 온라인 Supabase에는 적용하지 않습니다.
