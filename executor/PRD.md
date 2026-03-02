### PRD: Native CLI / Bash Execution Runtime (SupaClaw Compute)

### Overview
SupaClaw needs a **general-purpose execution runtime** for running **real CLI tools and bash scripts** (including piped multi-step commands that are not known beforehand) in an environment **outside Supabase Edge Functions**, while keeping Supabase as the **system of record** (Postgres + Storage) and keeping infrastructure minimal.

This PRD defines a compute capability that can power both:
- fixed pipelines (e.g. document rendering via `office-to-png`), and
- agent-initiated workflows (e.g. “run a toolchain in a workspace snapshot”).

### Problem Statement
Supabase Edge Functions are not suitable for heavyweight/native CLIs (LibreOffice-based conversions, renderer dependencies, some language toolchains). SupaClaw needs:
- **true document rendering** (Office/PDF → PNG pages) as a prerequisite for reliable OCR,
- a **general pattern** for future “run a tool in a workspace” workloads,
- **durable artifacts and logs** so outputs remain readable/referenceable across turns and devices,
- **security guarantees** appropriate for agent-triggered execution.

### Goals
- **General execution**: run native CLIs and bash scripts (pipes, heredocs, multi-step workflows).
- **Supabase-first persistence**: job state in Postgres; inputs/outputs/logs in Storage (traceable + durable).
- **Minimal ops**: deployable by end users without running a public API; outbound-only connectivity preferred.
- **Security-first**: isolation, least privilege, explicit policy gates, and audit logs by default.
- **Lean implementation**: small number of components; clear boundaries; easy to understand and extend.

### Non-Goals
- Full interactive terminal sessions (TTY) inside chat (deferred).
- Unrestricted “run any command as root”.
- Replacing Supabase Storage as the artifact store.
- Building a general workflow engine (Airflow/K8s/etc.).

---

## Users & Use Cases (must support)
- **Document rendering pipeline**: run `office-to-png` to produce `page_0001.png…` for uploaded Office/PDF.
- **General bash workflows**: run multi-step scripts for data wrangling, transforms, and toolchains.
- **Repo / project workflows (controlled)**: run allowlisted workflows around `git`/`gh`/`npx`-style tooling against a workspace snapshot.

---

## Core Concepts

### Compute Job
A durable record representing “run this workload against this workspace”, including:
- **workspace input reference** (Storage bucket + prefix / snapshot),
- **workload** (either a structured command *or* a bash script artifact),
- **runtime policy** (what is allowed: tools/images/network/write scope),
- **resource limits** (timeout, disk/output caps),
- **durable outputs** (artifact references) and **durable logs**,
- **auditable state transitions** (queued → running → terminal state).

### Workspace Snapshot
A Storage-backed, deterministic view of inputs for a job:
- the job operates on a **materialized copy** of declared inputs,
- outputs are written to a dedicated prefix, then uploaded as artifacts.

### Runner / Orchestrator
A minimal component that:
- watches for new jobs (event-driven preferred, reconciliation for correctness),
- claims jobs atomically,
- executes jobs in an isolated runtime,
- persists logs/artifacts back to Supabase.

---

## Execution Runtime (key addition)

### What “general bash” means
The runtime must support:
- **arbitrary bash scripts** (including pipes, heredocs, multi-step flows),
- deterministic working directory layout,
- capturing stdout/stderr + exit code,
- writing outputs to a known artifacts directory.

### Isolation requirement (solution-agnostic)
Each job must execute in a **clean, isolated sandbox** with a clear boundary between:
- **inputs** (read-only where possible),
- **scratch** (ephemeral),
- **artifacts** (the only persisted outputs).

Implementation detail is intentionally open, but the PRD assumes isolation is achieved via an **ephemeral per-job environment** (e.g. run-to-completion container/sandbox) rather than sharing a mutable long-lived shell.

---

## Functional Requirements

### 1) Job submission
The system must support creating compute jobs via:
- internal agent tool calls,
- the file ingestion pipeline (e.g. upload triggers render job),
- developer/operator API (manual submissions).

Each job must include:
- `type` (e.g. `render_office_to_png`, `bash_script`, `toolchain_run`)
- `workspace_input` (bucket + prefix or explicit file list)
- `workload`:
  - either **structured command** (tool + args), or
  - a **bash script artifact** (stored in Storage) executed via `bash -lc` (or equivalent)
- `limits` (timeout, max output size, disk cap)
- `policy` (allowlist category + flags)

### 2) Claiming, concurrency, retries
- Jobs must be claimed atomically (lease/lock with expiry).
- Multiple runners must not execute the same job.
- Jobs must support retries with backoff and max attempts.

### 3) Input materialization (Supabase Storage → runtime)
- Inputs must be downloaded from Storage deterministically and logged (what was pulled).
- Path validation must prevent traversal (`..`) and absolute path escapes.

### 4) Output persistence (runtime → Supabase Storage)
- Outputs must be uploaded to Storage and referenced from Postgres.
- Artifacts must record at least: path, size, and content type (checksums if feasible).

### 5) Logs & observability
- Persist stdout/stderr (chunked if large), exit code, timings, and best-effort resource usage.
- Logs must be viewable via Supabase (DB rows and/or Storage objects).

### 6) Security policy (must-have)
Default behavior must be allowlist/policy-based:
- **Workload allowlisting**: only approved job types / tools / base environments run by default.
- **Network policy**: off by default; explicit opt-in per job/policy where required.
- **Filesystem policy**: restrict writes to scratch/artifacts; restrict mounts to job workspace.
- **No secrets in workspace** by default; redact from logs best-effort.
- Dangerous operations (deletes, pushes, external network) require explicit policy flags and are auditable.

### 7) Integration with the document pipeline (must-have)
When a file upload requires rendering:
- enqueue a render job producing true page PNGs: `page_0001.png…`
- then enqueue OCR to produce:
  - `page_0001.txt…`
  - `full.txt`

The agent must be able to reference these outputs durably across turns (via Storage-backed attachments).

---

## Data Model (high-level)

### Table: `compute_jobs` (name flexible)
Must represent:
- identity, type, status, timestamps
- workspace input reference
- workload reference (structured command and/or script artifact reference)
- policy + limits
- locking/lease fields
- outputs/artifacts references
- logs references

### Table: `compute_job_events` (optional)
Append-only audit trail of state changes and runner metadata.

---

## Triggering (push signal + correctness)
The runtime should be **event-driven** for low latency, but must remain correct if events are missed:
- **push signal**: “a job is queued”
- **durable truth**: the job row/state in Postgres
- **reconciliation**: periodic scan for queued/stale/expired-lease jobs

This preserves “push-like” behavior without requiring inbound networking and without relying on perfect event delivery.

---

## Deployment Targets (keep minimal, keep optionality)
- **Self-host minimal**: a small runner plus an isolated job runtime on any machine (outbound-only to Supabase; no public endpoints required).
- **Managed run-to-completion** (optional): a job runner that starts an isolated environment per job, eliminating the need for an always-on process.

---

## Success Criteria
- Uploading a document triggers rendering and reliably produces `page_0001.png…`.
- OCR produces `page_0001.txt…` and `full.txt`.
- The agent can reference outputs immediately and later (session persistence via Storage/DB).
- The runtime supports both:
  - fixed pipelines (e.g. `office-to-png`), and
  - general multi-step bash scripts (pipes, heredocs).
- No public HTTP endpoints are required for core operation.

---

## Risks & Mitigations (high-level)
- **Missed push signals**: reconciliation + leases ensure eventual execution.
- **Security escalation**: policy gating + isolation + audit logs + strict defaults.
- **Runaway jobs / large outputs**: timeouts, disk/output caps, log chunking, kill-on-timeout.