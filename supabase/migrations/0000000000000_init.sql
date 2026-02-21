-- Extensions
create schema if not exists extensions;

create extension if not exists pgcrypto;
create extension if not exists vector with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
create extension if not exists supabase_vault cascade;

-- Enums
create type enum_channel_provider as enum ('telegram', 'slack', 'whatsapp', 'discord', 'imessage', 'phone', 'email', 'web', 'mobile', 'desktop', 'api');
create type enum_message_role as enum ('assistant', 'user', 'system');
create type enum_message_type as enum ('text', 'tool-call', 'file');
create type enum_message_tool_status as enum ('started', 'succeeded', 'failed');
create type enum_memory_type as enum ('summary', 'pinned_fact', 'note');
create type enum_job_type as enum ('process_message', 'embed_memory', 'embed_message', 'embed_file', 'trigger', 'run_task');
create type enum_task_type as enum ('reminder', 'agent_turn', 'backlog');
create type enum_schedule_type as enum ('once', 'recurring');

-- Tables
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  channel enum_channel_provider not null,
  channel_chat_id text not null,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, channel_chat_id)
);

alter table sessions enable row level security;

create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  bucket text not null,
  object_path text not null,
  mime_type text,
  name text not null,
  content text not null default '',
  -- Full-text search
  fts tsvector generated always as (to_tsvector('english', name || E'\n\n' || content)) stored,
  -- Vector search (384 dims for gte-small)
  embedding extensions.vector(384),
  size_bytes bigint,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (bucket, object_path)
);

alter table files enable row level security;
create index if not exists files_fts_idx on files using gin(fts);
create index if not exists files_embedding_idx on files using hnsw (embedding vector_ip_ops);

create table if not exists messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references sessions(id) on delete cascade,
  reply_to_message_id bigint references messages(id),
  role enum_message_role not null,
  content text not null,
  -- Full-text search
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  -- Vector search (384 dims for gte-small)
  embedding extensions.vector(384),
  channel enum_channel_provider not null,
  channel_update_id text,
  channel_message_id text,
  channel_chat_id text,
  channel_from_user_id text,
  channel_sent_at timestamptz,
  type enum_message_type not null,
  tool_duration_ms int,
  tool_error text,
  tool_name text,
  tool_result jsonb,
  tool_status enum_message_tool_status,
  file_id uuid references files(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table messages enable row level security;

create unique index if not exists messages_channel_update_id_uniq
  on messages (channel, channel_update_id)
  where channel_update_id is not null;

create index if not exists messages_session_created_idx
  on messages (session_id, created_at desc);

create index if not exists messages_fts_idx on messages using gin(fts);
create index if not exists messages_embedding_idx on messages using hnsw (embedding vector_ip_ops);

create table if not exists memories (
  id bigint generated always as identity primary key,
  session_id uuid references sessions(id) on delete cascade,
  type enum_memory_type not null,
  content text not null,
  url text,
  priority int default 0,
  metadata jsonb default '{}'::jsonb,
  -- Full-text search
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  -- Vector search (384 dims for gte-small)
  embedding extensions.vector(384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table memories enable row level security;
create index if not exists memories_fts_idx on memories using gin(fts);
create index if not exists memories_embedding_idx on memories using hnsw (embedding vector_ip_ops);
create index if not exists memories_type_idx on memories (type);
create index if not exists memories_session_idx on memories (session_id);

create table if not exists jobs (
  id bigint generated always as identity primary key,
  dedupe_key text not null,
  status text not null check (status in ('queued','running','succeeded','failed')) default 'queued',
  type enum_job_type not null,
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 5,
  locked_at timestamptz,
  locked_by text,
  payload jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (dedupe_key)
);

alter table jobs enable row level security;

create index if not exists jobs_due_idx 
  on jobs (status, run_at, id);

create table if not exists tasks (
  id bigint generated always as identity primary key,
  name text not null,
  description text,
  prompt text,
  schedule_type enum_schedule_type,
  run_at timestamptz,
  cron_expr text,
  timezone text not null default 'UTC',
  task_type enum_task_type not null default 'reminder',
  session_id uuid references sessions(id) on delete set null,
  enabled_at timestamptz default now(),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  run_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tasks enable row level security;

create index if not exists tasks_due_idx
  on tasks (enabled_at, next_run_at)
  where enabled_at is not null and next_run_at is not null;

-- Functions
create or replace function enqueue_job(
  p_dedupe_key text,
  p_type text,
  p_payload jsonb default '{}'::jsonb,
  p_run_at timestamptz default now(),
  p_max_attempts int default 5
)
returns bigint
language plpgsql
as $$
declare
  v_job_id bigint;
begin
  insert into jobs (dedupe_key, type, payload, run_at, max_attempts, updated_at)
  values (p_dedupe_key, p_type::enum_job_type, p_payload, p_run_at, p_max_attempts, now())
  on conflict (dedupe_key) do update
    set
      type = excluded.type,
      payload = excluded.payload,
      run_at = excluded.run_at,
      max_attempts = excluded.max_attempts,
      -- If a job is running, keep it running. Otherwise queue it.
      status = case when jobs.status = 'running' then jobs.status else 'queued' end,
      last_error = null,
      updated_at = now();

  select id into v_job_id from jobs where dedupe_key = p_dedupe_key;
  return v_job_id;
end;
$$;

-- Ingest an inbound text message from any channel provider.
-- Creates/updates a session, inserts the inbound message idempotently,
-- and enqueues a process_message job (deduped by channel + update id).
create or replace function ingest_inbound_text(
  p_channel text,
  p_channel_chat_id text,
  p_channel_update_id text,
  p_content text,
  p_channel_message_id text default null,
  p_channel_from_user_id text default null,
  p_job_max_attempts int default 10
)
returns jsonb
language plpgsql
as $$
declare
  v_channel enum_channel_provider;
  v_chat_id text;
  v_update_id text;
  v_content text;
  v_message_id text;
  v_from_user_id text;
  v_session_id uuid;
  v_inbound_id bigint;
  v_job_id bigint;
  v_dedupe_key text;
begin
  if p_channel is null or btrim(p_channel) = '' then
    raise exception 'ingest_inbound_text: p_channel is required';
  end if;
  v_channel := btrim(p_channel)::enum_channel_provider;

  v_chat_id := nullif(btrim(p_channel_chat_id), '');
  if v_chat_id is null then
    raise exception 'ingest_inbound_text: p_channel_chat_id is required';
  end if;

  v_update_id := nullif(btrim(p_channel_update_id), '');
  if v_update_id is null then
    raise exception 'ingest_inbound_text: p_channel_update_id is required';
  end if;

  v_content := nullif(btrim(p_content), '');
  if v_content is null then
    raise exception 'ingest_inbound_text: p_content is required';
  end if;

  v_message_id := nullif(btrim(p_channel_message_id), '');
  v_from_user_id := nullif(btrim(p_channel_from_user_id), '');

  insert into sessions (channel, channel_chat_id, title, updated_at)
  values (v_channel, v_chat_id, left(v_content, 80), now())
  on conflict (channel, channel_chat_id) do update
    set
      updated_at = now(),
      title = coalesce(sessions.title, excluded.title)
  returning id into v_session_id;

  insert into messages (
    session_id,
    role,
    type,
    content,
    channel,
    channel_update_id,
    channel_message_id,
    channel_chat_id,
    channel_from_user_id,
    updated_at
  )
  values (
    v_session_id,
    'user',
    'text',
    v_content,
    v_channel,
    v_update_id,
    v_message_id,
    v_chat_id,
    v_from_user_id,
    now()
  )
  on conflict (channel, channel_update_id) where channel_update_id is not null do nothing
  returning id into v_inbound_id;

  if v_inbound_id is null then
    select id into v_inbound_id
    from messages
    where channel = v_channel
      and channel_update_id = v_update_id
    order by id desc
    limit 1;
  end if;

  v_dedupe_key := v_channel::text || ':process_message:' || v_update_id;
  v_job_id := enqueue_job(
    p_dedupe_key := v_dedupe_key,
    p_type := 'process_message',
    p_payload := jsonb_build_object(
      'session_id', v_session_id,
      'channel_update_id', v_update_id,
      'channel_chat_id', v_chat_id
    ),
    p_run_at := now(),
    p_max_attempts := p_job_max_attempts
  );

  return jsonb_build_object(
    'session_id', v_session_id,
    'message_id', v_inbound_id,
    'job_id', v_job_id,
    'dedupe_key', v_dedupe_key
  );
end;
$$;


-- Atomic claim (SKIP LOCKED)
create or replace function claim_jobs(
  p_locked_by text,
  p_max_jobs int default 1,
  p_lock_timeout_seconds int default 300
)
returns setof jobs
language sql
as $$
with cte as (
  select id
  from jobs
  where (
      status = 'queued'
      or (
        status = 'running'
        and locked_at is not null
        and locked_at <= now() - make_interval(secs => greatest(p_lock_timeout_seconds, 30))
      )
    )
    and run_at <= now()
    and attempts < max_attempts
  order by run_at asc, id asc
  for update skip locked
  limit p_max_jobs
)
update jobs j
set
  status = 'running',
  locked_at = now(),
  locked_by = p_locked_by,
  attempts = j.attempts + 1,
  updated_at = now()
from cte
where j.id = cte.id
returning j.*;
$$;

-- Convenience helpers to finalize jobs
create or replace function job_succeed(p_job_id bigint)
returns void
language sql
as $$
update jobs
set
  status='succeeded',
  locked_at=null,
  locked_by=null,
  last_error=null,
  updated_at=now()
where id = p_job_id;
$$;

create or replace function job_fail(p_job_id bigint, p_error text, p_retry_in_seconds int default 60)
returns void
language plpgsql
as $$
begin
  update jobs
  set
    status = case when attempts >= max_attempts then 'failed' else 'queued' end,
    run_at = case when attempts >= max_attempts then run_at else now() + make_interval(secs => greatest(p_retry_in_seconds, 5)) end,
    locked_at = null,
    locked_by = null,
    last_error = left(p_error, 4000),
    updated_at = now()
  where id = p_job_id;
end;
$$;

-- Enqueue due tasks into the jobs queue.
-- Called by pg_cron every minute before the worker is invoked.
create or replace function enqueue_due_tasks()
returns int
language plpgsql
as $$
declare
  v_count int := 0;
  v_task record;
begin
  for v_task in
    select *
    from tasks
    where enabled_at is not null
      and next_run_at is not null
      and next_run_at <= now()
    for update skip locked
  loop
    perform enqueue_job(
      p_dedupe_key := 'task:' || v_task.id || ':' || extract(epoch from v_task.next_run_at)::bigint::text,
      p_type := 'run_task',
      p_payload := jsonb_build_object(
        'task_id', v_task.id,
        'task_type', v_task.task_type,
        'prompt', v_task.prompt,
        'session_id', v_task.session_id
      ),
      p_run_at := now(),
      p_max_attempts := 3
    );

    -- Clear next_run_at to prevent re-enqueue on the next cron tick.
    -- The worker recomputes it for recurring tasks after successful execution.
    -- One-shot tasks also get disabled.
    if v_task.schedule_type = 'once' then
      update tasks set next_run_at = null, enabled_at = null, updated_at = now() where id = v_task.id;
    else
      update tasks set next_run_at = null, updated_at = now() where id = v_task.id;
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Schedule worker every minute (enqueue due tasks first, then invoke the worker).
select cron.schedule(
  'supaclaw-agent-worker',
  '* * * * *',
  $$
  select enqueue_due_tasks();
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='project_url')
           || '/functions/v1/agent-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='service_role_key'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name='service_role_key'),
      'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name='worker_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Enqueue embedding jobs whenever content changes (or is inserted).
create or replace function public.enqueue_embedding_job()
returns trigger
language plpgsql
as $$
declare
  v_key text;
  v_key_prefix text := tg_argv[0];
  v_job_type text := tg_argv[1];
  v_payload_key text := tg_argv[2];
begin
  -- For message timeline rows: only embed actual text messages.
  if v_key_prefix = 'message' then
    if coalesce(new.type, 'text') <> 'text' then
      return new;
    end if;
  end if;

  v_key := v_key_prefix || ':embed:' || new.id::text;
  perform public.enqueue_job(
    p_dedupe_key => v_key,
    p_type => v_job_type,
    p_payload => jsonb_build_object(v_payload_key, new.id),
    p_run_at => now(),
    p_max_attempts => 20
  );

  return new;
end;
$$;

create trigger memories_enqueue_embed_on_insert
after insert on memories
for each row
execute function enqueue_embedding_job('memory', 'embed_memory', 'memory_id');

create trigger memories_enqueue_embed_on_update
after update of content, type on memories
for each row
execute function enqueue_embedding_job('memory', 'embed_memory', 'memory_id');

create trigger files_enqueue_embed_on_insert
after insert on files
for each row
execute function enqueue_embedding_job('file', 'embed_file', 'file_id');

create trigger files_enqueue_embed_on_update
after update of name, content on files
for each row
execute function enqueue_embedding_job('file', 'embed_file', 'file_id');

create trigger messages_enqueue_embed_on_insert
after insert on messages
for each row
execute function enqueue_embedding_job('message', 'embed_message', 'message_id');

create trigger messages_enqueue_embed_on_update
after update of content on messages
for each row
execute function enqueue_embedding_job('message', 'embed_message', 'message_id');

-- Hybrid search (RRF fusion) across messages/files/memories with optional filters.
-- Based on Supabase docs: https://supabase.com/docs/guides/ai/hybrid-search
create or replace function hybrid_search(
  query_text text,
  query_embedding extensions.vector(384),
  match_count int,
  search_tables text[] default array['messages', 'files', 'memories'],
  -- Optional filters (applied only to the relevant tables)
  filter_type enum_memory_type[] default null,
  filter_session_id uuid default null,
  filter_role enum_message_role[] default null,
  filter_bucket text default null,
  filter_object_path_prefix text default null,
  full_text_weight float default 1,
  semantic_weight float default 1,
  rrf_k int default 50
)
returns jsonb
language plpgsql
as $$
declare
  v_tables text[];
  v_messages jsonb := '[]'::jsonb;
  v_files jsonb := '[]'::jsonb;
  v_memories jsonb := '[]'::jsonb;
begin
  -- Normalize table selectors (default: all)
  v_tables := array(
    select lower(trim(t))
    from unnest(coalesce(search_tables, array['messages', 'files', 'memories'])) as t
    where t is not null and length(trim(t)) > 0
  );

  if exists (
    select 1
    from unnest(v_tables) as t
    where t not in ('messages', 'files', 'memories')
  ) then
    raise exception
      'hybrid_search: invalid search_tables %. Allowed: messages, files, memories',
      v_tables;
  end if;

  if 'memories' = any(v_tables) then
    select coalesce(jsonb_agg(row_json order by score desc), '[]'::jsonb)
    into v_memories
    from (
      with base as (
        select *
        from memories
        where (filter_type is null or type = any(filter_type))
          and (filter_session_id is null or session_id = filter_session_id)
      ),
      full_text as (
        select
          id,
          row_number() over (
            order by ts_rank_cd(fts, websearch_to_tsquery(query_text)) desc
          ) as rank_ix
        from base
        where fts @@ websearch_to_tsquery(query_text)
        order by rank_ix
        limit least(match_count, 30) * 2
      ),
      semantic as (
        select
          id,
          row_number() over (order by embedding <#> query_embedding) as rank_ix
        from base
        where embedding is not null
        order by rank_ix
        limit least(match_count, 30) * 2
      )
      select
        (
          (to_jsonb(base) - 'embedding' - 'fts')
          || jsonb_build_object(
            'score',
            (
              coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
              coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
            )
          )
        ) as row_json,
        (
          coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
          coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
        ) as score
      from
        full_text
        full outer join semantic
          on full_text.id = semantic.id
        join base
          on coalesce(full_text.id, semantic.id) = base.id
      order by score desc
      limit least(match_count, 30)
    ) ranked;
  end if;

  if 'messages' = any(v_tables) then
    select coalesce(jsonb_agg(row_json order by score desc), '[]'::jsonb)
    into v_messages
    from (
      with base as (
        select *
        from messages
        where (filter_session_id is null or session_id = filter_session_id)
          and (filter_role is null or role = any(filter_role))
      ),
      full_text as (
        select
          id,
          row_number() over (
            order by ts_rank_cd(fts, websearch_to_tsquery(query_text)) desc
          ) as rank_ix
        from base
        where fts @@ websearch_to_tsquery(query_text)
        order by rank_ix
        limit least(match_count, 30) * 2
      ),
      semantic as (
        select
          id,
          row_number() over (order by embedding <#> query_embedding) as rank_ix
        from base
        where embedding is not null
        order by rank_ix
        limit least(match_count, 30) * 2
      )
      select
        (
          (to_jsonb(base) - 'embedding' - 'fts')
          || jsonb_build_object(
            'score',
            (
              coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
              coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
            )
          )
        ) as row_json,
        (
          coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
          coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
        ) as score
      from
        full_text
        full outer join semantic
          on full_text.id = semantic.id
        join base
          on coalesce(full_text.id, semantic.id) = base.id
      order by score desc
      limit least(match_count, 30)
    ) ranked;
  end if;

  if 'files' = any(v_tables) then
    select coalesce(jsonb_agg(row_json order by score desc), '[]'::jsonb)
    into v_files
    from (
      with base as (
        select *
        from files
        where (filter_bucket is null or bucket = filter_bucket)
          and (
            filter_object_path_prefix is null
            or object_path like filter_object_path_prefix || '%'
          )
      ),
      full_text as (
        select
          id,
          row_number() over (
            order by ts_rank_cd(fts, websearch_to_tsquery(query_text)) desc
          ) as rank_ix
        from base
        where fts @@ websearch_to_tsquery(query_text)
        order by rank_ix
        limit least(match_count, 30) * 2
      ),
      semantic as (
        select
          id,
          row_number() over (order by embedding <#> query_embedding) as rank_ix
        from base
        where embedding is not null
        order by rank_ix
        limit least(match_count, 30) * 2
      )
      select
        (
          (to_jsonb(base) - 'embedding' - 'fts')
          || jsonb_build_object(
            'score',
            (
              coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
              coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
            )
          )
        ) as row_json,
        (
          coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
          coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
        ) as score
      from
        full_text
        full outer join semantic
          on full_text.id = semantic.id
        join base
          on coalesce(full_text.id, semantic.id) = base.id
      order by score desc
      limit least(match_count, 30)
    ) ranked;
  end if;

  return jsonb_build_object(
    'messages', v_messages,
    'files', v_files,
    'memories', v_memories
  );
end;
$$;

-- Storage buckets
insert into storage.buckets (id, name, public)
values ('workspace', 'workspace', false)
on conflict (id) do nothing;

-- ============================================================================
-- Security posture (recommended hardening)
-- ============================================================================
-- This project is intended to be single-user (Chat provider bot + Edge Functions).
-- Supabase exposes SQL functions in exposed schemas (e.g. `public`) as RPC endpoints.
-- PostgreSQL defaults grant EXECUTE on functions to PUBLIC, which includes `anon` and `authenticated`.
-- Locking down function EXECUTE prevents abuse (e.g. enqueueing jobs / triggering LLM spend).
--
-- References:
-- - Hardening the Data API: https://supabase.com/docs/guides/database/hardening-data-api
-- - Securing your API: https://supabase.com/docs/guides/api/securing-your-api

-- Prevent schema-poisoning/search_path attacks: don't let PUBLIC create objects in `public`.
revoke create on schema public from public;

-- Restrict internal RPCs to backend-only (`service_role`).
-- These functions are used by Edge Functions + cron and should not be callable via PostgREST.
revoke execute on function public.enqueue_job(text, text, jsonb, timestamptz, int) from public;
grant execute on function public.enqueue_job(text, text, jsonb, timestamptz, int) to service_role;

revoke execute on function public.ingest_inbound_text(text, text, text, text, text, text, int) from public;
grant execute on function public.ingest_inbound_text(text, text, text, text, text, text, int) to service_role;

revoke execute on function public.claim_jobs(text, int, int) from public;
grant execute on function public.claim_jobs(text, int, int) to service_role;

revoke execute on function public.job_succeed(bigint) from public;
grant execute on function public.job_succeed(bigint) to service_role;

revoke execute on function public.job_fail(bigint, text, int) from public;
grant execute on function public.job_fail(bigint, text, int) to service_role;

revoke execute on function public.enqueue_due_tasks() from public;
grant execute on function public.enqueue_due_tasks() to service_role;

revoke execute on function public.enqueue_embedding_job() from public;
grant execute on function public.enqueue_embedding_job() to service_role;

revoke execute on function public.hybrid_search(
  text,
  extensions.vector(384),
  int,
  text[],
  enum_memory_type[],
  uuid,
  enum_message_role[],
  text,
  text,
  float,
  float,
  int
) from public;
grant execute on function public.hybrid_search(
  text,
  extensions.vector(384),
  int,
  text[],
  enum_memory_type[],
  uuid,
  enum_message_role[],
  text,
  text,
  float,
  float,
  int
) to service_role;

-- Make future functions private by default (run once as the migration author).
alter default privileges in schema public revoke execute on functions from public;

-- Example: if you ever want a single safe function callable from client sessions:
-- revoke execute on function public.some_safe_rpc(...) from public;
-- grant execute on function public.some_safe_rpc(...) to authenticated;