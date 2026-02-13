-- Extensions
create schema if not exists extensions;

create extension if not exists pgcrypto;
create extension if not exists vector with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
create extension if not exists supabase_vault cascade;

-- Enums
create type enum_session_channel as enum ('telegram', 'slack', 'whatsapp', 'discord', 'imessage', 'phone');
create type enum_message_role as enum ('assistant', 'user', 'system');
create type enum_memory_type as enum ('summary', 'pinned_fact');
create type enum_job_type as enum ('process_message', 'embed_memory', 'embed_message', 'embed_file', 'trigger');

-- Tables
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  channel enum_session_channel not null,
  channel_chat_id text not null,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, channel_chat_id)
);

alter table sessions enable row level security;

-- External/provider identifiers are stored as text to avoid JS number precision loss.
alter table sessions
  alter column channel_chat_id type text using channel_chat_id::text;

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
  provider text not null default 'telegram',
  provider_update_id text,
  telegram_message_id text,
  telegram_chat_id text,
  telegram_from_user_id text,
  telegram_sent_at timestamptz,
  file_id uuid references files(id),
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table messages enable row level security;
alter table messages
  alter column provider_update_id type text using provider_update_id::text;
alter table messages
  alter column telegram_message_id type text using telegram_message_id::text;
alter table messages
  alter column telegram_chat_id type text using telegram_chat_id::text;
alter table messages
  alter column telegram_from_user_id type text using telegram_from_user_id::text;

create unique index if not exists messages_provider_update_id_uniq
  on messages (provider, provider_update_id)
  where provider_update_id is not null;

create index if not exists messages_session_created_idx
  on messages (session_id, created_at desc);

create unique index if not exists messages_unique_assistant_reply_idx
  on messages (reply_to_message_id)
  where role = 'assistant' and reply_to_message_id is not null;

create index if not exists messages_fts_idx on messages using gin(fts);
create index if not exists messages_embedding_idx on messages using hnsw (embedding vector_ip_ops);

create table if not exists memories (
  id bigint generated always as identity primary key,
  session_id uuid references sessions(id) on delete cascade,
  type enum_memory_type not null,
  content text not null,
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

create index if not exists jobs_due_idx 
  on jobs (status, run_at, id);

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
  values (p_dedupe_key, p_type, p_payload, p_run_at, p_max_attempts, now())
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


-- Enqueue embedding jobs whenever memory content changes (or is inserted).
create or replace function enqueue_memory_embedding_job()
returns trigger
language plpgsql
as $$
declare
  v_key text;
begin
  v_key := 'memory:embed:' || new.id::text;
  perform enqueue_job(
    p_dedupe_key => v_key,
    p_type => 'embed_memory',
    p_payload => jsonb_build_object('memory_id', new.id),
    p_run_at => now(),
    p_max_attempts => 20
  );

  return new;
$$;

create or replace function enqueue_file_embedding_job()
returns trigger
language plpgsql
as $$
declare
  v_key text;
begin
  v_key := 'file:embed:' || new.id::text;
  perform enqueue_job(
    p_dedupe_key => v_key,
    p_type => 'embed_file',
    p_payload => jsonb_build_object('file_id', new.id),
    p_run_at => now(),
    p_max_attempts => 20
  );

  return new;
$$;

create or replace function enqueue_message_embedding_job()
returns trigger
language plpgsql
as $$
declare
  v_key text;
begin
  v_key := 'message:embed:' || new.id::text;
  perform enqueue_job(
    p_dedupe_key => v_key,
    p_type => 'embed_message',
    p_payload => jsonb_build_object('message_id', new.id),
    p_run_at => now(),
    p_max_attempts => 20
  );

  return new;
end;
$$;

create trigger memories_enqueue_embed_on_insert
after insert on memories
for each row
execute function enqueue_memory_embedding_job();

create trigger memories_enqueue_embed_on_update
after update of content, type on memories
for each row
execute function enqueue_memory_embedding_job();

create trigger files_enqueue_embed_on_insert
after insert on files
for each row
execute function enqueue_file_embedding_job();

create trigger files_enqueue_embed_on_update
after update of name, content on files
for each row
execute function enqueue_file_embedding_job();

create trigger messages_enqueue_embed_on_insert
after insert on messages
for each row
execute function enqueue_message_embedding_job();

create trigger messages_enqueue_embed_on_update
after update of content on messages
for each row
execute function enqueue_message_embedding_job();

-- Hybrid search (RRF fusion) over memories with optional filters.
-- Based on Supabase docs: https://supabase.com/docs/guides/ai/hybrid-search
create or replace function hybrid_search_memories(
  query_text text,
  query_embedding extensions.vector(384),
  match_count int,
  filter_type enum_memory_type[] default null,
  filter_session_id uuid default null,
  full_text_weight float default 1,
  semantic_weight float default 1,
  rrf_k int default 50
)
returns setof memories
language sql
as $$
with base as (
  select *
  from memories
  where (filter_type is null or type = any(filter_type))
    and (filter_session_id is null or session_id = filter_session_id)
),
full_text as (
  select
    id,
    row_number() over(order by ts_rank_cd(fts, websearch_to_tsquery(query_text)) desc) as rank_ix
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
  base.*
from
  full_text
  full outer join semantic
    on full_text.id = semantic.id
  join base
    on coalesce(full_text.id, semantic.id) = base.id
order by
  coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
  coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
  desc
limit
  least(match_count, 30)
$$;

-- Hybrid search (RRF fusion) over messages with optional filters.
create or replace function hybrid_search_messages(
  query_text text,
  query_embedding extensions.vector(384),
  match_count int,
  filter_session_id uuid default null,
  filter_role enum_message_role[] default null,
  full_text_weight float default 1,
  semantic_weight float default 1,
  rrf_k int default 50
)
returns setof messages
language sql
as $$
with base as (
  select *
  from messages
  where (filter_session_id is null or session_id = filter_session_id)
    and (filter_role is null or role = any(filter_role))
),
full_text as (
  select
    id,
    row_number() over(order by ts_rank_cd(fts, websearch_to_tsquery(query_text)) desc) as rank_ix
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
  base.*
from
  full_text
  full outer join semantic
    on full_text.id = semantic.id
  join base
    on coalesce(full_text.id, semantic.id) = base.id
order by
  coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
  coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
  desc
limit
  least(match_count, 30)
$$;

-- Hybrid search (RRF fusion) over files with optional filters.
create or replace function hybrid_search_files(
  query_text text,
  query_embedding extensions.vector(384),
  match_count int,
  filter_bucket text default null,
  filter_object_path_prefix text default null,
  full_text_weight float default 1,
  semantic_weight float default 1,
  rrf_k int default 50
)
returns setof files
language sql
as $$
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
    row_number() over(order by ts_rank_cd(fts, websearch_to_tsquery(query_text)) desc) as rank_ix
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
  base.*
from
  full_text
  full outer join semantic
    on full_text.id = semantic.id
  join base
    on coalesce(full_text.id, semantic.id) = base.id
order by
  coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
  coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
  desc
limit
  least(match_count, 30)
$$;