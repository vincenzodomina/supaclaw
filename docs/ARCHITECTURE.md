# Architecture

This document explains how SupaClaw works under the hood and how it differs from OpenClaw.

## High-Level Overview

```
┌───────────────────────────────────────────────────┐
│                  User Interfaces                  │
├───────────────────────────────────────────────────┤
│  Telegram  │  Slack  │  Supabase Admin Dashboard  │
└───────────────────────┬───────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────────┐
│                 Supabase Project                  │
├───────────────────────────────────────────────────┤
│                                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────┐  │
│  │  PostgreSQL │  │   Storage    │  │   Auth   │  │
│  │             │  │              │  │          │  │
│  │ • sessions  │  │ • workspace  │  │ • users  │  │
│  │ • messages  │  │   /.agents/**│  │ • tokens │  │
│  │ • pgmq jobs │  │   /files/**  │  │          │  │
│  │ • tasks     │  │              │  │          │  │
│  └─────────────┘  └──────────────┘  └──────────┘  │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │         pg_cron / Supabase Cron             │  │
│  │  • Periodic checks                          │  │
│  │  • Scheduled tasks                          │  │
│  │  • Heartbeat polls                          │  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │         Edge Functions                      │  │
│  │  • Agent loop                               │  │
│  │  • Message router                           │  │
│  │  • Event handlers                           │  │
│  │  • Webhooks                                 │  │
│  └─────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
                        ▲
                        │ Webhook
                        │
              ┌─────────┴─────────┐
              │    Telegram       │
              ├───────────────────┤
              │ • Chat UI         │
              │ • Messages        │
              │ • Channels        │
              └───────────────────┘
```

SupaClaw uses a hybrid processing model:
- **Chat messages process inline** — the webhook calls the agent directly and streams the reply to the channel provider. No job queue in the chat path; latency stays low, code stays simple.
- **Background work uses Supabase Queues (PGMQ)** — embeddings, scheduled tasks, and external triggers are enqueued into the `jobs` queue. A cron-driven worker pulls messages and deletes them on success (visibility timeout handles retries).

Fast chat without a queue hop, plus durable retry semantics for background work that can fail.

The worker only calls the LLM when there are due jobs, so cron acts as a minimal "heartbeat" — no wasted tokens.

### Confirmed decisions (what we're building)
- Inline chat: webhook processes messages directly (agent call + stream reply) using `EdgeRuntime.waitUntil()` for async background execution.
- Background queue: embeddings, scheduled tasks, and triggers go through Supabase Queues (PGMQ) queue `jobs` (visibility timeout retries; delete = ack).
- Always-on (like): Event-driven for chat + cron for scheduled tasks + minimal "heartbeat" (only checks for due jobs, no "think loop").
- Sessions: 1 Telegram chat = 1 session (groups = multiple sessions), but only your Telegram user ID is allowed.
- No commands in Telegram (yet).
- Single-user: no owner_id, no multi-tenant/RLS complexity.
- Storage layout: bucket `workspace` with `.agents/**` and other imported or created project folders and files.
- .agents folder with sub folders: agents, tools, skills, workflows; with subfolders of slugs matching the resource slug ;and root files: AGENTS.md, SOUL.md etc
- Memory: DB tables + pgvector + full-text + hybrid search from day one. Based on [Hybrid search](https://supabase.com/docs/guides/ai/hybrid-search).
- File access: full access within the `workspace` bucket (no extra prefix restriction).

#### Components
- **Postgres (source of truth)**
  - `sessions`: one per conversation surface (Telegram chat)
  - `messages`: all inbound/outbound messages (append-only)
  - `pgmq` queue `jobs`: queued units of work (run task, embed, trigger) — messages are durable in Postgres, claimed via visibility timeout, acknowledged by deletion
  - `tasks`: scheduled task definitions (one-shot, recurring or even unscheduled backlog). When a task fires it always triggers an agent run with the task `prompt` as runtime input;
  - `memories`: store/read/search tools to manage context across sessions
  - `files`: metadata, vectors, relation to messages

#### Type-Safe DB Access (Supabase generated types)
- DB schema types are generated from Postgres into `supabase/functions/_shared/database.types.ts` and treated as the single source of truth for table row/insert/update shapes.
- This keeps runtime behavior aligned with migrations and prevents drift in manual interface definitions.

- **Storage**
  - Bucket `workspace`
    - `.agents/**`: portable persona/soul/skills/tools/workflows
    - `<folder>/**/<file>`: user workspace project folders and files the agent can read/write

- **Edge Functions (Deno)**
  - `webhook`: single ingress endpoint with routes:
    - `/telegram`: verifies request, normalizes message (text or file attachment), upserts session + user message, calls the agent inline via `EdgeRuntime.waitUntil()`, returns `200 OK` immediately
    - `/trigger`: authenticated endpoint for external apps to enqueue jobs
  - `agent-worker`: claims background jobs (SKIP LOCKED) — scheduled tasks, embeddings, triggers — builds context, calls LLM, streams replies, persists outputs

- **Cron**
  - Runs every minute via pg_cron: first calls `enqueue_due_tasks()` to move due `tasks` into the `jobs` queue, then invokes `agent-worker` via pg_net.
  - Sole driver for scheduled tasks, embeddings, and triggers.
  - One-shot tasks (`schedule_type='once'`) are marked completed after firing (`completed_at`), not deleted.
  - Recurring tasks (`schedule_type='recurring'`) get their `next_run_at` recomputed by the worker after each run (using croner for cron expression parsing).
  - Unscheduled tasks (no `schedule_type`) act as backlog items — tracked but never auto-fired.

#### Core flows
- **Inbound message**
  1. Telegram sends update to `webhook` (`/telegram`)
  2. `webhook` validates secret, upserts session, inserts inbound `messages(role='user')`
  3. Webhook returns `200 OK` immediately; agent processing runs in the background via `EdgeRuntime.waitUntil()`
  4. Agent starts a typing keepalive loop, composes prompt (SOUL + recent messages + retrieved memory), calls LLM, streams partial replies via Telegram draft edits, runs tools, finalizes reply, stops typing loop

- **Scheduled task**
  1. Agent (or user via chat) creates a `tasks` row using the `cron` tool (with schedule_type, run_at or cron_expr, and a `prompt`)
  2. Every minute, `enqueue_due_tasks()` checks for tasks where `next_run_at <= now()`, enqueues a `job(type="run_task")`, and clears `next_run_at` to prevent double-fire
  3. `agent-worker` claims the job and runs the agent with an injected “scheduled task” header (task id/name/schedule metadata) + the task `prompt`
  4. The scheduled run is **isolated by default** (no prior session history). If `include_session_history=true` on the task, the agent run includes recent session context.
  5. For recurring tasks, the worker recomputes `next_run_at` from the cron expression; for one-shot tasks, the worker marks the task completed (`completed_at`)

- **External trigger**
  - `webhook` (`/trigger`) creates jobs so external systems can enqueue deterministic work without "agent polling"



## Data Flows

### Message Processing Flow

```
1. User sends message via chat provider (e.g. Telegram)
   │
   ▼
2. Provider calls Supabase Edge Function `webhook` (`/telegram`)
   - verifies `X-Telegram-Bot-Api-Secret-Token`
   - ignores any sender != allowed user id
   - upserts session, inserts `messages(role='user')`
   - returns 200 OK immediately
   │
   ▼
3. Agent runs inline (via EdgeRuntime.waitUntil)
   - retrieves `.agents/AGENTS.md` (and other persona files) from Storage
   - retrieves memories via hybrid search
   - starts typing keepalive loop (~4s refresh, ~2min timeout)
   - calls LLM provider (OpenAI or Anthropic)
   - streams partial replies to Telegram (draft message edits)
   - inserts `messages(role='assistant')` linked to the user messages
   - finalizes reply via Provider API, stops typing loop
```


### File Storage Flow

```
1. Agent calls `write` tool
   │
   ▼
2. Tool normalizes and validates storage object path format
   │
   ▼
3. Edge Function writes to `workspace/**` (or reads `.agents/**`)
   │
   ▼
4. Metadata can be persisted in `files` table for traceability
```


### Cron Job Flow

```
1. pg_cron triggers scheduled query (every minute)
   │
   ▼
2. `enqueue_due_tasks()` selects due `tasks` (`next_run_at <= now()`), enqueues `job(type="run_task")`, and clears `next_run_at` (prevents double-fire)
   │
   ▼
3. pg_net makes HTTP POST to `/functions/v1/agent-worker`
   │
   ▼
4. `agent-worker` claims queued jobs and runs the agent with an injected “scheduled task” header + the task `prompt`. Runs are isolated by default.
   │
   ▼
5. On success: recurring tasks recompute `next_run_at`; one-shot tasks set `completed_at`
```

## Tools

- **Shape & Registry** — tools live each in their own file, use the Vercel AI SDK `tool()` API, and are registered in on index.
- **Bounded outputs** — tool calls and results are stored in the message timeline; keep outputs small + JSON-serializable. If output is large, truncate and save the full content to Supabase Storage and return a pointer/path.
- **Reliability**: must not crash the agent loop; on errors return structured `{ error, message }` with a clear and informative message for the agent and the assistant should explicitly say when nothing relevant was found.
- **`list_files`, `read_file`, `write_file`, `edit_file`**
    - File tools interact with the files table for metadata and the Supabase storage api's for blobs. No direct filesystem access.
    - Workspace storage only access for the agent: workspace-root-relative paths are sanitized (no leading `/`, no `..`) and map to Supabase Storage.
    - `list_files`: non-recursive listing under a prefix; `path="."` or empty lists the workspace root.
    - `read_file`: returns `{ exists, content }` with `content=null` when missing (no hard error for absence).
    - `write_file`: creates/overwrites (upsert) UTF-8 text; optional `mime_type`; returns `{ ok: true, path }` and upserts a `files` DB record.
    - `edit_file`: read-modify-write via ordered exact replacements (`replace_all` optional); errors if file missing / `old_text` empty; returns per-edit replacement counts.
- **`skills`**
    - Workspace storage is the source of truth: skills live at `.agents/skills/<slug>/SKILL.md`; `sync` is rejected.
    - `list`: returns available skills by scanning `.agents/skills/*` and parsing `SKILL.md` (YAML frontmatter per agentskills.io standard)
    - `load|read`: `load` returns full `SKILL.md`; `read` returns a referenced text file inside the skill folder (root file or one-level path like `references/REFERENCE.md`).
    - `install`: Given a SKILL.md file or a Github URL it downloads and re-creates the files in Supabase storage to make them available at skill discovery. Works reliably with many Github link formats.
- **`web_search / web_fetch`** 
    — chain-friendly: returns compact structured results (title/url/snippet/etc.) meant to be followed by `web_fetch` for deeper reads; clamp `count`, snippet sizes, and enforce timeouts.
    - provider-aware + resilient: supports multiple providers with `provider=auto` and fallbacks that prefer free tiers / low-friction setups (use keyless/shared backends when available). Missing keys must not crash the agent run; return actionable structured errors only after fallbacks are exhausted.
    - Current events guidance:  when recency matters, include the current year in `web_search` queries.
    - External content safety: `web_fetch` / `web_search` treat external content as untrusted; block SSRF/local targets and support optional allow/deny host lists.
- **`memory_search`**
    — mandatory recall step: run before answering about prior decisions/preferences/facts/todos; returns top matching memory items.
    - Postgres-only: backed by `hybrid_search` over the `memories` table (FTS + pgvector); no local filesystem / no SQLite.
    - Defaults + knobs: `scope=auto` (global pinned facts + current-session summaries); supports `scope=current|all`, `types`, `max_results`, `match_count` (all clamped).
- **`cron`**
    - Let the agent manage scheduled agent runs via the `tasks` table.
    - Actions: `list|add|update|remove`; `list` excludes disabled and completed tasks by default.
    - Scheduling: `once` requires `run_at` (ISO-8601); `recurring` requires a 5-field `cron_expr` + optional IANA `timezone` (default `UTC`) and computes/updates `next_run_at`. `prompt` is the runtime input passed to the scheduled agent run.
- **`bash`**
    - Sandboxed Unix-like shell powered by [just-bash](https://github.com/nichochar/just-bash) — runs entirely in-process as a JS interpreter. No host OS shell, no child processes, no `execve`, for text/file processing beyond what `edit_file` or `web_fetch` cover (JSON wrangling, diffing, bulk transforms, piped commands)
    - Virtual Filesystem: Workspace files are imported on demand and explicitly exported back to Supabase Storage;
    - Network access: Optional allowlisted network access for `curl` (configured via `config.json`, disabled by default).
    - Session shells: reuse the same virtual filesystem across multiple calls within a single agent invocation for multi-step workflows.

## Multimodal Document Understanding

Uploading a file should feel like “dropping it into the conversation” — the agent must reliably see it immediately, remember it later, and be able to read/search its contents on demand. The same attachment must remain discoverable in subsequent turns and across devices (session persistence). For this the ingested file must be processed and persisted into LLM-ready format (page-wise images and OCR for non text-like files).

- When a user uploads a file, the system must persist an attachment reference in the conversation timeline as a message.
- The persisted attachment reference must include: **file name**, **file type/MIME**, **stored path**, and a **stable identifier** that can be used across turns.
- The same attachment must remain discoverable in subsequent turns and across devices (session persistence).
- The system must download/ingest the uploaded file from the channel provider and store it in the cloud workspace.
- The system must store file metadata and a concise **one-line description** that helps the agent understand what the file is at a glance.
- For **non-text** documents (e.g. PDFs, scans, images), the system must extract usable text and structure from the document.
- The pipeline must produce **page-level artifacts** (ordered by page number) and a **single assembled full-text** output.
- All derived artifacts must be stored under a deterministic location that is directly tied to the original stored path (so they are easy to find and reference).
- The assembled full-text output must be stored as a plain text file whose name is derived from the original file name (e.g. `original.ext` → `original.ext.txt`).
- For every agent turn, context construction must include a concise “attachment index” for the current session that lists each attachment with: **name**, **type**, **stored path**, and **one-line description**.
- The agent must be able to reference attachments naturally in conversation (e.g. “the PDF you uploaded”) and decide when to read details.
- The attachment index must work for both immediate turn-after-upload and later turns.
- The downstream agent must be able to read attachment contents using existing workspace file tools (e.g. `read_file`) without requiring channel-provider access.

Dataflow + Persistence:
```
          +-------------------+
          | Channel Provider  |
          | (Telegram/Slack/…)|
          +---------+---------+
                    |
                    | 1) User uploads file (message + attachment bytes)
                    v
          +-------------------+
          | Webhook Ingress   |
          | (Edge Function)   |
          +---------+---------+
                    |
                    | 2) Persist upload immediately
                    |    - store bytes in workspace storage
                    |    - create/update file record (id, path, metadata, one-liner)
                    |    - create message in timeline referencing file_id + path
                    v
     +-------------------+              +----------------------+
     | Workspace Storage |<------------>| Database             |
     | (raw upload)      |              | sessions/messages/   |
     | path: uploads/... |              | files + metadata     |
     +---------+---------+              +----------+-----------+
               |                                   |
               | 3) File record triggers           | 4) Subsequent turns load:
               |    processing pipeline            |    - recent chat messages
               v                                   |    - attachment index
     +------------------------+                    |
     | File Processing        |                    |
     | (non-text documents)   |                    |
     +-----------+------------+                    |
                 | 5) Store derived artifacts      |
                 |    under deterministic folder   |
                 v                                 v
     +------------------------+           +------------------------+
     | Workspace Storage      |           | Agent Context Builder  |
     | derived/…              |           | - recent messages      |
     | - page_001 image/text  |           | - attachment index     |
     | - page_002 image/text  |           +-----------+------------+
     | - full extracted .txt  |                       |
     +-----------+------------+                       | 6) Agent decides:
                 |                                    |    read_file for details
                 |                                    v
                 |                          +--------------------+
                 +------------------------->| Agent + Tools      |
                                            | (read_file, etc.)  |
                                            +--------------------+
```

## Security Notes

- Tables have **RLS enabled** with a default-deny posture; Edge Functions use `service_role` to access the database.
- Job enqueue/claim/search are exposed as RPCs but are **restricted to `service_role`** in the schema.
- Security with bash tool: no host process spawning, no FS access outside the in-memory tree, network deny-by-default, execution limits prevent runaway scripts.


## Key Differences to OpenClaw

| Feature | OpenClaw | SupaClaw |
|---------|----------|----------|
| **Storage** | Local SQLite + filesystem | Supabase Storage + PostgreSQL |
| **Cron** | Custom in-process scheduler (2000+ lines) | pg_cron + `tasks` table + `enqueue_due_tasks()` SQL function |
| **Chat Processing** | Built-in agent loop | Inline in webhook via `EdgeRuntime.waitUntil()` |
| **Background Jobs** | Built-in | Supabase Queues (PGMQ) queue `jobs` + cron-driven worker |
| **Files** | Local filesystem | Supabase Storage buckets |
| **Config** | Local YAML | Supabase DB + env vars |
| **Session State** | In-memory + SQLite | PostgreSQL |
| **Setup Complexity** | Medium (install, config, daemon) | Low (env vars only) |
