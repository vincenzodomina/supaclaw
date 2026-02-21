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
│  │ • jobs      │  │   /files/**  │  │          │  │
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

The smallest architecture that satisfies the PRD is a DB-backed job queue + worker + edge functions.
Webhook enqueues; worker processes; cron ensures eventual execution.

SupaClaw is intentionally built as DB queue + worker, where cron is the Supabase-managed "always-on" scheduler (so there is no need for a daemon).

Pros:
  - Reliable, retryable, idempotent
  - Natural place for scheduled tasks + triggers
  - Clear audit trail (jobs/messages)
  - Still “no daemon”
Least amount of code:
  - One SQL migration sets up tables + indexes + a couple RPCs.
  - Two edge functions, each small:
    - Ingest is pure normalization + DB write
    - Worker is the only place with LLM/tool logic
    - Trigger endpoint just enqueues jobs (optional)
  - Everything else is Supabase-managed (DB, storage, cron, logs).

The worker only calls the LLM when there are due jobs, so this acts as a minimal “heartbeat”.

### Confirmed decisions (what we're building)
- Async: Telegram webhook only ingests + enqueues; worker processes jobs.
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
  - `jobs`: queued units of work (process inbound message, run task, embed, trigger) — dedupe keys prevent duplicates, attempt tracking enables retries with backoff, and rows are inspectable for debugging
  - `tasks`: scheduled task definitions (one-shot reminders, recurring cron jobs, or unscheduled backlog items)
  - `memories`: store/read/search tools to manage context across sessions
  - `files`: metadata, vectors, relation to messages

- **Storage**
  - Bucket `workspace`
    - `.agents/**`: portable persona/soul/skills/tools/workflows
    - `<folder>/**/<file>`: user workspace project folders and files the agent can read/write

- **Edge Functions (Deno)**
  - `webhook`: single ingress endpoint with routes:
    - `/telegram`: verifies request, normalizes message, calls `ingest_inbound_text()` (session + message + job enqueue), kicks `agent-worker` immediately (best-effort)
    - `/trigger`: authenticated endpoint for external apps to enqueue jobs
  - `agent-worker`: claims jobs (SKIP LOCKED), builds context, starts a typing keepalive loop, calls LLM, streams partial replies to Telegram (draft message edits), persists outputs, sends outbound message, stops typing loop

- **Cron**
  - Runs every minute via pg_cron: first calls `enqueue_due_tasks()` to move due `tasks` into the `jobs` queue, then invokes `agent-worker` via pg_net.
  - Acts as the durable backstop for chat message jobs and the sole driver for scheduled tasks, embeddings, and triggers.
  - One-shot tasks (`schedule_type='once'`) auto-disable after firing.
  - Recurring tasks (`schedule_type='recurring'`) get their `next_run_at` recomputed by the worker after each run (using croner for cron expression parsing).
  - Unscheduled tasks (no `schedule_type`) act as backlog items — tracked but never auto-fired.

#### Core flows
- **Inbound message**
  1. Telegram sends update to `webhook` (`/telegram`)
  2. `webhook` validates secret, calls `ingest_inbound_text()` (upsert session, insert inbound message, enqueue `job(type="process_message")`)
  3. Webhook kicks `agent-worker` immediately (best-effort, failure swallowed) and returns `200 OK`
  4. `agent-worker` claims the job, starts a typing keepalive loop (refreshes every ~4s, auto-stops after ~2min), composes prompt (SOUL + recent messages + retrieved memory), calls LLM, streams partial replies via Telegram draft edits (partial or block mode), runs tools, finalizes reply, stops typing loop
  5. If the immediate kick failed, cron picks up the job on the next tick (within ~60s)

- **Scheduled task / reminder**
  1. Agent (or user via chat) creates a `tasks` row using the `cron` tool (with schedule_type, run_at or cron_expr, and a prompt)
  2. Every minute, `enqueue_due_tasks()` checks for tasks where `next_run_at <= now()`, enqueues a `job(type="run_task")`, and clears `next_run_at` to prevent double-fire
  3. `agent-worker` claims the job, inserts the task prompt as a message in the bound session, generates an agent reply (with full tool access), delivers via channel provider
  4. For recurring tasks, the worker recomputes `next_run_at` from the cron expression; for one-shot tasks, the task is disabled

- **External trigger (nice-to-have but aligns with your "avoid heartbeat tokens")**
  - `webhook` (`/trigger`) creates jobs so external systems can enqueue deterministic work without "agent polling"



## Data Flow

### Message Processing Flow

```
1. User sends message via chat provider (e.g. Telegram)
   │
   ▼
2. Provider calls Supabase Edge Function `webhook` (`/telegram`)
   - verifies `X-Telegram-Bot-Api-Secret-Token`
   - ignores any sender != allowed user id
   - calls `ingest_inbound_text()` (upserts `sessions`, inserts `messages(role='user')`, enqueues `jobs(type='process_message')`)
   - kicks `agent-worker` immediately (best-effort)
   - returns 200 OK
   │
   ▼
3. `agent-worker` (triggered by immediate kick or cron)
   - claims jobs (SKIP LOCKED)
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
2. Checks due tasks table and enqueues a job to run task
   │
   ▼
3. pg_net makes HTTP POST to `/functions/v1/agent-worker`
   │
   ▼
4. `agent-worker` claims jobs and exits fast if no jobs are due
```

## Security Notes

- Tables have **RLS enabled** with a default-deny posture; Edge Functions use `service_role` to access the database.
- Job enqueue/claim/search are exposed as RPCs but are **restricted to `service_role`** in the schema.


## Key Differences to OpenClaw

| Feature | OpenClaw | SupaClaw |
|---------|----------|----------|
| **Storage** | Local SQLite + filesystem | Supabase Storage + PostgreSQL |
| **Cron** | Custom in-process scheduler (2000+ lines) | pg_cron + `tasks` table + `enqueue_due_tasks()` SQL function |
| **Agent Loop** | Built-in | Supabase Edge Functions worker + DB jobs |
| **Files** | Local filesystem | Supabase Storage buckets |
| **Config** | Local YAML | Supabase DB + env vars |
| **Session State** | In-memory + SQLite | PostgreSQL |
| **Setup Complexity** | Medium (install, config, daemon) | Low (env vars only) |
