import { jsonSchema, tool } from "ai";
import { Cron } from "croner";
import { createServiceClient } from "../supabase.ts";
import type { TablesUpdate } from "../database.types.ts";

const supabase = createServiceClient();

export function computeNextRun(cronExpr: string, timezone = "UTC"): Date | null {
  const cron = new Cron(cronExpr, { timezone });
  return cron.nextRun() ?? null;
}

type CronArgs = {
  action: "list" | "add" | "update" | "remove";
  name?: string;
  description?: string;
  schedule_type?: "once" | "recurring";
  run_at?: string;
  cron_expr?: string;
  timezone?: string;
  prompt?: string;
  include_session_history?: boolean;
  enabled?: boolean;
  id?: number;
  include_disabled?: boolean;
  include_completed?: boolean;
};

async function listTasks(args: CronArgs) {
  let query = supabase
    .from("tasks")
    .select("id, name, description, prompt, schedule_type, run_at, cron_expr, timezone, include_session_history, enabled_at, completed_at, next_run_at, last_run_at, last_error, run_count, created_at");
  if (!args.include_disabled) query = query.not("enabled_at", "is", null);
  if (!args.include_completed) query = query.is("completed_at", null);
  const { data, error } = await query.order("next_run_at", { ascending: true, nullsFirst: false });
  if (error) throw new Error(error.message);
  return { tasks: data };
}

async function addTask(sessionId: string, args: CronArgs) {
  if (!args.name?.trim()) throw new Error("name is required");
  if (!args.prompt?.trim()) throw new Error("prompt is required");

  let nextRunAt: string | null = null;

  if (args.schedule_type === "once") {
    if (!args.run_at) throw new Error("run_at is required for once schedules");
    const d = new Date(args.run_at);
    if (isNaN(d.getTime())) throw new Error("Invalid run_at timestamp");
    nextRunAt = d.toISOString();
  } else if (args.schedule_type === "recurring") {
    if (!args.cron_expr) throw new Error("cron_expr is required for recurring schedules");
    const next = computeNextRun(args.cron_expr, args.timezone);
    if (!next) throw new Error("Could not compute next run from cron expression");
    nextRunAt = next.toISOString();
  }

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      name: args.name!.trim(),
      description: args.description?.trim() || null,
      prompt: args.prompt!.trim(),
      schedule_type: args.schedule_type || null,
      run_at: args.schedule_type === "once" ? args.run_at : null,
      cron_expr: args.schedule_type === "recurring" ? args.cron_expr : null,
      timezone: args.timezone || "UTC",
      include_session_history: args.include_session_history === true,
      session_id: sessionId,
      enabled_at: args.enabled === false ? null : new Date().toISOString(),
      next_run_at: nextRunAt,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return { task: data };
}

async function updateTask(args: CronArgs) {
  if (!args.id) throw new Error("id is required");

  const { data: existing, error: loadErr } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", args.id)
    .maybeSingle();
  if (loadErr) throw new Error(loadErr.message);
  if (!existing) throw new Error("Task not found");

  const patch: TablesUpdate<"tasks"> = { updated_at: new Date().toISOString() };

  if (args.name !== undefined) patch.name = args.name.trim();
  if (args.description !== undefined) patch.description = args.description?.trim() || null;
  if (args.prompt !== undefined) patch.prompt = args.prompt.trim();
  if (args.include_session_history !== undefined) {
    patch.include_session_history = args.include_session_history === true;
  }
  if (args.enabled !== undefined) patch.enabled_at = args.enabled ? new Date().toISOString() : null;
  if (args.timezone !== undefined) patch.timezone = args.timezone;
  if (args.schedule_type !== undefined) patch.schedule_type = args.schedule_type || null;
  if (args.run_at !== undefined) patch.run_at = args.run_at;
  if (args.cron_expr !== undefined) patch.cron_expr = args.cron_expr;

  const scheduleChanged =
    args.schedule_type !== undefined ||
    args.run_at !== undefined ||
    args.cron_expr !== undefined ||
    args.timezone !== undefined;

  if (scheduleChanged) {
    const type = (args.schedule_type ?? existing.schedule_type) as string | null;
    const runAt = (args.run_at ?? existing.run_at) as string | null;
    const expr = (args.cron_expr ?? existing.cron_expr) as string | null;
    const tz = (args.timezone ?? existing.timezone) as string;

    if (type === "once" && runAt) {
      const d = new Date(runAt);
      patch.next_run_at = isNaN(d.getTime()) ? null : d.toISOString();
    } else if (type === "recurring" && expr) {
      const next = computeNextRun(expr, tz);
      patch.next_run_at = next?.toISOString() ?? null;
    } else {
      patch.next_run_at = null;
    }
  }

  const { data, error } = await supabase
    .from("tasks")
    .update(patch)
    .eq("id", args.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return { task: data };
}

async function removeTask(args: CronArgs) {
  if (!args.id) throw new Error("id is required");
  const { error } = await supabase.from("tasks").delete().eq("id", args.id);
  if (error) throw new Error(error.message);
  return { ok: true, id: args.id };
}

export function createCronTool(sessionId: string) {
  return tool({
    description: [
      "Manage tasks: reminders, scheduled jobs, and backlog items.",
      "",
      "FIELDS:",
      "- prompt: What gets executed at runtime (it becomes the agent input when the task fires).",
      "- description: Human-readable context only (for inspecting tasks); not the runtime input.",
      "",
      "ACTIONS:",
      "- list: List tasks (optional: include_disabled to show disabled tasks too)",
      "- add: Create a task (requires: name, prompt; schedule is optional)",
      "- update: Modify a task (requires: id, plus fields to change)",
      "- remove: Delete a task (requires: id)",
      "",
      "SCHEDULE (optional — omit schedule_type for backlog items):",
      '- One-shot: set schedule_type="once" and run_at to an ISO-8601 timestamp.',
      '- Recurring: set schedule_type="recurring" and cron_expr to a 5-field cron expression, with optional timezone (default UTC).',
      "",
      "HISTORY:",
      "- include_session_history (default false): when true, the scheduled agent run includes recent session history; otherwise it runs in isolation.",
      "",
      "DEFAULTS: include_session_history=false, timezone=UTC, enabled=true (enabled_at is set automatically).",
      "ISO timestamps without a timezone offset are treated as UTC.",
      "Cron expressions use standard 5-field format: minute hour day month weekday.",
    ].join("\n"),
    inputSchema: jsonSchema<CronArgs>({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "update", "remove"],
          description: "Action to perform.",
        },
        name: { type: "string", description: "Human-readable task name." },
        description: { type: "string", description: "Optional task description." },
        schedule_type: {
          type: "string",
          enum: ["once", "recurring"],
          description: "once = one-shot, recurring = cron-based repeat. Omit for backlog items.",
        },
        run_at: { type: "string", description: "ISO-8601 timestamp for once schedules." },
        cron_expr: { type: "string", description: "5-field cron expression for recurring schedules." },
        timezone: { type: "string", description: "IANA timezone for cron_expr (default UTC)." },
        prompt: { type: "string", description: "The text/prompt for the task." },
        include_session_history: {
          type: "boolean",
          description:
            "When true, scheduled run includes recent session history; default false (isolated).",
        },
        enabled: { type: "boolean", description: "Enable or disable the task." },
        id: { type: "number", description: "Task ID (required for update/remove)." },
        include_disabled: { type: "boolean", description: "Include disabled tasks in list results." },
        include_completed: { type: "boolean", description: "Include completed one-shot tasks in list results." },
      },
      required: ["action"],
      additionalProperties: false,
    }),
    execute: async (args: CronArgs) => {
      try {
        if (args.action === "list") return await listTasks(args);
        if (args.action === "add") return await addTask(sessionId, args);
        if (args.action === "update") return await updateTask(args);
        if (args.action === "remove") return await removeTask(args);
        return { error: `Unknown action: ${args.action}` };
      } catch (e) {
        return { error: `Cron tool error: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  });
}
