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

### Confirmed decisions (what we’re building)
- Async: Telegram webhook only ingests + enqueues; worker processes jobs.
- Always-on (like): Event-driven for chat + cron for scheduled tasks + minimal “heartbeat” (only checks for due jobs, no “think loop”).
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
  - `jobs`: queued units of work (process inbound message, run reminder, run trigger)
  - `memories`: store/read/search tools to manage context across sessions
  - `files`: metadata, vectors, relation to messages

- **Storage**
  - Bucket `workspace`
    - `.agents/**`: portable persona/soul/skills/tools/workflows
    - `<folder>/**/<file>`: user workspace project folders and files the agent can read/write

- **Edge Functions (Deno)**
  - `telegram-webhook`: verifies request, normalizes message, writes `messages`, enqueues a `job`
  - `agent-worker`: claims jobs (SKIP LOCKED), builds context, calls LLM, persists outputs, sends outbound message
  - `trigger-webhook`: authenticated endpoint for external apps to enqueue jobs

- **Cron**
  - Runs `agent-worker` on a short interval (e.g. every 1 min) to ensure eventual processing + scheduled tasks.
  - Scheduled tasks are just `jobs` with `run_at`.

#### Core flows
- **Inbound message**
  1. Telegram → `telegram-webhook`
  2. `telegram-webhook` validates secret, upserts session, inserts inbound message, inserts `job(type="process_message")`
  3. Returns 200 immediately
  4. `agent-worker` picks job, composes prompt (SOUL + recent messages + retrieved memory), calls LLM, runs tools, persists, sends reply via Telegram API

- **Scheduled task / reminder**
  1. A row in `jobs` becomes due (`run_at <= now()`)
  2. Cron-triggered `agent-worker` processes it the same way

- **External trigger (nice-to-have but aligns with your “avoid heartbeat tokens”)**
  - `trigger-webhook` creates jobs so external systems can enqueue deterministic work without “agent polling”



## Data Flow

### Message Processing Flow

```
1. User sends message via chat provider (e.g. Telegram)
   │
   ▼
2. Provider calls Supabase Edge Function `telegram-webhook`
   - verifies `X-Telegram-Bot-Api-Secret-Token`
   - ignores any sender != allowed user id
   - upserts `sessions`
   - inserts `messages(role='user')`
   - enqueues `jobs(type='process_message')`
   │
   ▼
3. Cron (pg_cron + pg_net) invokes `agent-worker`
   - claims jobs (SKIP LOCKED)
   - retrieves `.agents/AGENTS.md` (and other persona files) from Storage
   - retrieves memories via hybrid search
   - calls LLM provider (OpenAI or Anthropic)
   - inserts `messages(role='assistant')` linked to the user messages
   - sends replies via Provider API
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
1. pg_cron triggers scheduled query
   │
   ▼
2. pg_net makes HTTP POST to `/functions/v1/agent-worker`
   │
   ▼
3. `agent-worker` processes due jobs and exits fast if none are due
```

## Security Notes

- Tables have **RLS enabled** with a default-deny posture; Edge Functions use `service_role` to access the database.
- Job enqueue/claim/search are exposed as RPCs but are **restricted to `service_role`** in the schema.


## Key Differences to OpenClaw

| Feature | OpenClaw | SupaClaw |
|---------|----------|----------|
| **Storage** | Local SQLite + filesystem | Supabase Storage + PostgreSQL |
| **Cron** | Custom scheduler | Supabase pg_cron |
| **Agent Loop** | Built-in | Supabase Edge Functions worker + DB jobs |
| **Files** | Local filesystem | Supabase Storage buckets |
| **Config** | Local YAML | Supabase DB + env vars |
| **Session State** | In-memory + SQLite | PostgreSQL |
| **Setup Complexity** | Medium (install, config, daemon) | Low (env vars only) |