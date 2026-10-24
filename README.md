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

### Phase 3B — 타이머 UI 및 자동 시작

- 간편·계정·프로젝트 파트 카운터의 조작 버튼 아래에 타이머를 표시합니다. HH:MM은 timestamp와 누적 ms에서 계산하며 화면 갱신 횟수를 저장하지 않습니다. 종료에는 확인창이 필요하고 종료 세션은 새 세션으로만 다시 시작합니다.
- 기본은 수동입니다. 로컬 시작 방식은 별도 타이머 IndexedDB의 work-item별 meta에, 계정 설정은 `work_timer_preferences`에 저장합니다. 설정 RPC는 revision 충돌을 검사하며 설정 당시 카운터 revision을 자동 시작 경계로 기록합니다. 설정은 저장·재조회 성공 후 표시하고 실패 시 기존 확인 값을 유지합니다. 기존 마이그레이션과 카운터·세션 명령 RPC 계약은 변경하지 않습니다.
- 자동 시작은 카운터 저장 큐의 영속 저장/서버 확정 콜백에서만 요청합니다. 실제 코수·단수가 바뀐 증가·감소·직접 수정·실행 취소가 대상이며 목표 수정, 같은 값, 탭 전환, 모달 취소는 제외합니다. paused는 자동 재개하지 않으며 ended 다음 유효 변경은 새 세션을 시작합니다.
- 카운터 확정과 타이머 시작은 별도 트랜잭션입니다. 타이머 실패가 저장된 카운트를 취소하지 않습니다. 자동 시작의 command/session ID는 확정된 카운터 command ID를 사용하며, 미확정 봉투를 보관하고 같은 봉투로 명시적으로 재시도합니다. 카운터 확정 후 타이머 요청을 영속 보관하기 전 탭이 종료되면 자동 시작이 누락될 수 있습니다. 과거 이력을 임의 재생하지 않으며 다음 유효 카운트 또는 수동 시작을 사용합니다. 요청 자체의 로컬 보관 실패는 페이지 이탈 시 유실 위험으로 안내합니다.
- 오프라인 pause/end는 마지막 서버 확인 상태를 유지합니다. 서버 최초 적용 시각까지 running 시간이 계속 늘어나 실제 작업보다 길게 기록될 수 있습니다. 응답 유실 재시도는 최초 결과를 재사용합니다. 미확정 요청의 보관 해제는 확인 후 해당 outbox 항목만 해제하며 서버 요청 취소가 아닙니다. 자동 폐기·자동 revision 변경·자동 병합은 하지 않습니다.
- 복원은 상태와 보관 요청을 읽기만 하며 전송은 사용자 재시도로 진행합니다. 로그아웃 시 계정별 메모리 컨트롤러를 폐기하고 IndexedDB의 다른 계정 요청은 유지합니다. 로컬/서버 세션은 독립적으로 병행될 수 있으며 로그인·가져오기 시 세션을 이전하지 않습니다. 다른 기기의 상태·설정은 포커스 복귀/최신 상태 확인 시 다시 조회합니다. Realtime·비활동 알림·시간 정정은 포함하지 않습니다.

### Phase 3C — 비활동 확인 및 작업 시간 통계

- running 세션의 마지막 유효 카운트 이후 30분에 브라우저 내부 확인창을 표시합니다. 카운트가 없으면 세션 시작 시각을 사용합니다. 목표 수정·탭 전환·단 완료 모달 열기/취소·같은 값 저장은 활동이 아닙니다. paused/ended에는 알림이 없고 자동 일시정지하지 않습니다. 재개만으로 비활동 구간을 초기화하지 않습니다.
- **계속 작업**은 기준 시각을 갱신하고, **나중에**와 Escape는 해당 구간만 닫습니다. **잠시 일시정지**는 선택 저장 후 기존 pause 명령을 요청합니다. 실패·충돌 시 기존 타이머 카드의 미확정 명령과 동일 ID 재시도를 사용합니다. 확인창 선택이 타이머의 pause 성공을 의미하지 않습니다.
- 표시 전 영속 claim을 저장합니다. 로컬은 타이머 IndexedDB `meta`의 session별 activity 기록을 readwrite 트랜잭션으로 갱신하고, 계정은 `work_session_activity`와 `ack_work_inactivity`의 세션 잠금으로 같은 구간의 중복 표시를 차단합니다. 새로고침으로도 같은 구간을 다시 열지 않으므로, 표시 직후 페이지를 닫았다면 해당 구간은 확인한 것으로 남습니다. claim 저장 실패는 알림을 반복 열지 않고 오류를 표시하며 이후 확인을 재시도합니다.
- 서버의 유효 카운트 시각은 `work_item_activity`에 별도로 기록합니다. 신규 after-insert 트리거가 실제 코수/단수가 바뀐 이벤트만 같은 카운터 트랜잭션에서 기록합니다. 기존 `counter_events.created_at`의 트랜잭션 시작 시각과 실제 확정 순서가 어긋나는 경우를 방지합니다. 기존 이벤트는 변경하지 않고 활동 메타데이터가 없는 과거 기록은 기존 이벤트 시각을 사용합니다. 로컬은 저장된 이벤트 발생 시각을 읽습니다. 메타데이터는 소프트 삭제로 지워지지 않습니다. 물리 삭제 시 파생 활동 메타데이터만 cascade하며 원본 세션·카운터 이벤트의 삭제 제한은 유지합니다.
- 알림은 해당 작업 카운터 화면의 foreground에서 15초 간격과 포커스/visibility 복귀 시 확인합니다. 다른 파트로 이동해도 원래 세션의 기록은 보존되며, 해당 작업으로 돌아오면 다시 판정합니다. 서버에서 종료·일시정지되거나 새 활동이 생긴 오래된 확인창은 다시 조회하여 닫습니다. 브라우저 종료·백그라운드 전달·푸시 알림은 보장하지 않습니다. 로그아웃하면 계정 컨트롤러와 화면을 숨기고 타 계정의 활동을 조회하지 않습니다.
- 홈에 로컬/계정 오늘 시간과 최근 세션을 분리 표시하고, 프로젝트 상세에는 프로젝트 및 파트별 합계, 계정/파트 카운터에는 해당 작업의 시간과 최근 완료 세션을 표시합니다. 로컬과 서버 시간이 겹칠 수 있으므로 둘을 합산하지 않습니다. 별도 session ID는 별도 실제 기록으로 집계하며 같은 session/event ID는 중복 합산하지 않습니다.
- 계정 통계는 **Asia/Seoul** 기준으로 고정하며 화면에 날짜·시간대를 표시합니다. 로컬은 브라우저 IANA 시간대를 사용합니다. 순수 함수는 일별 경계와 작업 구간의 교집합을 계산하고 DST의 23/25시간 날짜도 처리합니다. 서버는 PostgreSQL `AT TIME ZONE`으로 같은 경계를 계산합니다. 자정을 넘긴 세션은 분할하고 pause→resume 구간은 제외합니다. 사용자별 시간대 설정 UI는 없습니다.
- `get_work_time_statistics`는 owner 검증, 프로젝트/work-item 필터와 완료 세션 20개씩 페이지 조회를 제공합니다. 이벤트 원문을 내려보내지 않고 DB에서 start/resume→다음 전이의 구간을 합산합니다. 진행 중 구간은 serverNow+monotonic clock으로 갱신한 **예상값**이고 저장된 누적과 분리합니다. 미확정 pause/end, 조회 실패에는 마지막 확인 값/지연 가능성을 표시합니다. 포커스 복귀·15초 조회 또는 명시적 새로고침으로 상태를 갱신하며 Realtime은 사용하지 않습니다. 자정 직후에는 이전 날짜의 오늘 합계를 숨기고 다음 조회로 갱신합니다.
- 삭제된 프로젝트·파트의 과거 시간은 본인 통계에 포함하고 삭제 표시를 붙입니다. 복구로 시간을 복제하거나 재집계하지 않습니다. 해당 프로젝트/파트 카운터 접근 차단은 유지합니다. 기존 타이머 엔진·카운터 엔진·명령 RPC·영속 명령 큐 및 이전 마이그레이션은 변경하지 않습니다.
- 로컬 검증: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npx supabase test db --network-id stitch-mori-local`, `node tests/db/timer-statistics-http.mjs`, 기존 `concurrent-work-sessions.mjs`/`work-sessions-http.mjs`. HTTP 테스트는 로컬 Supabase만 허용하고 생성한 임시 계정과 기록을 정리합니다. Chrome의 30분 확인창 검증에는 별도 로컬 테스트 계정의 과거 세션 fixture를 사용하며 운영 기록에 예시 데이터를 넣지 않습니다.

### Phase 3D-1 — 종료 세션 시간 정정

- 종료된 세션만 정정합니다. running/paused 세션은 먼저 종료해야 합니다. 정정은 `work_session_time_adjustments`에 추가하며 원본 누적 시간·세션 revision·시작/정지 이벤트를 덮어쓰지 않습니다. 마지막 정정값을 유효 시간으로 사용하고 원본과 적용 시간을 함께 표시합니다. 사유는 선택이며 감사 이력에는 요청 ID, 수행 사용자, 서버 시각, 전후 시간과 별도의 정정 revision이 남습니다.
- `adjust_work_session_time`은 인증·소유권·종료 상태·정정 revision을 검증하고 같은 요청 봉투 재전송에는 기존 영수증을 반환합니다. 같은 revision의 다른 요청은 충돌합니다. 삭제된 프로젝트/파트는 이력 조회만 가능하며 복구 후 정정할 수 있습니다. 보류·완료 프로젝트의 종료 세션은 정정할 수 있습니다. 클라이언트 직접 쓰기와 기존 이력 수정은 금지합니다.
- 누적·프로젝트·파트 통계는 마지막 유효 시간을 한 번만 합산합니다. **일별 시간은 실제 작업 시각의 재구성이 아닌 추정 배분**입니다. 원래 일시정지 제외 작업 구간의 날짜별 비중으로 정정 총 시간을 배분하며 누적 경계의 정수 내림 차이로 밀리초 합계를 보존합니다. 원본 작업 시간이 0이면 종료일에 전부 배정합니다. 서버 날짜는 `Asia/Seoul`, 로컬은 브라우저 시간대를 사용합니다. 실제 구간별 시간 편집은 지원하지 않습니다.
- 타이머 IndexedDB 이름은 유지하고 스키마만 v2로 올려 `adjustments`, `adjustment_pending`을 추가합니다. 기존 세션·이벤트·설정·서버 타이머 명령 큐와 카운터 DB는 유지합니다. 이전 버전 탭은 연결 종료 후 새로고침이 필요할 수 있습니다. 신규 SQL은 기존 감사 값은 유지하며 정정 순서 메타데이터만 보충하고, 불명확한 과거 이력은 적용을 중단합니다.
- 정정 요청은 로컬/계정별·세션별 별도 영속 대기함에 먼저 보관합니다. 실패·응답 유실은 동일 요청 ID로 재시도하며 새로고침 후 홈에서 보관된 요청을 확인합니다. 충돌은 자동 재적용·폐기하지 않습니다. 최신 이력 확인 후 명시적으로 보관 해제하고 새 요청을 작성할 수 있으며, 보관 해제는 이미 전송된 서버 요청의 취소가 아닙니다. 정정 입력값은 실패 후에도 유지합니다. IndexedDB 자체 저장 실패 시 메모리 요청을 유지하고 페이지 이탈 유실 위험을 경고합니다. 로컬 보관 확인 전에는 정정창 닫기·Escape를 제한하여 재시도 전 요청이 사라지지 않도록 합니다.
- 로컬 세션 정정은 계정으로 업로드하지 않습니다. 실행 중 시간 편집, 자동 종료, 원본 작업 구간 재배치, Realtime 동기화는 포함하지 않습니다.
- 검증: `npm test`, `npx supabase test db --network-id stitch-mori-local`, `node tests/db/work-time-adjustments-http.mjs`. HTTP 검증은 로컬 주소만 허용하며 임시 검증 계정의 데이터만 정리합니다. 온라인 Supabase에는 적용하지 않습니다.

### Phase 3D-2 — 로컬 타이머 세션 계정 가져오기

- `/import`의 별도 **작업 시간 가져오기**에서 명시적으로 실행합니다. 로그인·카운터 가져오기·프로젝트 전환만으로 타이머를 업로드하지 않습니다. 카운터 미연결이면 기존 카운터 가져오기를 먼저 완료하고, `counter_imports`의 본인 영수증이 가리키는 work item으로만 연결합니다. 이미 가져온 카운터/프로젝트 파트는 같은 ID를 재사용합니다. 임의의 프로젝트를 선택하지 않습니다.
- 종료된 세션만 대상으로 합니다. 해당 로컬 작업에 running/paused가 있으면 먼저 종료해야 합니다. 카운터·타이머·정정 미확정 요청과 열린 탭의 메모리 요청을 확인하고, 타이머 IndexedDB를 v3로 올리되 기존 저장소·원본을 유지합니다. 버전 전환으로 이전 탭의 연결을 닫으므로 오래 열린 탭은 새로고침해야 합니다. 한 트랜잭션에서 세션·이벤트·정정 스냅샷과 안정적인 import ID를 보관합니다. 보관된 스냅샷은 실패·재접속에도 재사용하며 완료 전 해당 작업의 로컬 타이머 생성·정정을 제한합니다. 카운터 저장 큐나 기존 서버 타이머 큐를 삭제하지 않습니다.
- 서버 `import_timer_snapshot`은 전체 묶음을 하나의 트랜잭션으로 적용합니다. 한 번에 최대 50개 세션, 이벤트+정정 5000건을 검증합니다. 중간 오류는 세션·이벤트·정정·영수증 전체를 롤백합니다. 카운터 가져오기는 별도 트랜잭션이므로 타이머 실패 시 먼저 생성된 카운터는 유지하고 다음 재시도에서 재사용합니다.
- `timer_imports`는 사용자+import ID별 불변 스냅샷과 결과를, `timer_import_sessions`는 사용자+로컬 세션 ID별 유일한 서버 세션 매핑과 원본 묶음을 보관합니다. 같은 import ID의 다른 내용은 거부합니다. 다른 import ID로 이미 가져온 동일 세션을 보내도 기존 매핑을 반환하며 새 시간을 더하지 않습니다. 로컬 세션 UUID는 서버 전체에서 한 계정에만 연결되므로 다른 계정으로 재전송해도 복제할 수 없습니다. 서버에서 세션에 후속 정정을 해도 가져오기 재시도가 이를 덮어쓰지 않습니다.
- 서버 세션·이벤트·정정 ID는 새 UUID입니다. 원본 시각·이벤트 순서·원본 누적 시간·정정 전후 시간·사유·시각·순서는 유지하고 전체 원본 JSON에서 원래 ID와 기기 수행자(null)를 확인할 수 있습니다. 가져온 정정은 `source_local_adjustment_id`로 표시합니다. 서버는 원래 시각으로 상태 전이를 재검증하며 현재 시각의 타이머 명령 RPC를 재생하지 않습니다. 종료 세션만 삽입하므로 현재 활성 서버 세션을 시작·종료하거나 활성 세션 한 개 제약을 우회하지 않습니다.
- 기존 최신 정정 통계와 날짜별 비중 추정 배분을 그대로 사용합니다. 서버 날짜는 Asia/Seoul입니다. 계정 세션 목록에는 로컬 출처를 표시하고 가져오기 화면에서 기존 서버 시간과 겹칠 수 있음을 안내합니다. 겹치는 세션을 자동 병합하거나 제거하지 않습니다. 로컬과 계정 통계는 별개이며 합산하지 않습니다.
- 서버 성공을 확인하고 로컬 영수증까지 저장한 뒤 완료 표시합니다. 로컬 확인 저장 실패·응답 유실은 같은 스냅샷으로 재시도합니다. 완료 저장 시 원본을 다시 대조하고, 예상 밖 원본 변경은 원본·스냅샷을 보존한 채 완료 확인을 중단합니다. 이 경우 이미 서버에 보관된 스냅샷을 확인해야 하며 변경분을 자동 병합하지 않습니다. 원본은 삭제하지 않고 매핑을 누적 보관합니다. 가져온 로컬 세션은 정정 잠금을 유지하며 이후 정정은 계정에서 합니다. 이후 새 로컬 세션은 별도 묶음으로 가져올 수 있습니다. 가져오기 후 변경을 실시간 동기화하지 않습니다.
- 삭제된 프로젝트/파트에는 새 가져오기를 거부합니다. 복구 후 같은 요청으로 재시도할 수 있습니다. 이미 확정된 영수증 재조회는 삭제 상태에서도 중복 응답을 돌려줍니다. 보류·완료 프로젝트에는 과거 종료 세션 가져오기를 허용하며 새 타이머 시작 정책은 바꾸지 않습니다. 테이블은 본인 조회만 허용하고 RPC만 쓰기 가능합니다.
- 검증: `npm test`, `npx supabase test db --network-id stitch-mori-local`, `node tests/db/timer-imports-http.mjs`. 테스트는 로컬 Supabase만 사용합니다. 온라인 프로젝트에 마이그레이션을 적용하지 않습니다.

## Phase 3E — 프로젝트 대표 사진 (로컬 개발)

- 프로젝트당 대표 사진 1장입니다. 목록은 4:3, 상세는 높이를 제한한 가로형 대표 사진과 사진 관리 메뉴로 표시하며 원본 비율과 무관하게 카드 크기를 유지합니다. 사진이 없거나 로딩에 실패하면 플레이스홀더와 재조회 동작을 제공합니다.
- `supabase/config.toml`의 로컬 Storage를 활성화했습니다. 기존 환경은 `npx supabase stop`(기본 백업 보존) 후 `npx supabase start --network-id stitch-mori-local`, `npx supabase migration up --local` 순서로 적용합니다. `db reset`, `--no-backup`, 원격 `db push`는 필요하지 않습니다.
- `.env.local`에는 기존 로컬 URL/공개 키와 함께 `SUPABASE_SERVICE_ROLE_KEY`를 설정합니다. `npx supabase status`에 표시되는 **로컬** service-role 키를 사용하세요. 서버 재시작이 필요합니다. `.env.example`에는 자리표시자만 있습니다. 이 키에는 `NEXT_PUBLIC_` 접두사를 붙이지 않으며 Git에 추가하지 않습니다. 클라우드 프로젝트 연결은 하지 않습니다.
- 서버 전용 키가 필요한 이유: 브라우저의 Storage 쓰기를 막고, 인증·소유권 검사를 마친 Next.js Node 서버에서 실제 이미지 디코딩을 수행한 결과만 업로드하기 위해서입니다. 서버는 요청의 Origin과 Host를 비교합니다. 배포용 프록시는 실제 외부 Host를 보존해야 합니다.

### 저장·검증·권한

`project-photos`는 private bucket입니다. 업로드 입력은 JPEG/PNG/WebP, 최대 10MiB이며 실제 스트림 바이트 수를 제한합니다. Next proxy의 본문 상한은 12MB로 두어 Content-Length 없는 초과 입력도 사진 API의 10MiB 제한에 도달해 거부되도록 했습니다(사진 허용 크기는 늘리지 않습니다). 확장자나 Content-Type 선언으로 형식을 결정하지 않습니다. Sharp가 실제 디코딩, 최대 4천만 입력 픽셀 제한, 단일 프레임 검증, EXIF 방향 보정, 긴 변 1600px 이내 축소, WebP 변환(quality 82)을 수행합니다. 결과에는 원본 EXIF·위치 정보·ICC 메타데이터를 복사하지 않습니다. 원본 파일은 서버 Storage에 저장하지 않습니다. bucket도 최대 10MiB 및 WebP 형식을 제한합니다.

- `project_photos`: 프로젝트·소유자·고유 객체 경로·출력 크기/해상도·SHA-256·보관/정리 시각.
- `projects.cover_photo_id`: 소유권을 포함한 복합 FK로 현재 사진 하나를 가리킵니다. 사진 경로는 `userId/projectId/photoId.webp`입니다. 파일 바이트나 공개 URL은 DB에 저장하지 않습니다.
- `project_photo_changes`: 사용자별 request ID, 입력/결과 해시, expected project revision, 처리 상태, 확정 영수증. 기존 프로젝트 RPC 계약과 마이그레이션은 유지합니다.
- 인증 사용자는 현재 본인 프로젝트의 현재 사진만 RLS를 통해 읽습니다. 사진 메타데이터 및 Storage 객체의 직접 INSERT/UPDATE/DELETE는 허용하지 않습니다. 사진 변경 RPC는 `service_role` 전용이며 전달된 사용자와 프로젝트 소유권도 검증합니다. API는 검증된 로그인 사용자 ID만 전달합니다.
- 이미지 표시 API는 매번 로그인·프로젝트 소유권·현재 photo ID를 확인하고 private/no-store 바이너리를 반환합니다. 장기 공개 URL이나 signed URL을 발급·저장하지 않으므로 signed URL 만료 갱신은 필요하지 않습니다. 인증 만료·연결 실패 시 재로그인/사진 최신 상태 확인으로 다시 조회합니다. Next 이미지 최적화 캐시에 비공개 사진을 넣지 않습니다.
- 향후 갤러리는 별도 사진 역할/정렬 관계를 확장할 수 있습니다. 이번 구현에는 갤러리·사진 파일 오프라인 큐가 없습니다.

### 교체·삭제·재시도 순서

1. 서버에서 입력을 검증하고 최적화합니다. 안정적인 request ID와 입력/결과 해시로 후보 경로를 예약합니다. 이 시점에는 기존 사진과 프로젝트 revision이 바뀌지 않습니다.
2. 새 경로에 `upsert: false`로 업로드합니다. 응답이 유실됐거나 같은 요청이 겹치면 해당 객체의 실제 SHA-256을 확인한 뒤 계속합니다. 다른 바이트로 기존 경로를 덮어쓰지 않습니다.
3. 프로젝트와 요청을 잠그고 expected revision을 검사합니다. Storage 객체 존재와 출력 메타데이터를 확인한 뒤 현재 연결·프로젝트 revision·영수증을 한 DB 트랜잭션에서 확정합니다. 동시 교체 중 하나만 확정되며 충돌은 자동 덮어쓰기하지 않습니다. 오래된 확정 요청의 재시도는 기존 영수증을 반환합니다.
4. 확정 후에만 이전 사진을 Storage API로 정리합니다. 정리 실패는 별도 `정리 필요` 상태와 재시도 버튼으로 안내하며 현재 사진/확정 결과를 되돌리지 않습니다. DB에서 Storage 객체 행만 직접 삭제하지 않습니다.
5. 사진 삭제도 먼저 DB 연결 해제와 영수증을 확정한 뒤 파일을 정리합니다. 프로젝트 자체는 유지됩니다. 프로젝트 소프트 삭제는 현재 사진을 정리하지 않으며 복구 시 같은 사진 연결을 유지합니다. 삭제된 프로젝트에서는 일반 사진 조회·변경을 차단합니다.

요청 ID/expected revision/동작/파일명만 계정·프로젝트별 localStorage 복구 영수증에 보관합니다. 사진 파일은 저장하지 않습니다. 저장 확인이 불분명하면 같은 파일·같은 요청으로 재시도합니다. 페이지를 다시 열면 서버 영수증을 확인해 이미 확정된 요청을 중복 업로드하지 않고 완료 표시합니다. 미확정 업로드는 같은 파일을 다시 선택해야 할 수 있습니다. 요청 복구 정보 저장에 실패하면 업로드를 시작하지 않습니다. 미확정 상태에서는 페이지 이탈 경고를 제공합니다. 취소는 서버에서 미확정 요청만 포기하며 이미 확정된 결과는 유지합니다.

정리 정책: 후보 업로드가 열린 탭 종료 등으로 남으면 24시간 후 정리 대상으로 전환합니다. 충돌·취소된 후보는 늦게 도착한 업로드와의 경합을 피하기 위해 최소 15분 뒤 정리합니다. 정리는 다음 사진 변경 또는 상세 화면의 `이전 파일 정리 재시도`에서 수행하며, 현재 연결된 사진은 언제나 제외합니다. **자동 주기 정리 작업은 이번 범위에 없습니다.** 장기간 사진을 관리하지 않는 프로젝트의 후보 파일은 관리 재시도 전까지 남을 수 있습니다. 향후 서버 청소 작업은 같은 후보 조회/확인 계약을 재사용하면 됩니다.

네트워크 연결이 없으면 업로드 완료로 표시하지 않습니다. 파일·요청을 현재 화면에서 유지하고 연결 후 명시적으로 재시도하도록 안내합니다. 새로고침 후 파일 자체의 자동 복원이나 오프라인 자동 업로드는 지원하지 않습니다. 다른 탭의 편집은 서버 project revision으로 보호합니다.

### 검증 명령

```sh
npm run lint
npm run typecheck
npm test
npm run build
npx supabase test db --network-id stitch-mori-local
# 별도 터미널에서 localhost 대신 127.0.0.1의 검증용 앱을 실행한 뒤:
npm run start -- --hostname 127.0.0.1 --port 3001
# 다른 터미널:
node tests/db/project-photos-http.mjs
```

HTTP 테스트는 로컬 Supabase/앱 주소만 허용하며 별도 OTP 테스트 사용자로 실제 Storage 업로드, 동시 교체, 응답 유실 재전송, private 읽기/직접 쓰기 차단, 잘못된 이미지·크기, 프로젝트 삭제/복구를 검증합니다. 생성한 테스트 객체와 테스트 사용자 데이터만 종료 시 정리합니다. 기존 사용자 프로젝트는 변경하지 않습니다.

Phase 3E 변경 파일(기존 `next-env.d.ts` 변경 제외):

- UI: `src/components/project-cover-photo.tsx`, `src/components/project-manager.tsx`, `src/components/project-detail-view.tsx`, `src/app/globals.css`
- 사진 API: `src/app/api/projects/[projectId]/photo/route.ts`, `photo/image/route.ts`, `photo/cancel/route.ts`, `photo/cleanup/route.ts`
- 사진 데이터/서버 처리: `src/data/photos/client.ts`, `src/data/photos/photo-service.ts`, `src/lib/photos/image.ts`, `src/lib/photos/requests.ts`, `src/lib/photos/server.ts`
- DB/검증: `supabase/migrations/20261024000001_project_photos.sql`, `supabase/tests/project_photos_test.sql`, `tests/data/project-photos.test.ts`, `tests/db/project-photos-http.mjs`
- 구성/문서: `supabase/config.toml`, `next.config.ts`, `.env.example`, `package.json`, `package-lock.json`, `README.md`

## Phase 3F-1: 수동 프로젝트 진행률·파트 상태 (UI 미연결)

- `projects.progress_percent`: nullable integer, 기본값 `null`(미설정), 0~100. `null`과 0을 구분합니다. 프로젝트 완료 여부와 자동 동기화하거나 카운터/파트 상태로 계산하지 않습니다.
- `project_parts.status`: `not_started | in_progress | paused | completed`. 기존 파트와 새 기본/추가 파트 모두 `not_started`가 기본입니다. 기존 카운터 이력으로 상태를 추론하지 않습니다.
- 파트 상태는 수동 메타데이터입니다. 상태 변경은 코수·단수·목표·이벤트·타이머·게이지·사진에 영향을 주지 않으며, 카운터 실행 취소의 대상도 아닙니다. 카운팅/타이머 시작 권한은 기존 **프로젝트 상태** 정책을 따릅니다.
- 기존 이름 변경/파트 관리와 같이 보류·완료 프로젝트에서도 진행률·파트 상태를 수정할 수 있습니다. 프로젝트가 보류/완료이면 기존 카운팅 및 타이머 시작 제한은 그대로 유지합니다. 삭제된 프로젝트/파트에는 새 변경을 적용하지 않습니다. 소프트 삭제·복구는 값과 ID를 보존하며, 기본 파트 삭제 금지 정책도 유지합니다.

### 저장·조회 계약과 Phase 3F-2 연결

순수 도메인 계약은 `src/domain/project/tracking.ts`, 저장소는 `src/data/projects/project-tracking-store.ts`입니다. 새 RPC `apply_project_tracking_command(p_project_id, p_request_id, p_expected_revision, p_action)`는 다음 명령을 받습니다.

```ts
// 동일 명령 재시도 시 requestId, expectedRevision, action을 모두 유지합니다.
{ projectId, requestId, expectedRevision, action: { type: "setProgress", value: 50 } }
{ projectId, requestId, expectedRevision, action: { type: "setProgress", value: null } }
{ projectId, requestId, expectedRevision, action: { type: "setPartStatus", partId, status: "in_progress" } }
```

- `ProjectTrackingStore.apply()` 결과: `applied | unchanged | duplicate`와 `projectRevision`, `projectId`, 변경 전후 `change`; 충돌은 `conflict`와 `latestRevision`입니다.
- 프로젝트 행 잠금과 **기존 공유 project revision**으로 진행률·파트 상태 및 다른 프로젝트 편집 간 충돌을 검사합니다. 값이 같으면 `unchanged` 영수증을 남기고 revision/수정 시각은 올리지 않습니다. stale revision은 값이 같아도 충돌입니다.
- 기존 `project_part_commands`의 계정별 request ID 공간과 advisory lock을 재사용합니다. 기존 파트 명령과도 ID를 공유하므로 다른 내용에 같은 request ID를 사용하면 거부합니다. 정확한 재전송에는 최초 결과를 반환하며 이후 변경/삭제 상태를 덮어쓰지 않습니다. 영수증에는 요청과 변경 전후 값·결과·서버 시각이 남습니다. 사용자용 활동 로그 UI는 이번 범위가 아닙니다.
- DB integer 범위 CHECK 및 part status CHECK, TypeScript 입력 검사와 RPC JSON 수치 검증을 함께 적용합니다. 특히 소수는 integer 캐스트로 반올림되기 **전에** 거부합니다. 기존 테이블 RLS/직접 쓰기 제한을 그대로 유지합니다.
- 프로젝트 목록 `Project.progressPercent`, 상세 `ProjectDetail.progressPercent`, 파트 `ProjectPart.status`에 확정값을 제공합니다. 기존 create/update/delete 프로젝트 응답에도 `progressPercent`를 추가했습니다. 필드가 없는 과거 응답은 미설정/null 및 not_started로 읽지만 잘못된 값은 오류로 처리합니다. DB 마이그레이션 적용이 먼저 필요합니다.
- Phase 3F-2에서는 동일 명령 객체를 오류 시 보존하고, 성공 후 목록/상세를 다시 조회하도록 연결해야 합니다. `conflict`를 자동 덮어쓰기하거나 자동 재적용하지 않습니다. 이번에는 새 IndexedDB 큐나 UI/자동 재시도를 추가하지 않았습니다.

로컬 검증:

```sh
npx supabase migration up --local
npx supabase test db --network-id stitch-mori-local
node tests/db/project-tracking-http.mjs
npm run lint
npm run typecheck
npm test
npm run build
```

HTTP 검증은 로컬 주소만 허용하고 별도 OTP 테스트 사용자로 동일 명령 동시 전송, 응답 유실 재전송, 서로 다른 명령의 revision 충돌, 기존 편집 명령과의 충돌, RLS/소유권 및 삭제·복구를 검증합니다. 온라인 Supabase에는 적용하지 않습니다.
