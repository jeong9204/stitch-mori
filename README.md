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
