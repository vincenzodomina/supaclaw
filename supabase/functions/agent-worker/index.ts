import { createServiceClient } from "../_shared/supabase.ts";
import {
  jsonResponse,
  mustGetEnv,
  textResponse,
  timingSafeEqual,
} from "../_shared/helpers.ts";
import { logger } from "../_shared/logger.ts";
import { embedText } from "../_shared/embeddings.ts";
import { updateTaskAfterRun } from "../_shared/tasks.ts";
import { createChatBot } from "../_shared/bot.ts";
import { runAgent } from "../_shared/agent.ts";
import type { Json, Tables } from "../_shared/database.types.ts";
type SessionRow = Tables<"sessions">;

const supabase = createServiceClient();
const { bot, adapters } = createChatBot();

const QUEUE_VT_SECONDS = 15 * 60; // long enough for LLM/tool calls
const MAX_MESSAGES_PER_TICK = 3;

const FALLBACK_REPLY =
  "I hit a temporary issue generating a response. Please try again in a moment.";

type QueueMessageRecord = {
  msg_id: unknown;
  read_ct: unknown;
  enqueued_at: unknown;
  vt: unknown;
  message: Json;
};

function asQueueMsgId(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : `${value ?? ""}`.trim();
  if (!s) return null;
  // Queue message IDs are bigint; keep as string to avoid precision loss.
  if (!/^\d+$/.test(s)) return null;
  return s;
}

function normalizeThreadId(channel: string, raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value) return value;

  if (channel === "telegram") {
    return value.startsWith("telegram:") ? value : `telegram:${value}`;
  }
  if (channel === "slack") {
    return value.startsWith("slack:") ? value : `slack:${value}`;
  }
  if (channel === "teams") {
    return value.startsWith("teams:") ? value : `teams:${value}`;
  }
  if (channel === "discord") {
    return value.startsWith("discord:") ? value : `discord:${value}`;
  }
  return value;
}

function isAuthorized(req: Request) {
  const expected = mustGetEnv("WORKER_SECRET");
  const actual = req.headers.get("x-worker-secret") ?? "";
  return timingSafeEqual(expected, actual);
}

async function readMessages(
  workerId: string,
  maxMessages = MAX_MESSAGES_PER_TICK,
): Promise<QueueMessageRecord[]> {
  logger.debug("queue.read.start", { workerId, maxMessages });
  const { data, error } = await supabase.rpc("queue_read", {
    p_vt: QUEUE_VT_SECONDS,
    p_qty: maxMessages,
  });
  if (error) throw new Error(`queue_read failed: ${error.message}`);
  const messages = Array.isArray(data) ? (data as QueueMessageRecord[]) : [];
  logger.info("queue.read.done", { workerId, claimed: messages.length });
  return messages;
}

async function deleteMessage(msgId: string) {
  const { error } = await supabase.rpc("queue_delete", { p_msg_id: msgId });
  if (error) throw new Error(`queue_delete failed: ${error.message}`);
}

async function processRunTask(msgId: string, payload: Record<string, Json>) {
  const taskId = payload.task_id;
  const sessionId = payload.session_id;

  if (
    typeof taskId !== "number" || !Number.isFinite(taskId) ||
    typeof sessionId !== "string" || !sessionId.trim()
  ) throw new Error("Invalid run_task payload");

  logger.info("msg.run_task.start", { msgId, taskId });

  const { data: taskRow, error: taskErr } = await supabase
    .from("tasks")
    .select(
      "id, name, description, prompt, schedule_type, run_at, cron_expr, timezone, include_session_history, session_id, last_processed_queue_msg_id",
    )
    .eq("id", taskId)
    .maybeSingle();
  if (taskErr) throw new Error(`Failed to load task: ${taskErr.message}`);
  if (!taskRow) throw new Error(`Task not found: ${taskId}`);
  if (taskRow?.last_processed_queue_msg_id != null) {
    const last = String(taskRow.last_processed_queue_msg_id ?? "").trim();
    if (last && last === msgId) {
      logger.info("msg.run_task.skip_already_processed", { msgId, taskId });
      return;
    }
  }

  const prompt = String(taskRow.prompt ?? "").trim();
  if (!prompt) throw new Error(`Task ${taskId} has no prompt`);

  const resolvedSessionId = String(taskRow.session_id ?? sessionId).trim();
  if (!resolvedSessionId) throw new Error("Task is missing session_id");

  const { data: session, error: sessErr } = await supabase
    .from("sessions")
    .select("id, channel, channel_chat_id")
    .eq("id", resolvedSessionId)
    .maybeSingle();
  if (sessErr) throw new Error(`Failed to load session: ${sessErr.message}`);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const channel = String(session.channel ?? "").trim() as SessionRow["channel"];
  const threadId = normalizeThreadId(channel, session.channel_chat_id);
  if (!channel || !threadId) {
    throw new Error("Session is missing channel or channel_chat_id");
  }

  if (!adapters[channel]) {
    logger.info("msg.run_task.skip_missing_adapter", {
      msgId,
      taskId,
      channel,
    });
    return;
  }

  const schedule = taskRow.schedule_type === "once"
    ? `once @ ${taskRow.run_at ?? "unknown"}`
    : taskRow.schedule_type === "recurring"
    ? `recurring (${taskRow.cron_expr ?? "unknown"}) ${taskRow.timezone ?? "UTC"}`
    : "unscheduled";

  const content = [
    "This is a scheduled task.",
    `ID: ${taskId}`,
    `Name: ${taskRow.name}`,
    taskRow.description ? `Description: ${taskRow.description}` : null,
    `Schedule: ${schedule}`,
    "",
    "Task:",
    prompt,
  ].filter(Boolean).join("\n");

  const result = await runAgent({
    channel,
    channelChatId: threadId,
    userMessage: {
      content,
      role: "system",
      channelUpdateId: `task:${taskId}:${Date.now()}`,
    },
    includeSessionHistory: taskRow.include_session_history === true,
  });

  const reply = ((await result.text) ?? "").trim() || FALLBACK_REPLY;
  const adapter = bot.getAdapter(channel as never);
  await adapter.postMessage(threadId, reply);

  await updateTaskAfterRun(taskId, msgId);

  logger.info("msg.run_task.done", { msgId, taskId });
}

function processTrigger(payload: Record<string, Json>) {
  void payload;
}

type EmbedConfig = {
  table: "memories" | "messages" | "files";
  idKey: "memory_id" | "message_id" | "file_id";
};

type JobType =
  | "run_task"
  | "embed_memory"
  | "embed_message"
  | "embed_file"
  | "trigger";

const EMBED_CONFIG: Partial<Record<JobType, EmbedConfig>> = {
  embed_memory: { table: "memories", idKey: "memory_id" },
  embed_message: { table: "messages", idKey: "message_id" },
  embed_file: { table: "files", idKey: "file_id" },
};

async function processEmbed(
  msgId: string,
  jobType: JobType,
  payload: Record<string, Json>,
  config: EmbedConfig,
) {
  logger.info("msg.embed.start", {
    msgId,
    type: jobType,
    table: config.table,
  });
  const rawId = payload[config.idKey];
  const id = config.idKey === "file_id"
    ? (typeof rawId === "string" && rawId.trim() ? rawId : null)
    : (typeof rawId === "number" && Number.isFinite(rawId) ? rawId : null);
  if (id == null) throw new Error(`Invalid ${jobType} payload`);

  const { data: row, error: loadErr } = await supabase
    .from(config.table)
    .select("id, content")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) {
    throw new Error(`Failed to load ${jobType}: ${loadErr.message}`);
  }
  if (!row) return;

  const embedding = await embedText(row.content);

  const { error: updateErr } = await supabase
    .from(config.table)
    .update({
      embedding: JSON.stringify(embedding),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updateErr) {
    throw new Error(
      `Failed to update ${jobType} embedding: ${updateErr.message}`,
    );
  }
  logger.info("msg.embed.done", { msgId, type: jobType, id });
}

function parsePayload(message: Json): Record<string, Json> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    throw new Error("Invalid queue message: expected object payload");
  }
  return message as Record<string, Json>;
}

async function processMessage(msgId: string, message: Json) {
  const payload = parsePayload(message);
  const type = typeof payload.type === "string" ? payload.type : "";
  if (
    type !== "run_task" &&
    type !== "embed_memory" &&
    type !== "embed_message" &&
    type !== "embed_file" &&
    type !== "trigger"
  ) {
    throw new Error(`Unknown job type: ${type}`);
  }

  const jobType = type as JobType;
  if (jobType === "run_task") return await processRunTask(msgId, payload);
  const embedConfig = EMBED_CONFIG[jobType];
  if (embedConfig) return await processEmbed(msgId, jobType, payload, embedConfig);
  if (jobType === "trigger") return processTrigger(payload);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return textResponse("method not allowed", { status: 405 });
  }
  if (!isAuthorized(req)) return textResponse("forbidden", { status: 403 });

  const workerId = crypto.randomUUID();
  const startedAt = Date.now();
  logger.info("worker.request.start", { workerId });

  try {
    const messages = await readMessages(workerId, MAX_MESSAGES_PER_TICK);
    if (messages.length === 0) {
      logger.debug("worker.request.no_jobs", { workerId });
      return jsonResponse({ results: [] });
    }

    const results: Array<{ msgId: string; ok: boolean; error?: string }> = [];

    for (const msg of messages) {
      const jobStartedAt = Date.now();
      const msgId = asQueueMsgId((msg as QueueMessageRecord).msg_id);
      if (msgId == null) {
        logger.warn("worker.msg.skip_invalid_msg_id", { workerId });
        continue;
      }
      logger.info("worker.msg.start", { workerId, msgId });
      try {
        await processMessage(msgId, (msg as QueueMessageRecord).message);
        await deleteMessage(msgId);
        results.push({ msgId, ok: true });
        logger.info("worker.msg.success", {
          workerId,
          msgId,
          ms: Date.now() - jobStartedAt,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        // Do not delete on failure; message will re-appear after VT.
        results.push({ msgId, ok: false, error: msg });
        logger.error("worker.msg.failed", {
          workerId,
          msgId,
          error: e,
          message: msg,
          ms: Date.now() - jobStartedAt,
        });
      }
    }

    logger.info("worker.request.done", {
      workerId,
      jobs: results.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      ms: Date.now() - startedAt,
    });
    return jsonResponse({ results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    logger.error("worker.request.error", {
      workerId,
      error: e,
      message: msg,
      ms: Date.now() - startedAt,
    });
    return jsonResponse({ error: msg }, { status: 500 });
  }
});
