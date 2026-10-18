# StitchMori

Phase 1A includes a guest quick counter at `/quick`. Projects and server counter sync remain in progress.

## Guest quick counter

Open `/quick` to count stitches and rows without logging in. The browser stores one quick work item, its current counter snapshot, stable work item/import/device IDs, and an append-only event for each accepted change in IndexedDB (`stitchmori-local-v1`). A row completion changes row and stitch values in one command. Undo adds another event. Rapid taps update the screen immediately and enter an ordered, in-memory write queue; the screen shows how many writes are pending. A failed write keeps the queue in this tab and can be retried with the same command IDs. Do not close or reload a tab while it reports an unsaved change: the in-memory queue cannot survive a failed IndexedDB write.

Guest data stays in this browser and is never sent to Supabase by the quick counter. Clearing site data or using a private browsing session can remove it. Importing guest records into an account and syncing multiple devices are later phases.

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

`supabase/migrations/20261018000000_counter_foundation.sql` creates only `work_items`, `counters`, and `counter_events`. It adds FK, CHECK, UNIQUE, indexes, an append-only event trigger, SELECT-only grants and owner-based RLS. Anonymous visitors have no server table access. Direct insert/update/delete is revoked for authenticated clients too. A later phase adds an atomic, authenticated command path and the local-import receipt; until then, server counter records cannot be created through the application.

`supabase start` and `supabase db reset --local` apply this migration only to the local DB. Phase 2 adds projects, parts, 1:1 linkage and soft deletion. Phase 3 adds work sessions.

## Commands

```sh
npm run lint
npm run typecheck
npm run build
npm test
```

DB constraint and RLS tests run against the local database with `npx supabase test db --network-id stitch-mori-local`; they do not contact a hosted project. The network flag is needed because this project starts the stack on its own localhost-bound network. The app test command covers counter rules and IndexedDB persistence with an in-memory IndexedDB implementation.

## Data boundary

- `src/domain` contains framework-independent work item and counter contracts.
- `src/data/local` implements the guest IndexedDB store with atomic snapshot/event writes.
- `src/data/import` defines stable import IDs and server receipts, so a retry cannot overwrite an account record or delete the local original before acknowledgment.
- `src/data/remote` and `src/data/sync` define future server access and sync boundaries.
- `src/app` contains web routes. A future native shell can use the same domain rules and reusable UI without matching web URLs.
