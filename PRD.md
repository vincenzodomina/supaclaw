# SupaClaw PRD

A cloud-native AI agent for people who don't want to manage infrastructure

> "OpenClaw for people who just want it to work in the cloud, built on Supabase because it already has everything I need."

---

## Why SupaClaw?

Because I want an AI agent that:
- I **own and understand** — no black box or code bloat running against my private data
- Uses **tech I already know and trust** — Supabase, not some new stack
- Requires **zero infrastructure management** — no VPS, no terminal wrestling, no security headaches
- Is **hackable and customizable** — my code, my rules

Imagine an AI agent that you can setup with one command in the cloud in under 10 minutes as the easy path, all your created resources like persona files and skills are 100% portable to other agent frameworks and still you can self-host this full solution later for maximum privacy and local-model use. And all of that is based on existing, battle tested, enterprise ready software you can bring to businesses.

---

## Target User

- Web developer with some backend/fullstack experience
- More "GenZ cloud product user" than sysadmin
- Comfortable with Supabase, uncomfortable with server infrastructure
- Already using agents and LLMs, wants to know what code is running

---

## Functional Requirements

### Must Have

- **Supabase as the backbone** — database, storage, cron, edge functions, everything in one place
- **100% cloud-hosted** — no local runtime or VPS required
- **Self-hostable via self-hosted Supabase** — independence option
- **Minimal external dependencies** — as few providers and libraries as possible
- **Code I can read and understand** — simple enough to hack, re-use existing battle tested software
- **Soul/Identity system** — customizable personality and behavior
- **Works with messaging apps I already use** — Telegram, Slack, WhatsApp, etc.
- **Always-on** — available 24/7 without babysitting a daemon, but as stateless server
- **Session persistence** — conversations survive across devices + parallel use possible
- **File storage** — agent can read/write my files in the cloud and download to a filesystem when needed
- **Scheduled tasks** — heartbeat, reminders, cron/background jobs - for scheduled health checks / proactive tasks
- **Memory** — agent remembers context across sessions
- **Portability** - Skills, Tools (CLI's), Sub-agents, Soul/Persona files - should use re-usable standards

### Should Have

- **Core Tools Built-in** - See list of core tools in separate section
- **Tool extensibility** — easy to add new capabilities
- **Multi-channel** — same agent, different surfaces

### Nice to Have

- **Triggers** - External event automation vs. wasting tokens on heartbeat inference
- **Deployable in under 10 minutes** — env vars only, no complex config
- **Enterprise-ready path** — for "company as code" / digital employee use cases
- **Web chat interface** — not just messaging apps
- **Semantic memory search** — smarter recall

---

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
    - Let the agent manage reminders and scheduled jobs via the `tasks` table.
    - Actions: `list|add|update|remove`; `list` excludes disabled tasks by default.
    - Scheduling: `once` requires `run_at` (ISO-8601); `recurring` requires a 5-field `cron_expr` + optional IANA `timezone` (default `UTC`) and computes/updates `next_run_at`.

---

## Constraints

### Technical Constraints

- **Heavy use of existing Supabase functionality** - No re-inventing the wheel
- **Stateless server** — all state lives in Supabase
- **No local filesystem dependency** — everything in cloud storage
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
- **My data, my control** — even if it's in the cloud, I own the project
- **Boring tech wins** — Supabase is battle-tested, not bleeding edge
- **80/20 rule** — optimize for online knowledge work, not local hackery
- **Simple vs. Configurable** - Simple things should be simple, complex things should be possible

---

## Supabase Features to Leverage

- **PostgreSQL** — sessions, messages, config, memory
- **Storage buckets** — files, uploads, assets
- **pg_cron** — scheduled jobs without external scheduler
- **Edge Functions** — Running the agent and future extensibility
- **Row Level Security** — multi-tenant ready if needed
- **Realtime** — future live updates
- **Analytics & Logs** - Full observability built-in
- **Admin Dashboard** - Full access and insight into the data

---

## Success Criteria

- [ ] I can deploy it in one afternoon
- [ ] I can read and understand all the code
- [ ] I can chat with my agent from Telegram
- [ ] Agent remembers our conversations
- [ ] Agent can read/write files I give it access to
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
