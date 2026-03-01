import { createServiceClient } from "./supabase.ts";
import { computeNextRun } from "./tools/cron.ts";
import type { TablesUpdate } from "./database.types.ts";

const supabase = createServiceClient();

export async function updateTaskAfterRun(
  taskId: number,
  queueMsgId?: string,
) {
  const { data: task, error } = await supabase
    .from("tasks")
    .select("schedule_type, cron_expr, timezone, run_count")
    .eq("id", taskId)
    .maybeSingle();
  if (error || !task) return;

  const patch: TablesUpdate<"tasks"> = {
    last_run_at: new Date().toISOString(),
    run_count: task.run_count + 1,
    last_error: null,
    ...(typeof queueMsgId === "string" && queueMsgId.trim()
      ? { last_processed_queue_msg_id: queueMsgId.trim() }
      : {}),
    updated_at: new Date().toISOString(),
  };

  if (task.schedule_type === "recurring" && task.cron_expr) {
    const next = computeNextRun(task.cron_expr, task.timezone ?? "UTC");
    patch.next_run_at = next?.toISOString() ?? null;
  } else if (task.schedule_type === "once") {
    patch.completed_at = new Date().toISOString();
  }

  await supabase.from("tasks").update(patch).eq("id", taskId);
}
