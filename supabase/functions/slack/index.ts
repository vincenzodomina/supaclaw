import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createServiceClient } from "../_shared/supabase.ts";
import { runAgent } from "../_shared/agent.ts";
import { updateTaskAfterRun } from "../_shared/tasks.ts";
import { mustGetEnv, timingSafeEqual, jsonResponse, textResponse } from "../_shared/helpers.ts";
import { logger } from "../_shared/logger.ts";

const supabase = createServiceClient();

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

  const { data: session, error: sessErr } = await supabase
    .from("sessions")
    .upsert(
      { channel: "slack" as const, channel_chat_id: thread.id, updated_at: new Date().toISOString() },
      { onConflict: "channel,channel_chat_id" },
    )
    .select("id")
    .single();
  if (sessErr || !session) {
    logger.error("slack.session_failed", { error: sessErr });
    await thread.post("Sorry, something went wrong. Please try again.");
    return;
  }

  const { error: inErr } = await supabase.from("messages").insert({
    session_id: session.id,
    role: "user",
    type: "text",
    content,
    channel: "slack",
    channel_update_id: message.id,
    channel_message_id: message.id,
    channel_chat_id: thread.id,
    channel_from_user_id: message.author.userId,
  });
  if (inErr?.code === "23505") return;
  if (inErr) {
    logger.error("slack.inbound_failed", { error: inErr });
    return;
  }

  try {
    const result = await runAgent({ sessionId: session.id });
    await thread.post(result.textStream);
    const reply = await result.text;
    await supabase.from("messages").insert({
      session_id: session.id,
      role: "assistant",
      type: "text",
      content: reply,
      channel: "slack",
      channel_chat_id: thread.id,
      channel_sent_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("slack.agent_error", { error: err, sessionId: session.id });
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
    const sessionId = task.session_id as string;
    const joined = task.sessions as unknown as { channel_chat_id: string };
    const threadId = joined.channel_chat_id;
    const taskType = (task.task_type as string) || "reminder";
    const prompt = task.prompt as string;

    try {
      // Prevent re-processing on next cron tick
      await supabase.from("tasks").update({ next_run_at: null }).eq("id", task.id);

      const role = taskType === "agent_turn" ? "user" : "system";
      const content = taskType === "reminder" ? `Reminder: ${prompt}` : prompt;

      await supabase.from("messages").insert({
        session_id: sessionId,
        role,
        type: "text",
        content,
        channel: "slack",
        channel_update_id: `task:${task.id}:${Date.now()}`,
        channel_chat_id: threadId,
      });

      const result = await runAgent({ sessionId });
      const channelId = threadId.split(":").slice(0, 2).join(":");
      await bot.channel(channelId).post(result.textStream);
      const reply = await result.text;

      await supabase.from("messages").insert({
        session_id: sessionId,
        role: "assistant",
        type: "text",
        content: reply,
        channel: "slack",
        channel_chat_id: threadId,
        channel_sent_at: new Date().toISOString(),
      });

      await updateTaskAfterRun(task.id);
      results.push({ taskId: task.id, ok: true });
      logger.info("slack.cron.task_done", { taskId: task.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("slack.cron.task_failed", { taskId: task.id, error: msg });
      // Restore next_run_at so it can be retried
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
