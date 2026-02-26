import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createServiceClient } from "../_shared/supabase.ts";
import { runAgent, DuplicateInboundError } from "../_shared/agent.ts";
import { updateTaskAfterRun } from "../_shared/tasks.ts";
import { mustGetEnv, timingSafeEqual, jsonResponse, textResponse } from "../_shared/helpers.ts";
import { logger } from "../_shared/logger.ts";

const bot = new Chat({
  userName: "supaclaw",
  adapters: { slack: createSlackAdapter() },
  state: createMemoryState(),
});

async function handleSlackMessage(
  thread: { id: string; post(content: ReadableStream<string> | string): Promise<unknown> },
  message: { id: string; text: string; author: { userId: string; isMe: boolean } },
) {
  const content = (message.text ?? "").trim();
  if (!content) return;

  try {
    const result = await runAgent({
      channel: "slack",
      channelChatId: thread.id,
      userMessage: {
        content,
        channelUpdateId: message.id,
        channelMessageId: message.id,
        channelFromUserId: message.author.userId,
      },
    });
    await thread.post(result.textStream);
  } catch (err) {
    if (err instanceof DuplicateInboundError) return;
    logger.error("slack.agent_error", { error: err });
    await thread.post("I hit an error. Please try again.").catch(() => {});
  }
}

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await handleSlackMessage(thread, message);
});

bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;
  await handleSlackMessage(thread, message);
});

// ── Cron: process due tasks for Slack sessions ──────────────────────

async function handleCron(req: Request) {
  const secret = mustGetEnv("WORKER_SECRET");
  if (!timingSafeEqual(secret, req.headers.get("x-worker-secret") ?? "")) {
    return textResponse("forbidden", { status: 403 });
  }
  const supabase = createServiceClient();

  const { data: tasks, error } = await supabase
    .from("tasks")
    .select("id, prompt, task_type, session_id, sessions!inner(channel_chat_id)")
    .not("enabled_at", "is", null)
    .not("next_run_at", "is", null)
    .lte("next_run_at", new Date().toISOString())
    .eq("sessions.channel", "slack");
  if (error) {
    logger.error("slack.cron.query_failed", { error });
    return jsonResponse({ ok: false, error: error.message }, { status: 500 });
  }
  if (!tasks?.length) return jsonResponse({ ok: true, processed: 0 });

  const results: Array<{ taskId: number; ok: boolean; error?: string }> = [];

  for (const task of tasks) {
    const joined = task.sessions as unknown as { channel_chat_id: string };
    const threadId = joined.channel_chat_id;
    const taskType = (task.task_type as string) || "reminder";
    const prompt = task.prompt as string;

    try {
      // Prevent re-processing on next cron tick
      await supabase.from("tasks").update({ next_run_at: null }).eq("id", task.id);

      const role = taskType === "agent_turn" ? "user" as const : "system" as const;
      const content = taskType === "reminder" ? `Reminder: ${prompt}` : prompt;

      const result = await runAgent({
        channel: "slack",
        channelChatId: threadId,
        userMessage: {
          content,
          role,
          channelUpdateId: `task:${task.id}:${Date.now()}`,
        },
      });

      const channelId = threadId.split(":").slice(0, 2).join(":");
      await bot.channel(channelId).post(result.textStream);

      await updateTaskAfterRun(task.id);
      results.push({ taskId: task.id, ok: true });
      logger.info("slack.cron.task_done", { taskId: task.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("slack.cron.task_failed", { taskId: task.id, error: msg });
      await updateTaskAfterRun(task.id);
      results.push({ taskId: task.id, ok: false, error: msg });
    }
  }

  return jsonResponse({ ok: true, processed: results.length, results });
}

// ── Server ──────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const { pathname } = new URL(req.url);
  if (req.method === "POST" && pathname.endsWith("/cron")) return await handleCron(req);
  if (req.method === "POST") return await bot.webhooks.slack(req);
  return new Response("ok");
});
