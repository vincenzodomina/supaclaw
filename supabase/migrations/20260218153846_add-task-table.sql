create type "public"."enum_schedule_type" as enum ('once', 'recurring');

create type "public"."enum_task_type" as enum ('reminder', 'agent_turn', 'backlog');

alter type "public"."enum_job_type" rename to "enum_job_type__old_version_to_be_dropped";

create type "public"."enum_job_type" as enum ('process_message', 'embed_memory', 'embed_message', 'embed_file', 'trigger', 'run_task');


  create table "public"."tasks" (
    "id" bigint generated always as identity not null,
    "name" text not null,
    "description" text,
    "prompt" text not null,
    "schedule_type" public.enum_schedule_type,
    "run_at" timestamp with time zone,
    "cron_expr" text,
    "timezone" text not null default 'UTC'::text,
    "task_type" public.enum_task_type not null default 'reminder'::public.enum_task_type,
    "session_id" uuid,
    "enabled_at" timestamp with time zone default now(),
    "next_run_at" timestamp with time zone,
    "last_run_at" timestamp with time zone,
    "last_error" text,
    "run_count" integer not null default 0,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."tasks" enable row level security;

alter table "public"."jobs" alter column type type "public"."enum_job_type" using type::text::"public"."enum_job_type";

drop type "public"."enum_job_type__old_version_to_be_dropped";

CREATE INDEX tasks_due_idx ON public.tasks USING btree (enabled_at, next_run_at) WHERE ((enabled_at IS NOT NULL) AND (next_run_at IS NOT NULL));

CREATE UNIQUE INDEX tasks_pkey ON public.tasks USING btree (id);

alter table "public"."tasks" add constraint "tasks_pkey" PRIMARY KEY using index "tasks_pkey";

alter table "public"."tasks" add constraint "tasks_session_id_fkey" FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL not valid;

alter table "public"."tasks" validate constraint "tasks_session_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.enqueue_due_tasks()
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
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
$function$
;

grant delete on table "public"."tasks" to "anon";

grant insert on table "public"."tasks" to "anon";

grant references on table "public"."tasks" to "anon";

grant select on table "public"."tasks" to "anon";

grant trigger on table "public"."tasks" to "anon";

grant truncate on table "public"."tasks" to "anon";

grant update on table "public"."tasks" to "anon";

grant delete on table "public"."tasks" to "authenticated";

grant insert on table "public"."tasks" to "authenticated";

grant references on table "public"."tasks" to "authenticated";

grant select on table "public"."tasks" to "authenticated";

grant trigger on table "public"."tasks" to "authenticated";

grant truncate on table "public"."tasks" to "authenticated";

grant update on table "public"."tasks" to "authenticated";

grant delete on table "public"."tasks" to "service_role";

grant insert on table "public"."tasks" to "service_role";

grant references on table "public"."tasks" to "service_role";

grant select on table "public"."tasks" to "service_role";

grant trigger on table "public"."tasks" to "service_role";

grant truncate on table "public"."tasks" to "service_role";

grant update on table "public"."tasks" to "service_role";


