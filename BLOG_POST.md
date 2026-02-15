# I Built OpenClaw on just Supabase. One SQL File. Three Edge Functions. That's It.

Because why not.

Looks like the always-on agent is the thing now. OpenClaw and its community proved that an always-on digital employee is not science fiction anymore. The era of digital employees has started, and with ideas like company-as-code floating around, this is only going to accelerate.

But here's my problem: I desperately want to know and understand the code that runs against my most private stuff — my health data, my knowledge base, my files, my ideas. I want to own it, hack it, customize it. Not run someone else's black box.

And of course, as a developer, you build a tiny version of the thing to understand how it actually works under the hood. There have been a few out there — nanobot, nano-claw, tiny-claw. But they all have the same pain point for me: self-hosting infrastructure I don't want to deal with, and tech I don't already use or trust.

## Why Supabase

I use Supabase daily. I know it. I trust it. I'm already self-hosting it for production projects.

And honestly? I'm not a DevOps person. I'm more of a GenZ cloud product user and average web developer with some fullstack experience. I don't want to SSH into a VPS. I don't want to run daemons. I don't want to think about server security.

Then one day it clicked. Supabase already ships every single primitive an always-on agent needs. It's been sitting right there the whole time.

Think about what makes agents like OpenClaw magical:

- A soul and persona
- A heartbeat that keeps them alive
- Always-on availability
- Message channels you already use
- Memory that persists across conversations
- A workspace for files

Now look at what Supabase gives you out of the box:

- Postgres for data (sessions, messages, memories)
- Supabase Storage for files
- pg_cron + pg_net for scheduled background work
- Edge Functions as HTTP endpoints
- pgvector for semantic search
- Built-in embedding model in the Edge Runtime
- Vault for secrets
- A dashboard to manage it all through a UI

It maps one-to-one. Every agent concept has a battle-tested Supabase feature behind it. No glue infrastructure needed.

And yes, I know that local filesystem access is what makes agents truly magical — rummaging through your computer, finding old files, using the terminal to fix things. But let's be honest, 80% or more of my use cases are online knowledge work. Research, brainstorming, writing, working with a curated set of files for a specific project. For that, a cloud-based agent is more than enough.

This is also not for coding. I still use Cursor and terminal-based agents for that. They're better suited. Though SupaClaw can orchestrate and kick off new projects.

## The Architecture

The entire thing is one SQL file and three Edge Functions. No VPS. No daemon. No extra infrastructure. Up and running in five minutes with one shell command.

The design principles are simple:

One SQL migration defines everything — tables, enums, RPC functions, triggers, cron schedule, storage buckets, security policies. Deploy it and the whole system exists.

Edge Functions handle the HTTP surface. Three of them: one for Telegram webhooks, one for the agent worker, one for external triggers. That's the entire deployment.

There's a `.agents/` folder in Supabase Storage that holds all the agent configuration — soul, identity, persona, skills, tools — as plain markdown files. Portable and easy to edit.

Single user. No multi-tenancy. The whole Supabase project exists just for me and my agent. I use the Supabase Dashboard as my admin UI to browse data, manage files, and view logs.

Supabase's built-in APIs are used everywhere. PostgREST gives you a full CRUD API just by defining tables. The TypeScript SDK wraps it all nicely. Minimize custom code, maximize what's already there.

## The Build — A Code Walkthrough

Let me walk you through the actual code. I kept the snippets minimal so you can skim fast.

### Init

You can run a full Supabase project locally with a simple

```bash
supabase start
```

Or sign up for a cloud project. Either way, ready to go.

### One SQL File

Everything lives in a single migration. Five tables: `sessions`, `messages`, `memories`, `files`, `jobs`. That's the whole data model.

The beautiful part? Just by creating these tables, Supabase gives you a full REST API + Auth for free via PostgREST and a TypeScript SDK out of the box:

```ts
const { data, error } = await supabase.from("messages").select("*").eq("session_id", sessionId);
```

No API routes to write. No controllers. It just works.

### The Heartbeat

The agent's "always-on" loop is one SQL statement. `pg_cron` fires every minute. `pg_net` makes an HTTP call to the agent worker Edge Function. No external scheduler, no cron server, nothing:

```sql
select cron.schedule('supaclaw-agent-worker', '* * * * *',
  $$ select net.http_post(...'/functions/v1/agent-worker'...); $$
);
```

The secrets for this live in Supabase Vault, never hardcoded. The cron job reads them at execution time.

```sql
select vault.create_secret(..., 'service_role_key')
```

### The Job Queue

No Redis. No SQS. Just a `jobs` table and two SQL functions. `enqueue_job` upserts with a dedupe key, so it's idempotent. Fire it twice, get one job.

`claim_jobs` uses `FOR UPDATE SKIP LOCKED`. It's the classic Postgres pattern for a reliable work queue. Multiple workers can run concurrently without double-processing.

A small Postgres function called via the SDK as a remote procedure call:

```ts
const { data: jobs } = await supabase.rpc("claim_jobs", { p_locked_by: workerId, ... });
```

When a job is done, one more RPC call marks it succeeded or failed with retry logic. All in SQL.

### The Message Flow

This is where it all comes together.

**Step 1 — Ingest.** A Telegram message hits the webhook Edge Function, then basically 3 supabase-js calls:

```ts
// 1) Upsert session
const { data } = await supabase.from('sessions').upsert({ channel: 'telegram', ... })
// 2) Insert message
const { data } = await supabase.from('messages').insert({ session_id, role, content, ... })
// 3) Enqueue job
const { data } = await supabase.rpc('enqueue_job', { ... })
```

The webhook returns `200 OK` instantly. No LLM call in the hot path.

**Step 2 — Process.** The next cron tick fires the agent worker. It claims the job and does three things:

First, it loads the agent's persona from Supabase Storage. Just markdown files in a bucket:

```ts
const { data: blob } = await supabase.storage.from("workspace").download(".agents/SOUL.md");
```

Then it generates a reply using the Vercel AI SDK which handles the tool calling loop:

```ts
import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
const result = streamText({ model: createOpenAI(...), messages, tools, ... });
```

Finally, it persists the reply *before* delivering it via Telegram. This way, if delivery fails, a retry picks up the undelivered message instead of regenerating it:

```ts
// Save first
await supabase.from("messages").insert({
  role: "assistant", content, telegram_sent_at: null, ...
});

// Then deliver
await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { ... });

// Mark delivered
await supabase.from("messages").update({
  telegram_sent_at: new Date().toISOString()
}).eq("id", replyId);
```

### The Tools

The agent's tools are just thin wrappers around Supabase Storage API's:

```ts
// List files
await supabase.storage.from("workspace").list(prefix)
// Read file
await supabase.storage.from("workspace").download(path)
// Write file
await supabase.storage.from("workspace").upload(path, body)
// Edit file
await supabase.storage.from("workspace").upload(path, body, { upsert: true })
```

These get exposed to the LLM as callable tools via the AI SDK, so the agent can browse, read, and edit its own workspace as if its a filesystem.

### Search and Memory

This one's my favorite. Every content table (messages, files, memories) has both a full-text search column and a vector embedding column, defined right in the schema:

```sql
create table files (
  ...
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  embedding extensions.vector(384),
  ...
);
```

Postgres generates the full-text index automatically. For embeddings, there's a built-in model running *inside* the Supabase Edge Runtime. No OpenAI API calls. No external service. No extra cost:

```ts
const session = new Supabase.ai.Session('gte-small')
const embedding = await session.run(input, { mean_pool: true, normalize: true })
```

And it's all automated. Postgres triggers fire on every insert or update and enqueue embedding jobs. The application code never has to remember to do it:

```sql
create trigger messages_enqueue_embed_on_insert
  after insert on messages for each row
  execute function enqueue_embedding_job('message', 'embed_message', 'message_id');
```

The same agent worker picks up these embedding jobs alongside message jobs. One worker, one queue, all job types.

When the agent needs context, a RPC function fuses keyword search and semantic similarity using Reciprocal Rank Fusion:

```ts
const { data } = await supabase.rpc("hybrid_search", {
  query_text: userMessage,
  query_embedding: await embedText(userMessage),
  match_count: 30,
  search_tables: ["memories"],
});
```

One call searches across any combination of tables. All in Postgres. Better than just grep on your filesystem.

### External Triggers

There's a third Edge Function — `trigger-webhook` — that lets external apps enqueue jobs via a simple authenticated POST:

```bash
curl -X POST https://your-project.supabase.co/functions/v1/trigger-webhook \
  -H "Authorization: Bearer $SECRET" \
  -d '{"type": "process_message", "payload": {...}}'
```

This means Zapier, Shortcuts, cron jobs from other systems, or any HTTP client can poke the agent without wasting heartbeat tokens on polling. The cron still runs every minute, but it only does real work when there's a job in the queue.

### Security

The core idea of this project is that one full Supabase project and database is owned and operated by a single user (and his agent).
Everything is locked down by default. All RPC functions are restricted to `service_role` only. No anonymous or authenticated Postgres role can call them:

```sql
revoke execute on function public.enqueue_job(...) from public;
grant execute on function public.enqueue_job(...) to service_role;
```

And future functions automatically inherit this restriction:

```sql
alter default privileges in schema public revoke execute on functions from public;
```

The webhook endpoints validate secrets with timing-safe comparison. The Telegram webhook checks a shared secret header. The agent worker checks its own secret. The trigger webhook supports both shared secrets and Supabase JWTs.

Security is actually a big reason i created this project, to potentially be able to use this in a business environment. Agents with full shell and system access are still a hard sell in enterprise.

Read more in the full security report in the repo.

## What this is and isn't

This is not a local computer agent. It can't browse your filesystem, open apps, or use your terminal. It works with files you explicitly put in its workspace. For local magic, use OpenClaw or similar. For knowledge work with curated files, this is plenty.

## What's Next

Of course i could add more message providers. Slack, Discord, email, a web UI. Or more connectors to other apps and 1000's of other features, but the point is really to have a basic version you can understand and customize yourself through a modular, pluggable system instead of drowning in config hell and vibe code bloat.

But a few things I'm thinking about:

Exploring the Supabase Dashboard's built-in assistant and chat UI as a potential web interface for the agent. Supabase also has an extensions marketplace that might open up interesting possibilities.

And still, the magic of direct shell access sometimes is too dangerously attractive, so it could become a remote sandboxing tool or maybe even spinning up some OpenClaw's for specific tasks where really needed.

But for now, it's just me and my supabase agent, running on one SQL file and three functions. And that's enough.
