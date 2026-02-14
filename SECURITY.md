# Security Audit & Posture (Supabase SQL + Edge Functions)

This project (“SupaClaw”) is a **single-user** agent that runs on Supabase (Postgres, Storage, Cron, Edge Functions) and is primarily accessed via Telegram.

This document is both:
- a **project-specific security audit** of the current repo, and
- a **checklist** mapped to Supabase’s official security guidance (including the `Security` docs and subpages).

## Scope

- **SQL / Postgres**: schema, RLS posture, privilege model, RPC exposure, extensions, Vault usage.
- **Supabase configuration**: Auth signup controls, API exposure assumptions, Security Advisor alignment.
- **Edge Functions**: authentication/authorization, secret handling, webhook hardening, JWT verification configuration.

## Architecture (security-relevant)

- **Ingress**: Telegram sends webhook → `telegram-webhook` Edge Function.
  - Verified via Telegram secret header + allowlist of a single Telegram user id.
- **Persistence**: webhook writes to `public.sessions` + `public.messages`.
- **Work queue**: webhook enqueues a job via DB RPC (`enqueue_job`).
- **Worker**: DB cron calls `agent-worker` Edge Function every minute.
  - Authorized via `x-worker-secret`, delivered from **Supabase Vault** (`vault.decrypted_secrets`) inside SQL.
  - Worker claims jobs via DB RPC (`claim_jobs`) and writes results back.
- **Optional ingress**: `trigger-webhook` Edge Function enqueues jobs.
  - Authorized via either a shared secret or a verified Supabase JWT.

Primary risks in this architecture:
- **Unauthorized invocation** (LLM spend / data modification).
- **Data exfiltration** via the Data API (PostgREST) or RPC.
- **Secret leakage** (service role key, webhook secrets).
- **Misconfiguration drift** (e.g., Edge Function JWT gate toggles).

## What we changed in this repo (applied hardening)

### Database / SQL

Applied to:
- `supabase/schemas/01_schema.sql`
- `supabase/migrations/0000000000000_init.sql`

Changes:
- **Revoked `CREATE` on schema `public` from `PUBLIC`** to reduce schema-poisoning/search_path attacks (recommended Postgres hardening).
- **Enabled RLS on `public.jobs`** (queue table) for defense-in-depth.
- **Revoked `EXECUTE` on internal RPC functions from `PUBLIC` and granted only to `service_role`** to prevent PostgREST RPC abuse.
- **Revoked default `EXECUTE` privileges on future functions** in `public` (for the migration author role), so new functions don’t become callable by default.

Why this matters:
- Supabase exposes functions in exposed schemas as RPC endpoints; PostgreSQL defaults grant `EXECUTE` on functions to `PUBLIC`.
- If an attacker can call `enqueue_job`/`claim_jobs`, they can likely trigger work (and cost) or manipulate processing.
- Least-privilege database permissions provide a strong “blast-radius limiter” even if an API key leaks.

References:
- Supabase “Hardening the Data API”: https://supabase.com/docs/guides/database/hardening-data-api
- Supabase “Securing your API”: https://supabase.com/docs/guides/api/securing-your-api
- Supabase “Row Level Security”: https://supabase.com/docs/guides/database/postgres/row-level-security

### Supabase local config (single-user mode + function auth behavior)

Applied to `supabase/config.toml`:
- **Disabled new user signups**:
  - `[auth].enable_signup = false`
  - `[auth.email].enable_signup = false`
- **Pinned Edge Function JWT verification settings per function**:
  - `telegram-webhook`: `verify_jwt = false` (Telegram can’t send Supabase JWTs)
  - `agent-worker`: `verify_jwt = false` (cron uses `x-worker-secret`)
  - `trigger-webhook`: `verify_jwt = false` (supports shared secret + in-code JWT verification)

Reference:
- Edge Function configuration (`verify_jwt`): https://supabase.com/docs/guides/functions/function-configuration

## Hosted Supabase: disable signups (dashboard setting)

Yes — you can disable signup in the hosted dashboard:
- In **Auth general configuration**, toggle off **“Allow new users to sign up”**. If disabled, only existing users can sign in.

Reference:
- Auth general configuration: https://supabase.com/docs/guides/auth/general-configuration

Self-hosted note:
- Supabase Auth (GoTrue) also supports disabling signup via environment settings (commonly `GOTRUE_DISABLE_SIGNUP=true`), but hosted projects are controlled via the dashboard setting above.

## Audit findings & recommendations (project-specific)

### 1) Data API exposure & RLS posture

Supabase’s Data API exposes the `public` schema by default. Any table accessible via the Data API must have RLS enabled. Supabase explicitly recommends enabling RLS on all exposed tables and using RLS policies for browser/client access.

References:
- RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Hardening the Data API: https://supabase.com/docs/guides/database/hardening-data-api

**This project’s current posture**
- RLS is enabled on all project tables (`sessions`, `files`, `messages`, `memories`, `jobs`).
- There are **no RLS policies** defined, which means:
  - `anon`/`authenticated` cannot read any rows (no `SELECT` policies → no visible rows).
  - `anon`/`authenticated` cannot write (writes will fail under RLS without policies).
  - `service_role` bypasses RLS and is used by Edge Functions.

**Recommendation**
- For a **server-only** / single-user backend (no browser clients), this “RLS enabled, no policies” posture is acceptable and intentionally restrictive.
- If you later add a web UI or client access, you must add explicit policies and revisit table-level grants.

### 2) RPC / SQL functions exposure

Supabase can expose Postgres functions (RPC) via PostgREST. PostgreSQL defaults grant `EXECUTE` on functions to `PUBLIC`.

**This project’s current posture**
- Internal functions (`enqueue_job`, `claim_jobs`, `job_succeed`, `job_fail`, `enqueue_embedding_job`, `hybrid_search`) are now restricted to `service_role` only via explicit `REVOKE`/`GRANT` in the schema posture section.

**Recommendation**
- Keep all “internal” functions **non-callable** by `anon`/`authenticated`.
- If you add a “safe” RPC for a client app, explicitly:
  - `REVOKE EXECUTE ... FROM PUBLIC;`
  - `GRANT EXECUTE ... TO authenticated;`
  - and ensure it doesn’t expose privileged operations or bypass RLS unintentionally.

References:
- Securing your API: https://supabase.com/docs/guides/api/securing-your-api
- Postgres roles overview: https://supabase.com/docs/guides/database/postgres/roles

### 3) Queue security (jobs table)

The queue (`public.jobs`) is a high-risk object because it can cause work to run (and spend money).

**This project’s current posture**
- RLS is enabled on `jobs`.
- RPC access to queue operations is restricted to `service_role`.

**Recommendation**
- Keep queue operations server-side only.
- If you ever allow user writes to `messages`, ensure those writes cannot be used to amplify job creation or trigger expensive behavior without rate limits/quotas.

### 4) Secrets management (Vault + Edge secrets)

Supabase Vault provides encrypted-at-rest secrets and a decrypted view for SQL usage. Anyone with access to `vault.decrypted_secrets` can read secrets, so access should be tightly controlled.

References:
- Vault: https://supabase.com/docs/guides/database/vault

**This project’s current posture**
- Cron uses Vault secrets (`project_url`, `worker_secret`) from SQL.
- Edge Functions use environment secrets set via `supabase secrets set`.

**Recommendations**
- Ensure only admin roles can read `vault.decrypted_secrets` (avoid granting to `anon`/`authenticated`).
- Treat `SUPABASE_SERVICE_ROLE_KEY` as the highest-value secret (it bypasses RLS for DB + Storage).
- Rotate secrets on any suspicion of leakage.

### 5) Storage access control

Storage is governed by RLS policies on `storage.objects`. By default, Storage does not allow uploads to buckets without RLS policies; service keys bypass RLS entirely.

Reference:
- Storage access control: https://supabase.com/docs/guides/storage/security/access-control

**This project’s current posture**
- Bucket `workspace` is created with `public = false`.
- Storage is accessed from Edge Functions via the service role key (bypasses RLS).

**Recommendation**
- If you later add client-side uploads/downloads, add explicit `storage.objects` policies for the least privilege needed.

### 6) Edge Functions authentication & authorization

Supabase Edge Functions require a valid JWT by default. Public webhooks must disable this gate and implement their own verification.

Reference:
- Function configuration: https://supabase.com/docs/guides/functions/function-configuration

**This project’s current posture**
- `telegram-webhook`: validated by Telegram secret header + `TELEGRAM_ALLOWED_USER_ID` allowlist.
- `agent-worker`: validated by `x-worker-secret` header (secret stored in Vault and Edge secrets).
- `trigger-webhook`: validated by Bearer token (shared secret OR Supabase JWT verified against JWKS).

**Recommendations**
- Keep webhook secrets long and random (e.g., 32+ bytes).
- Consider making `trigger-webhook` JWT-only (remove the shared-secret path) if you don’t need backwards compatibility.
- Keep `verify_jwt` settings committed in `supabase/config.toml` to prevent drift between environments.

### 7) Disable signups (single-user requirement)

Supabase explicitly supports disabling new user signups.

Reference:
- General Auth configuration (“Allow new users to sign up”): https://supabase.com/docs/guides/auth/general-configuration

**This project’s current posture**
- Local config now disables signups.

**Recommendations**
- In hosted Supabase, disable signup in the dashboard.
- Disable unused auth providers and features (anonymous sign-ins, manual linking) if you don’t need them.

### 8) Use Security Advisor regularly

Supabase Security Advisor checks for common pitfalls (RLS disabled in public, insecure queues, mutable search_path in security definer functions, exposed auth tables, etc.).

Reference:
- Database advisors (Security Advisor): https://supabase.com/docs/guides/database/database-advisors

**Recommendation**
- Run Security Advisor after any schema change, especially when adding tables/functions or new exposed schemas.

## Supabase Security docs (and subpages): checklist mapping

This section maps Supabase’s Security docs and linked subpages to concrete actions for this repo.

### Supabase Security overview
Reference: https://supabase.com/docs/guides/security
- **Note**: Supabase provides the platform controls; you still configure products correctly.

### Secure configuration of Supabase platform
Reference: https://supabase.com/docs/guides/security/platform-security
- **Apply**:
  - Enable and enforce MFA for your Supabase org/users.
  - Consider Postgres SSL enforcement and Network Restrictions if you use direct DB connections.
  - Review whether you need PrivateLink (enterprise).

### Secure configuration of Supabase products
Reference: https://supabase.com/docs/guides/security/product-security
- **Auth**:
  - Disable signup (done locally; do in dashboard for hosted).
  - Consider CAPTCHA + rate limits if you ever expose auth publicly:
    - CAPTCHA: https://supabase.com/docs/guides/auth/auth-captcha
    - Rate limits: https://supabase.com/docs/guides/auth/rate-limits
  - Consider stronger password requirements:
    - Password security: https://supabase.com/docs/guides/auth/password-security
  - Understand JWT tradeoffs and key types:
    - JWT docs: https://supabase.com/docs/guides/auth/jwts
- **Database**:
  - Keep RLS enabled on all exposed tables (done).
  - Harden Data API exposure (partially done via least-privilege RPC posture):
    - Hardening Data API: https://supabase.com/docs/guides/database/hardening-data-api
    - Securing API: https://supabase.com/docs/guides/api/securing-your-api
  - Use Vault for DB-side secrets (already used):
    - Vault: https://supabase.com/docs/guides/database/vault
- **Storage**:
  - Keep buckets private by default (done).
  - Add RLS policies if clients will access Storage (recommended).

### Security testing of your Supabase projects
Reference: https://supabase.com/docs/guides/security/security-testing
- **Note**: Permitted testing is allowed on your own project; avoid DoS/flooding.

### Platform Audit Logs
Reference: https://supabase.com/docs/guides/security/platform-audit-logs
- **Note**: Available on Team/Enterprise. Use to track changes (members, settings, Edge Functions deploys).

### SOC 2 compliance and HIPAA compliance
References:
- SOC 2: https://supabase.com/docs/guides/security/soc-2-compliance
- HIPAA: https://supabase.com/docs/guides/security/hipaa-compliance
- **Note**: These describe Supabase’s controls and the shared responsibility boundary. Apply only if your use case requires compliance.

### Production checklist & shared responsibility model
References:
- Production checklist: https://supabase.com/docs/guides/deployment/going-into-prod
- Shared responsibility: https://supabase.com/docs/guides/deployment/shared-responsibility-model
- **Apply**:
  - Ensure RLS is always enabled (done).
  - Protect your Supabase account with MFA (recommended).
  - Review rate-limits/abuse protection if you expose endpoints broadly (recommended).

## Operational recommendations (quick list)

- **Keys**:
  - Never expose `SUPABASE_SERVICE_ROLE_KEY` to any client or repo.
  - Prefer new publishable/secret API keys where possible (see JWT docs).
- **Secrets rotation**:
  - Rotate `WORKER_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, `TRIGGER_WEBHOOK_SECRET` periodically or after any suspicion.
- **Monitoring**:
  - Watch Edge Function logs and Postgres logs for unexpected invocation patterns.
- **Backups**:
  - Enable PITR/nightly backups if you care about data durability (see production checklist).

