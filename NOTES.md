# SupaClaw Blog Post


### Why I built this

Because why not.

Of course the most important point: 
It should be mine. 
I desperately want to know and understand the code that I am running against my most precious IP, knowledge, private files, health data, etc.. 
I want to control all the code, be able to hack it, to customize it to my needs.

And of course as a developer you create a tiny nano version of it to learn how it works fundamentally speaking under the hood, and of course there have been some out there: nanobot, nano claw, tiny claw, 

But all of them have still the same pain point for me: self hosting infrastructure setup effort and not the tech I already use and trust.

Not to mention the enterprise customers want to own and control all of that too, while also wanting the capabilities of OpenClaw but the ease of use and security of traditional cloud software.

and let's face it: the open claw hype in success, just started the era of the digital employee, which has been the anticipated endgame already for a while and with ideas like company as code and the enterprise world being very interested in it of course this will not be far away with automations like on and off boarding and stuff like that

since storing my sessions and files in the cloud, just makes sense for performance and reasons in being independent between all my devices and because using a poster database and as to that I already know well and love to use and also because super bass is so versatile and easy to use and I use it daily already. It just made sense since super already has current jobs age functions file storage relational data storage.

and yes, I know running it locally and and with a real face system is the things it is known for for its magic for a lot of crazy stuff it can do but to be honest 80% of my use cases or more kind of online knowledge work and for that a cloud based agent is sufficient enough, and because I'm not so comfortable with running it on my local machine or in a cloud VPS since I'm not so comfortable with the terminal with server, infrastructure and security in general I'm more like the GenZ cloud product user and average web developer with a little bit of backend and  full stack experience

I had the idea of using super bases in creating a tiny version of OpenClaw’s for myself as I was already working with agents and LLM’s for years now, but the last mile to make this a personal hobby for personal use project was the idea of not having to handle any infrastructure at all while still using as few and little as possible cloud and external providers, especially because I was self hosting supabase for production projects already making this still a possibly self hosted and independent solution anyway

Let’s compare what makes OpenClaw magical in terms of functionalities:

- Soul
- Heartbeat
- Always on
- Message providers you already use
- 
more: https://x.com/dabit3/status/2021387483364151451

and now let's compare what Superbase offers as battle tested solutions since years that just work 

Application data storage for electricians and messages 

Cron jobs 

Background jobs 

File block storage 

edge functions is reachable HTTP end points 



what this is not for 

it's not for local computer usage, which is part of the magic of claw where you just give it access to everything by default of your personal computer and where it might find old files and other apps in their data and through the terminal clever ways to work around and help you with config and issues on your personal computer , I use it mostly for knowledge work around a curated set of files for a specific task or project right now that I am aware of like my health data or project idea, brainstorming and writing

this is also not for a coding, I still use cursor and terminal based coding agents, which are better suited at that, though the set up can orchestrate those and kickstart new Greenfield projects 

architecture and implementation draft idea 

No other extra deployments, just it functions and a one SQL file which contains the declarative schema of the store, data policies, and the RPC functions 

Anything procedural or data related RPC functions over edge functions 

A dot agents folder that contains all the portable agent, configuration soul, identity, persona behavior, skills, and tools 

Super base API should be used the built-in out of the box solutions as much as possible 

No other users or multi tenancy, I am the only one user with super admin access and use the super bass dashboard to see my data through a user interface and manage it through a user interface 

The super dashboard as the web using interface 

Let's have a look at the super bass, admin, dashboard, built-in assistant, chat UI, if that can be hacked to be used as the chat interface for the agent 

Super wings also has a marketplace in plug-in and extension ecosystem, let's explore future possibilities or necessary things for this set up 

The same agent end point that gets Vogt by the heartbeat or messages from the message. Provider gateway should be also available to be involved by external triggers for example from other apps so that no tokens get wasted because of a heartbeat agent invocation, or the agent has to look up what is pending and needs to be done just to explore troika external lives and then trigger them as the agent which is something that can be easily created an automated with traditional code to be more efficient and more reliable and more immediate

Ther ecould be a Trigger based strategy to avoid wasted heartbeat thinking tokens tokens to decide on whats due: Model “work” as explicit jobs in DB; cron just runs due jobs. External apps create jobs via a simple authenticated HTTP endpoint. An additional approach could be a "tasks" table where agents triggered by events or the user can post tasks, which a heartbeat cron can query and if existing records, pick up a task an only then send to the AI, not the AI alwys automatically having to decide if there is a task pending. But external events triggering jobs can drastically reduce the heartbeat work for most use cases.

Caveats & Gotchas

- There is no oter user than me, the whole supabase project only for me so there are often SUPABASE_SERVICE_ROLE_KEY level access used here and there and no user_id stored in any table. The assumption is that this is a per-user setup, and only me and my agent can access.

- Deno: heard of people complaining because of not being node and eventual compatibility issues. But no problems encountered so far in this project.

---

## The Implementation

The entire backend is 1 SQL file and 3 Edge Functions. No Docker, no VPS, no Daemon, no extra infrastructure. Put up and running in 5 minutes with one shell command.

Let me walk you through the snippets. I kept it minimal to skim over fast.

### Init

You can get running with a full Supabase project locally with a simple

```bash
supabase start
```

Or you signup for an account and use the cloud project. Ok, Ready to go.

### The Schema: One SQL File to Rule Them All

Everything declarative lives in a single migration — tables, enums, RPC functions, triggers, cron schedule, storage buckets, and security hardening. Supabase runs it on deploy and the whole system exists.

The core tables: `sessions`, `messages`, `memories`, `files`, `jobs`. That's it.

The beauty of this is that migrating the tables sql gives you full CRUD endpoints via PostgREST and an TS SDK ready to use out of the box:

```ts
const { data, error } = await supabase.from("messages").select("*").eq("session_id", sessionId);
```

### The Heartbeat: pg_cron + pg_net

The agent's "always-on" heartbeat is a one-liner cron schedule. `pg_cron` fires every minute and `pg_net` makes an HTTP call to the agent-worker Edge Function — no external scheduler needed:

```sql
select cron.schedule('supaclaw-agent-worker', '* * * * *',
  $$ select net.http_post(...'/functions/v1/agent-worker'...); $$
);
```

The secrets for this live in **Supabase Vault**, never hardcoded. The cron job reads them at execution time.

### The Job Queue: Postgres SKIP LOCKED

Instead of Redis or SQS, the job queue is just a `jobs` table with two RPC functions. `enqueue_job` upserts with a dedupe key (idempotent). `claim_jobs` uses `FOR UPDATE SKIP LOCKED` — the classic Postgres pattern for a reliable work queue with no double-processing.

Edge Functions call these as RPC via supabase-js:

```ts
const { data: jobs } = await supabase.rpc("claim_jobs", {
  p_locked_by: workerId,
  p_max_jobs: 3,
});
```

### The Message Flow: Telegram Webhook → Job → Reply

**Step 1: Ingest.** The `telegram-webhook` Edge Function receives a message, upserts a session, inserts the message, and enqueues a `process_message` job — all through the Supabase client, three calls:

```ts
// 1) Upsert session
const { data: sessionRows } = await supabase.from('sessions').upsert({ channel: 'telegram', ... })
// 2) Insert message
await supabase.from('messages').insert({ session_id: sessionId, role: 'user', content, ... })
// 3) Enqueue job
await supabase.rpc('enqueue_job', { ... })
```

The webhook returns `200 OK` instantly. No LLM call in the hot path.

**Step 2: Process.** The next cron tick fires the `agent-worker`. It claims the job, then:

1. **Load the agent's persona files** from Supabase Storage — markdown files in a `.agents/` folder inside a `workspace` bucket:

```ts
const { data, error } = await supabase.storage.from("workspace").download(".agents/SOUL.md");
```

2. **Generates a reply** using the Vercel AI SDK with agentic tool-use (the agent can read/write/edit files in the workspace storage during its reasoning):

```ts
import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
const result = streamText({ model: createOpenAI(...), messages, tools, ... });
```

3. **Persists the reply, then delivers** via Telegram API. The reply is saved *before* delivery so retries can pick up undelivered messages.

```ts
res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', ... })
```

### The Tools

The basic file tools for list/read/write/edit use the corresponding Supabase storage api's:

```ts
const { data, error } = await supabase.storage.from("workspace").list(prefix, { ... })
const { data, error } = await supabase.storage.from("workspace").download(".agents/SOUL.md")
const { data, error } = await supabase.storage.from("workspace").upload(safePath, body, { ... })
const { data, error } = await supabase.storage.from("workspace").upload(safePath, body, { upsert: true, ... })
```

### The Search: pg_vector + tsvector

The `files` table doubles as a searchable index. Every file gets a generated full-text search column *and* a vector embedding column, both defined right in the schema:

```sql
create table files (
  id uuid primary key default gen_random_uuid(),
  ...
  -- Full-text search
  fts tsvector generated always as (to_tsvector(...)) stored,
  -- Vector search
  embedding extensions.vector(384),
  ...
);
```

Same pattern for `messages` and `memories`. Three tables, all searchable by keyword *and* by meaning, with zero application code for indexing.

There is a built-in embedding model that runs *inside* the Supabase Edge Runtime. No OpenAI embedding calls, no external API, no extra cost:

```ts
const session = new Supabase.ai.Session('gte-small')
const embedding = await session.run(input, { ... })
```

Then retrieve relevant memories with a single RPC that fuses full-text (BM25) and vector similarity using Reciprocal Rank Fusion:

```ts
const { data: hybrid } = await supabase.rpc("hybrid_search", { ... });
```

### The Security: Locked Down by Default

All RPC functions are restricted to `service_role` only. The `anon` and `authenticated` Postgres roles cannot call them, and future functions inherit this default:

```sql
revoke execute on function public.enqueue_job(...) from public;
grant  execute on function public.enqueue_job(...) to service_role;
alter default privileges in schema public revoke execute on functions from public;
```