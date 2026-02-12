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

## Key Differences from OpenClaw

| Feature | OpenClaw | SupaClaw |
|---------|----------|----------|
| **Storage** | Local SQLite + filesystem | Supabase Storage + PostgreSQL |
| **Cron** | Custom scheduler | Supabase pg_cron |
| **Agent Loop** | Built-in | opencode.ai harness |
| **Files** | Local filesystem | Supabase Storage buckets |
| **Config** | Local YAML | Supabase DB + env vars |
| **Session State** | In-memory + SQLite | PostgreSQL |
| **Setup Complexity** | Medium (install, config, daemon) | Low (env vars only) |


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