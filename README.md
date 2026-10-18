# StitchMori

Phase 0 foundation for StitchMori. The quick counter and project features are visibly marked as in progress; no counter data can be saved through the UI yet.

## Local setup

1. Run `npm install`.
2. Copy `.env.example` to `.env.local` and fill in the Supabase project URL and **publishable** key from the Supabase project Connect dialog. Never put a service role or secret key in `NEXT_PUBLIC_*` variables.
3. Run `npm run dev`, then open `http://localhost:3000`.

Without `.env.local`, the home and preparation pages still render, while email login is unavailable. Set the public Supabase variables **before building** for deployment, because Next.js embeds them in the browser bundle. The migration is a local file only; it is not automatically applied to a remote database.

## Email code setup

In Supabase Dashboard, enable the Email provider under **Authentication → Sign In / Providers**. Under **Authentication → Email Templates → Magic Link**, replace the link content with the code variable, for example:

```html
<h2>StitchMori 로그인 코드</h2>
<p>인증 코드: {{ .Token }}</p>
```

The code input uses `signInWithOtp({ email })` and `verifyOtp({ email, token, type: 'email' })`. Supabase sends a link if the template contains `{{ .ConfirmationURL }}` instead of `{{ .Token }}`. Set the site URL to the app's URL under Authentication URL settings. For production email delivery, configure an appropriate SMTP sender and review Auth rate limits. See the [Supabase OTP guide](https://supabase.com/docs/guides/auth/auth-email-passwordless) and [email template guide](https://supabase.com/docs/guides/auth/auth-email-templates).

## Database migration

`supabase/migrations/20261018000000_counter_foundation.sql` creates only `work_items`, `counters`, and `counter_events`. It adds FK, CHECK, UNIQUE, indexes, an append-only event trigger, SELECT-only grants and owner-based RLS. Anonymous visitors have no server table access. Direct insert/update/delete is revoked for authenticated clients too. Phase 1 adds an atomic, authenticated command path and the local-import receipt; until then, server counter records cannot be created through the application.

The migration is **not** applied automatically. Apply it only to a dedicated local or test Supabase instance for validation before any reviewed deployment. Phase 2 adds projects, parts, 1:1 linkage and soft deletion. Phase 3 adds work sessions.

## Commands

```sh
npm run lint
npm run typecheck
npm run build
npm test
```

DB constraint and RLS integration tests require an isolated Supabase/PostgreSQL test environment with at least two Auth users. The app test command covers TypeScript domain contracts only; it does not claim to validate SQL permissions.

## Data boundary

- `src/domain` contains framework-independent work item and counter contracts.
- `src/data/local` defines the future IndexedDB store interface.
- `src/data/import` defines stable import IDs and server receipts, so a retry cannot overwrite an account record or delete the local original before acknowledgment.
- `src/data/remote` and `src/data/sync` define Phase 1 access and status boundaries.
- `src/app` contains web routes. A future native shell can use the same domain rules and reusable UI without matching web URLs.
