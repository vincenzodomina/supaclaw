### PRD: External CLI Runner (SupaClaw Compute Node)

### Overview
SupaClaw needs a way to run **real CLI tools** (e.g., `office-to-png`, `git`, `gh`, `npx`, other workflows) in an environment **outside Supabase Edge Functions**, while still keeping Supabase as the **system of record** (Storage + Postgres) and minimizing additional infrastructure.

This feature introduces an **External CLI Runner**: a long-running process (often a single Docker container) that:
- receives “run this command” requests from Supabase (push-triggered, no inbound ports required),
- downloads the required workspace inputs from Supabase Storage,
- executes the CLI,
- uploads outputs/artifacts/logs back to Supabase Storage,
- updates job state in Postgres.

### Problem Statement
Supabase Edge Functions cannot run heavyweight or native CLIs (LibreOffice, PDFium wrappers, `git`, `gh`, `npx` toolchains) reliably. SupaClaw needs:
- **true document rendering** (Office/PDF → PNG pages) as a prerequisite for OCR,
- a general pattern for future CLI workloads,
- low-latency execution without introducing a public conversion API,
- persistent outputs that the agent can read via existing tools (`read_file`) and reference across turns.

### Goals
- **Run native CLIs** in a controlled environment that can be deployed by end users.
- **Lowest-infrastructure**: avoid a public HTTP service; keep Supabase as the backbone.
- **Push-triggered execution**: avoid polling where possible by using Postgres/Supabase-native triggers (Realtime, LISTEN/NOTIFY, cron/extensions).
- **Deterministic persistence**: inputs/outputs live in Supabase Storage + DB, traceable and durable.
- **Security-first**: strict allowlisting and isolation so the agent cannot execute arbitrary destructive commands by default.
- **Lean codebase**: small number of new components and minimal new code.

### Non-Goals
- Full interactive terminal sessions (TTY) inside chat (deferred).
- Arbitrary “run any command as root” execution (explicitly disallowed).
- Replacing Supabase Storage with a separate artifact store.
- Building a general Kubernetes workflow engine.

---

## Users & Use Cases

### Primary users
- **Single developer / operator** running SupaClaw for personal workflows.
- **Teams** who want to run SupaClaw as an internal “agent worker” with deterministic audit trails.

### Must support use cases
- **Document rendering pipeline**: run `office-to-png` to produce `page_0001.png…` for any uploaded office/PDF.
- **Repo workflows**: clone repo from Storage snapshot, run `git`/`gh` actions, push generated diffs back to Storage.
- **Node workflows**: run `npx` (allowlisted) for codegen or formatting in a sandboxed workspace mirror.

---

## Core Concepts

### CLI Job
A durable record of a requested CLI action with:
- input workspace reference (prefix/path),
- command spec (tool name + args),
- security policy (allowlist class),
- resource limits,
- state transitions + logs,
- output artifact references.

### Runner
A long-running external process that:
- subscribes to **push triggers** from Supabase,
- claims jobs,
- executes jobs,
- uploads outputs/logs,
- updates job state.

### Workspace Sync Model
- **On-demand fetch** (default): download only declared inputs for each job.
- Optional later: **cached mirror** for performance.

---

## Trigger / “Push” Mechanisms (Supabase/Postgres-native)

The system must support push-style triggering **without inbound ports** to the runner. The runner initiates outbound connections.

### Option 1 (recommended): Supabase Realtime on `cli_jobs` inserts/updates
- Runner uses `supabase-js` Realtime subscription to table changes (INSERT where status=`queued`).
- On event, runner attempts to claim job in DB (atomic update).

**Pros**
- Push-based, low latency.
- No DB direct TCP connection required (works with Supabase’s Realtime websocket).
- No inbound ports.

**Cons**
- Realtime is an event stream, not a queue: runner must handle missed events by periodic reconciliation (lightweight).

**Requirement**
- Runner must have a fallback reconciliation loop (e.g., every 30–120s query for queued jobs) to ensure robustness.

### Option 2: Postgres LISTEN/NOTIFY
- Requires runner to have a direct Postgres connection (TCP) and privileges to `LISTEN`.
- A DB trigger function `NOTIFY cli_jobs, payload` fires on inserts.

**Pros**
- Very low latency; classic DB-native push.

**Cons**
- Requires direct DB connectivity and credentials beyond typical Supabase-js usage.
- More complex network posture for end users (DB egress, firewall rules).

### Option 3: pg_cron + net/http_post (server-side “pusher”)
- Postgres cron triggers an Edge Function or internal endpoint.
- Useful as a safety net to re-drive queued jobs.

**Pros**
- Fully Postgres-native; reliable “eventual trigger.”

**Cons**
- Not true instant push; interval-based.
- Typically complements Realtime/Notify rather than replacing them.

**PRD decision**
- Use **Realtime as primary push**, plus **lightweight reconciliation** as safety.
- Keep LISTEN/NOTIFY as an advanced, optional configuration for self-hosters.
- Use pg_cron only as fallback / periodic recovery if needed.

---

## Functional Requirements

### 1) Job submission
- The system must support creating a CLI job via:
  - internal tools (agent tool call),
  - webhook ingestion pipeline (e.g., file upload triggers rendering job),
  - developer/operator API (manual submissions).

- Each job must include:
  - `type` (e.g., `render_office_to_png`, `git_run`, `npx_run`)
  - `workspace_input` (bucket + prefix or explicit file list)
  - `command_spec` (structured; not a free-form shell string by default)
  - `limits` (timeout, max output size, disk cap)
  - `security_policy` (allowlist category)

### 2) Job claiming and concurrency
- Runner must claim jobs atomically:
  - update status from `queued` → `running` with `locked_by`, `locked_at`, and a lease/heartbeat.
- Multiple runner instances must not execute the same job simultaneously.
- Jobs must support retries with backoff and max attempts.

### 3) Execution environment
- Runner must execute jobs in an isolated working directory.
- Runner must provide:
  - ephemeral scratch space,
  - deterministic workspace directory layout.
- Runner must not require inbound network access.

### 4) Input materialization (Supabase Storage → local)
- Runner must download required inputs from Supabase Storage.
- The input selection must be deterministic and logged (what was pulled).
- Runner must validate paths (no `..`, no absolute path escapes).

### 5) Output persistence (local → Supabase Storage)
- Runner must upload outputs/artifacts to Supabase Storage.
- Outputs must be referenced in DB with:
  - object paths,
  - sizes,
  - content types,
  - checksums (if feasible).

### 6) Logs & observability
- Runner must persist:
  - stdout/stderr logs (chunked if large),
  - exit code,
  - timing,
  - resource usage (best-effort).
- Logs must be viewable via Supabase (DB rows and/or Storage objects).

### 7) Security policy (must-have)
- Default behavior must be **allowlist-based**:
  - Only explicitly permitted tools/commands can run.
- Jobs must run with **no secrets in the workspace** by default.
- Runner must redact secrets from logs where possible (best-effort).
- Dangerous operations (network access, filesystem deletes, git push) must require explicit policy flags.

### 8) Integration with file pipeline (must-have)
- When a file is uploaded and requires rendering:
  - A job must be created to produce **true page PNGs**: `page_0001.png…`
  - The pipeline must then enqueue OCR (in Supabase worker) to produce:
    - `page_0001.txt…`
    - `full.txt`
- The agent must see attachments as persistent references and be able to `read_file` the derived text outputs.

---

## Data Model (high-level)

### Table: `cli_jobs`
- `id` (uuid)
- `type` (text / enum)
- `status` (`queued|running|succeeded|failed|cancelled`)
- `created_at`, `updated_at`
- `requested_by` (user/session reference)
- `workspace_bucket`, `workspace_prefix` (or `inputs_json`)
- `command_json` (structured command spec)
- `security_policy` (text)
- `timeout_s`, `max_attempts`, `attempts`
- `locked_by`, `locked_at`, `lease_expires_at`
- `exit_code`, `error`
- `stdout_path`, `stderr_path` (Storage object paths)
- `artifacts_json` (list of output objects)

### Table: `cli_job_events` (optional, for deep audit)
- append-only log of state changes + timestamps + runner metadata.

---

## Runner Requirements

### Runner modes
- **Single-runner mode**: simplest; one container runs always.
- **Scale-out mode**: multiple replicas; claiming prevents double execution.

### Runner trigger behavior
- Primary: subscribe to Realtime changes on `cli_jobs`.
- Safety: periodic reconciliation query for stale queued jobs and expired leases.

### Runner identity
- Runner must have a stable `runner_id` used for locking and auditing.

---

## “Least infrastructure” deployment

### Minimal deployment target
- One Docker container started via `docker compose up -d` on any machine.
- Container uses outbound HTTPS/WSS to Supabase only.
- No inbound ports required.

### Why this is minimal
- Supabase remains DB, Storage, queue, and event system.
- Runner is “just compute”.

---

## Success Criteria
- A file upload triggers a render job and produces `page_0001.png…` reliably.
- OCR produces `page_0001.txt…` and `full.txt`.
- The agent can reference attachments immediately and in later turns via an attachment index.
- The runner can execute at least:
  - `office-to-png`
  - `git` read-only workflows
  - controlled `npx` workflows
- No public HTTP endpoints are required for core operation.

---

## Risks & Mitigations

### Missed push events (Realtime)
- **Mitigation**: reconciliation loop + lease expirations ensures eventual execution.

### Security escalation (agent triggering arbitrary commands)
- **Mitigation**: strict allowlist + structured command spec + policy gating + audit logs.

### Large outputs / runaway jobs
- **Mitigation**: timeouts, disk caps, output size caps; chunked logs; kill process on timeout.

### Cross-platform packaging
- **Mitigation**: Docker-first story; keep runner predictable.

---

## Phased Rollout

### Phase 1 (MVP)
- `cli_jobs` table + Realtime trigger + runner claim/execute
- `office-to-png` job type only
- outputs uploaded to Storage + status tracked in DB

### Phase 2
- integrate OCR follow-up job triggers
- add git/gh allowlisted workflows

### Phase 3
- caching workspace mirror
- richer policy model (network allowlists, package allowlists)

---

## Notes on push vs polling
Realtime/LISTEN/NOTIFY are **push signals**, not durable queues. The PRD intentionally combines:
- **push for low latency**
- **DB state + leases for correctness**
- **periodic reconciliation for robustness**

This achieves “push-based” behavior without requiring inbound networking and without relying on fragile always-perfect event delivery.