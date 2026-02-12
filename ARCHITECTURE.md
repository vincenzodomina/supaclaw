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
│  │ • sessions  │  │ • files/     │  │ • users  │  │
│  │ • messages  │  │ • uploads/   │  │ • tokens │  │
│  │ • config    │  │ • assets/    │  │          │  │
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
  - Clear audit trail (jobs/job_runs/messages)
  - Still “no daemon”
Least amount of code:
  - One SQL migration sets up tables + indexes + a couple RPCs.
  - Two edge functions, each small:
    - Ingest is pure normalization + DB write
    - Worker is the only place with LLM/tool logic
  - Everything else is Supabase-managed (DB, storage, cron, logs).

### Confirmed decisions (what we’re building)
- Async: Telegram webhook only ingests + enqueues; worker processes jobs.
- Always-on (like): Event-driven for chat + cron for scheduled tasks + minimal “heartbeat” (only checks for due jobs, no “think loop”).
- Sessions: 1 Telegram chat = 1 session (groups = multiple sessions), but only your Telegram user ID is allowed.
- No commands in Telegram (yet).
- Single-user: no owner_id, no multi-tenant/RLS complexity.
- Storage layout: canonical workspace/.agents/** tree in Supabase Storage.
- .agents folder with sub folders: agents, tools, skills, workflows; with subfolders of slugs matching the resource slug ;and root files: AGENTS.md, SOUL.md etc
- Memory: DB tables + pgvector + full-text + hybrid search from day one. Based on this post: https://supabase.com/docs/guides/ai/hybrid-search 
- File access: only within an allowed prefix (default /workspace).

#### Components
- **Postgres (source of truth)**
  - `sessions`: one per conversation surface (Telegram chat)
  - `messages`: all inbound/outbound messages (append-only)
  - `jobs`: queued units of work (process inbound message, run reminder, run trigger)
  - `job_runs`: attempts, logs, error + retry tracking
  - `memories`: store/read/search tools to manage context across sessions
  - `files`: metadata, vectors, relation to messages

- **Storage**
  - Bucket `.agents`: persona/soul/skills/tools manifests (portable files) (agent can read/write)
  - Bucket `workspace`: user data files the agent can read/write

- **Edge Functions (Deno)**
  - `telegram_webhook`: verifies request, normalizes message, writes `messages`, enqueues a `job`
  - `agent_worker`: claims jobs (SKIP LOCKED), builds context, calls LLM, executes tools, writes outputs, sends outbound message

- **Cron**
  - Runs `agent_worker` on a short interval (e.g. every 1 min) to ensure eventual processing + scheduled tasks.
  - Scheduled tasks are just `jobs` with `run_at`.

#### Core flows
- **Inbound message**
  1. Telegram → `telegram_webhook`
  2. `telegram_webhook` validates secret, upserts session, inserts inbound message, inserts `job(type="process_message")`
  3. Returns 200 immediately
  4. `agent_worker` picks job, composes prompt (persona + recent messages + memory summary), calls LLM, runs tools, persists, sends reply via Telegram API

- **Scheduled task / reminder**
  1. A row in `jobs` becomes due (`run_at <= now()`)
  2. Cron-triggered `agent_worker` processes it the same way

- **External trigger (nice-to-have but aligns with your “avoid heartbeat tokens”)**
  - reuse `agent_worker`, creates a `job(type="trigger")` so external systems can enqueue deterministic work without “agent polling”



## Data Flow

### Message Processing Flow

```
1. User sends message via Telegram
   │
   ▼

```


### File Storage Flow

```
1. Agent calls `write` tool
   │
   ▼


```


### Cron Job Flow

```
1. pg_cron triggers scheduled query
   │
   ▼

```


## Key Differences to OpenClaw

| Feature | OpenClaw | SupaClaw |
|---------|----------|----------|
| **Storage** | Local SQLite + filesystem | Supabase Storage + PostgreSQL |
| **Cron** | Custom scheduler | Supabase pg_cron |
| **Agent Loop** | Built-in | opencode.ai harness |
| **Files** | Local filesystem | Supabase Storage buckets |
| **Config** | Local YAML | Supabase DB + env vars |
| **Session State** | In-memory + SQLite | PostgreSQL |
| **Setup Complexity** | Medium (install, config, daemon) | Low (env vars only) |