# SupaClaw PRD

Zero-infra cloud agent - Runs entirely on Supabase primitives - no system access, minimal code to maintain, fully managed or self-hosted 

> "OpenClaw for people who just want it to work in the cloud, built on Supabase because it already has everything I need."

---

## Why SupaClaw?

Because I want an AI agent that:
- I **own and understand** — no black box or code bloat running against my private data
- Uses **tech I already know and trust** — Supabase, not some new stack
- Requires **zero infrastructure management** — no VPS, no terminal wrestling, no security headaches, no hardware requirements
- Is **hackable and customizable** — my code, my rules
- Is based on existing, battle tested, enterprise ready software you can bring to businesses

And of course the big one:

**Security**:

- No access to any credentials, but agent still can do everything
- Bash, but as a simulated environment for most use cases, whitelisted for most others and VM -sandbox where really needed
- No access to destructive actions without audit/revert option (e.g. database delete actions, delete files)
- Access: Auth, JWT secured endpoints, Row level security
- Database backups serve as full system snapshot backup (All data , all files)

---

## Target User

- Web developer with some backend/fullstack experience
- More "GenZ cloud product user" than sysadmin
- Comfortable with Supabase, uncomfortable with server infrastructure
- Wants to control the code, no vendor lock-in, self-host + full privacy option

---

## Functional Requirements

### Must Have

- **Soul/Identity system** — customizable personality and behavior
- **Always-on** — available 24/7 without babysitting a daemon, but as stateless server without relying on one device to be always on
- **File storage + attachments** — agent can persist, reference, and work with files in the cloud (uploaded by users or created by the agent)
- **Scheduled tasks** — heartbeat, reminders, cron/background jobs - for scheduled health checks / proactive tasks - with reliable retries independent from hardware failure
- **Session persistence** — conversations survive across devices + parallel use possible
- **Memory** — agent remembers context across sessions and across devices, with semantic search
- **Core Tools Built-in** - See list of core tools in separate section
- **Tool/Skill extensibility** — easy to add new capabilities
- **Multi-channel** — same agent, different surfaces (Telegram, Slack, web, etc.)
- **Portability** - Skills, Tools (CLI's), Sub-agents, Soul/Persona files - should use re-usable standards, importable and exportable
- **Multimodal Document Understanding** - Uploading a file should feel like “dropping it into the conversation” — the agent must reliably see it immediately, remember it later, and be able to read/search its contents on demand. The same attachment must remain discoverable in subsequent turns and across devices (session persistence). For this the ingested file must be processed and persisted into LLM-ready format (page-wise images and OCR for non text-like files).

### Nice to Have

- **Triggers** - External event automation vs. wasting tokens on heartbeat inference
- **One line quick install** — env vars only, no complex config
- **Enterprise-ready path** — for "company as code" / digital employee use cases
- **Web chat interface** — not just messaging apps

---

## Tools

- Shape & Registry: tools live each in their own file, and are registered in on index. Adding new 
tools is as easy as adding a new file, the tool shape is a clear contract boundary.
- Bounded outputs: tool calls and results should be stored in the message timeline.
- Reliability: must not crash the agent loop; on errors return structured with a clear and 
informative message for the agent and the assistant should explicitly say when nothing relevant 
was found.
- **`list_files`, `read_file`, `write_file`, `edit_file`** — Read, write, list, and edit files in the agent's cloud workspace (Supabase Storage). No local filesystem access.
- **`skills`** — Discover, load, and install portable Agent Skills from the workspace or GitHub.
- **`web_search`** — Search the web with automatic provider fallback; returns structured results.
- **`web_fetch`** — Fetch and read the content of a URL as markdown, with SSRF protection.
- **`memory_search`** — Recall prior decisions, preferences, facts, and context across sessions via hybrid search.
- **`cron`** — Create, list, update, and remove scheduled tasks and reminders.
- **`bash`** — Run shell commands in a sandboxed virtual environment for text processing, data wrangling, and multi-step workflows.

---

## Constraints

### Technical Constraints

- **Supabase as the backbone** — database, storage, cron, edge functions, everything in one place
- **Stateless server** — all state lives in Supabase
- **100% cloud-hosted or fully self-hostable** — no local runtime or VPS required or independence option
- **No local filesystem dependency** — everything in cloud storage first, have my files accessible from any device instead of sitting on one
- **No SQLite** — PostgreSQL only
- **No custom daemon process** — supabase managed state and schedules, no extra deployment or process
- **No terminal required for daily use** — manage via UI/chat
- Only SQL (schema, functions) and Typescript (in edge functions), eventually bash scripts for helpers and deployment

### User Experience Constraints

- **Setup must not require DevOps knowledge** - One command to setup and get started
- **No SSH, no server management, no security patching**
- **Works on free tiers** — Supabase free, cheap hosting
- **Single source of truth** — one database, one storage, one config

### Philosophical Constraints

- **Understandable > Feature-rich** — I'd rather have less that I understand than more that's magic
- **Code I can read and understand** — simple enough to hack, re-use existing battle tested software
- **My data, my control** — even if it's in the cloud, I own the project
- **Boring tech wins** — Supabase is battle-tested, not bleeding edge
- **80/20 rule** — optimize for online knowledge work, not local terminal hackery
- **Simple vs. Configurable** - Simple things should be simple, complex things should be possible

---

## Technical stack

Frameworks and libraries and features decided to be used:

***Supabase***
- PostgreSQL — sessions, messages, config, memory
- Storage buckets — files, uploads, assets
- pg_cron — scheduled jobs without external scheduler
- Edge Functions — Running the agent and future extensibility
- Row Level Security — multi-tenant ready if needed
- Analytics & Logs - Full observability built-in
- Admin Dashboard - Full access and insight into the data

***Vercel AI SDK***
- Multi-model provider LLM streaming
- Agent loop + tool calling handling
- Built in hooks for chunking, error handling etc.

***Vercel Chat SDK***
- Multi Channel support
- Message streaming
- Modals and actions

***Vercel just-bash***
- Shell actions in memory for most file interactions
- In memory filesystem pulled from supabase storage
- Sandbox fallback for the rest

---

## Success Criteria

- [ ] I can deploy it in one afternoon
- [ ] I can read and understand all the code
- [ ] I can chat with my agent from Telegram
- [ ] Agent remembers our conversations
- [ ] Agent can read/write files I give it access to
- [ ] When I upload any file, the agent can read and see its content
- [ ] Agent runs scheduled tasks (heartbeat, reminders)
- [ ] Monthly cost stays under $20 for personal use
- [ ] I don't have to touch a terminal after initial setup

---

## Non-Goals (For Now)

- Local file system access
- Node/device pairing
- Canvas/UI rendering
- Voice interaction
- Browser automation
- Plugin marketplace
- World dominance
