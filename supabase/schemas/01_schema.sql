-- Extensions
create schema if not exists extensions;

create extension if not exists pgcrypto;
create extension if not exists vector with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pgmq;
create extension if not exists supabase_vault cascade;

-- Supabase schema apply may run with an empty search_path.
set search_path = public, extensions;

-- Enums
create type enum_channel_provider as enum ('telegram', 'slack', 'teams', 'whatsapp', 'discord', 'imessage', 'phone', 'email', 'web', 'mobile', 'desktop', 'api');
create type enum_message_role as enum ('assistant', 'user', 'system');
create type enum_message_type as enum ('text', 'tool-call', 'file');
create type enum_message_tool_status as enum ('started', 'succeeded', 'failed');
create type enum_memory_type as enum ('summary', 'pinned_fact', 'note');
create type enum_schedule_type as enum ('once', 'recurring');
create type enum_file_processing_status as enum ('pending', 'processing', 'succeeded', 'failed', 'skipped');

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
  -- File processing pipeline state (OCR/page artifacts)
  processing_status enum_file_processing_status not null default 'pending',
  processed_at timestamptz,
  page_count int,
  last_error text,
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

create unique index if not exists messages_session_update_id_uniq
  on messages (session_id, channel_update_id)
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

create table if not exists tasks (
  id bigint generated always as identity primary key,
  name text not null,
  description text,
  prompt text,
  schedule_type enum_schedule_type,
  run_at timestamptz,
  cron_expr text,
  timezone text not null default 'UTC',
  include_session_history boolean not null default false,
  session_id uuid references sessions(id) on delete set null,
  enabled_at timestamptz default now(),
  next_run_at timestamptz,
  last_run_at timestamptz,
  completed_at timestamptz,
  -- Last message IDs observed in the `pgmq` queue for idempotency/observability.
  last_enqueued_queue_msg_id text,
  last_processed_queue_msg_id text,
  last_error text,
  run_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tasks enable row level security;

create index if not exists tasks_due_idx
  on tasks (enabled_at, next_run_at)
  where enabled_at is not null and next_run_at is not null;

-- PGMQ queue (Supabase Queues)
-- Single queue: `jobs` (created once during bootstrap).
do $$
begin
  if not exists (select 1 from pgmq.list_queues() where queue_name = 'jobs') then
    perform pgmq.create('jobs');
  end if;
end;
$$;

-- Minimal RPC wrappers for Edge Functions (PostgREST only exposes `public`).
create or replace function public.queue_send(p_msg jsonb, p_delay int default 0)
returns text
language plpgsql
as $$
declare
  v_msg_id bigint;
begin
  select * into v_msg_id from pgmq.send('jobs', p_msg, p_delay);
  return v_msg_id::text;
end;
$$;

create or replace function public.queue_read(p_vt int, p_qty int)
returns jsonb
language sql
as $$
select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'msg_id', m.msg_id::text,
      'read_ct', m.read_ct,
      'enqueued_at', m.enqueued_at,
      'vt', m.vt,
      'message', m.message
    )
  ),
  '[]'::jsonb
)
from pgmq.read('jobs', p_vt, p_qty) as m;
$$;

create or replace function public.queue_delete(p_msg_id text)
returns boolean
language sql
as $$
select pgmq.delete('jobs', p_msg_id::bigint);
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
  v_msg_id bigint;
begin
  for v_task in
    select *
    from tasks
    where enabled_at is not null
      and next_run_at is not null
      and next_run_at <= now()
    for update skip locked
  loop
    select *
    into v_msg_id
    from pgmq.send(
      'jobs',
      jsonb_build_object(
        'type', 'run_task',
        'task_id', v_task.id,
        'prompt', v_task.prompt,
        'session_id', v_task.session_id
      ),
      0
    );

    -- Clear next_run_at to prevent re-enqueue on the next cron tick.
    -- The worker recomputes it for recurring tasks after successful execution.
    update tasks
    set
      next_run_at = null,
      last_enqueued_queue_msg_id = v_msg_id,
      updated_at = now()
    where id = v_task.id;

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
  v_key_prefix text := tg_argv[0];
  v_job_type text := tg_argv[1];
  v_payload_key text := tg_argv[2];
  v_msg_id bigint;
begin
  -- For message timeline rows: only embed actual text messages.
  if v_key_prefix = 'message' then
    if coalesce(new.type, 'text') <> 'text' then
      return new;
    end if;
  end if;

  select *
  into v_msg_id
  from pgmq.send(
    'jobs',
    jsonb_build_object(
      'type', v_job_type,
      v_payload_key, new.id
    ),
    0
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

-- Allow Edge Functions (service_role) to use PGMQ internals.
grant usage on schema pgmq to service_role;
grant execute on all functions in schema pgmq to service_role;
grant select, insert, update, delete on all tables in schema pgmq to service_role;
grant usage, select, update on all sequences in schema pgmq to service_role;

-- Restrict internal RPCs to backend-only (`service_role`).
-- These functions are used by Edge Functions + cron and should not be callable via PostgREST.
revoke execute on function public.enqueue_due_tasks() from public;
grant execute on function public.enqueue_due_tasks() to service_role;

revoke execute on function public.queue_send(jsonb, int) from public;
grant execute on function public.queue_send(jsonb, int) to service_role;

revoke execute on function public.queue_read(int, int) from public;
grant execute on function public.queue_read(int, int) to service_role;

revoke execute on function public.queue_delete(text) from public;
grant execute on function public.queue_delete(text) to service_role;

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