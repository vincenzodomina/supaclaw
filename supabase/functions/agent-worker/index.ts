import { createServiceClient } from "../_shared/supabase.ts";
import {
  getConfigBoolean,
  jsonResponse,
  mustGetEnv,
  summarize,
  textResponse,
  timingSafeEqual,
} from "../_shared/helpers.ts";
import {
  createTelegramDraftStream,
  TELEGRAM_STREAM_PARAMS,
  telegramEditMessageText,
  telegramSendChatAction,
  telegramSendChunkedMessage,
  telegramSendMessage,
  type TelegramStreamMode,
} from "../_shared/telegram.ts";
import { logger } from "../_shared/logger.ts";
import { runAgent } from "../_shared/agent.ts";
import { embedText } from "../_shared/embeddings.ts";
import { updateTaskAfterRun } from "../_shared/tasks.ts";
import { toolDisplay } from "../_shared/tools/index.ts";

type JobRow = {
  id: number;
  type: string;
  payload: Record<string, unknown>;
};

const supabase = createServiceClient();
const FALLBACK_REPLY =
  "I hit a temporary issue generating a response. Please try again in a moment.";
const MESSAGE_STREAM_MODE: TelegramStreamMode = TELEGRAM_STREAM_PARAMS.mode;

function isAuthorized(req: Request) {
  const expected = mustGetEnv("WORKER_SECRET");
  const actual = req.headers.get("x-worker-secret") ?? "";
  return timingSafeEqual(expected, actual);
}

async function claimJobs(workerId: string, maxJobs = 3): Promise<JobRow[]> {
  logger.debug("jobs.claim.start", { workerId, maxJobs });
  const { data, error } = await supabase.rpc("claim_jobs", {
    p_locked_by: workerId,
    p_max_jobs: maxJobs,
    p_lock_timeout_seconds: 300,
  });
  if (error) throw new Error(`claim_jobs failed: ${error.message}`);
  const jobs = (data ?? []) as JobRow[];
  logger.info("jobs.claim.done", { workerId, claimed: jobs.length });
  return jobs;
}

async function jobSucceed(jobId: number) {
  const { error } = await supabase.rpc("job_succeed", { p_job_id: jobId });
  if (error) throw new Error(`job_succeed failed: ${error.message}`);
}

async function jobFail(
  jobId: number,
  errorMessage: string,
  retryInSeconds = 60,
) {
  const { error } = await supabase.rpc("job_fail", {
    p_job_id: jobId,
    p_error: errorMessage,
    p_retry_in_seconds: retryInSeconds,
  });
  if (error) throw new Error(`job_fail failed: ${error.message}`);
}

async function processProcessMessage(job: JobRow) {
  logger.info("job.process_message.start", { jobId: job.id });
  const sessionId = job.payload.session_id as string | undefined;
  const updateId = job.payload.channel_update_id as string | undefined;
  const telegramChatId = job.payload.channel_chat_id as string | undefined;

  if (!sessionId || !updateId || !telegramChatId) {
    throw new Error("Invalid process_message payload");
  }

  const { data: inbound, error: iErr } = await supabase
    .from("messages")
    .select("id, content, created_at, channel")
    .eq("session_id", sessionId)
    .eq("channel_update_id", updateId)
    .eq("role", "user")
    .maybeSingle();
  if (iErr) throw new Error(`Failed to load inbound message: ${iErr.message}`);
  if (!inbound) {
    logger.info("job.process_message.no_inbound", {
      jobId: job.id,
      sessionId,
      updateId,
    });
    return;
  }

  // Idempotency: check for existing assistant replies
  const { data: existingReplies, error: rErr } = await supabase
    .from("messages")
    .select("id, content, channel_chat_id, channel_sent_at")
    .eq("reply_to_message_id", inbound.id)
    .eq("role", "assistant")
    .eq("type", "text")
    .order("created_at", { ascending: false })
    .limit(1);
  if (rErr) {
    throw new Error(`Failed to check existing replies: ${rErr.message}`);
  }
  const existingReply = existingReplies?.[0] ?? null;
  if (existingReply) {
    if (existingReply.channel_sent_at) return;
    logger.info("job.process_message.redeliver_pending", {
      jobId: job.id,
      replyId: existingReply.id,
    });

    const existingChatId =
      existingReply?.channel_chat_id?.toString()?.trim() || telegramChatId;
    let textToDeliver = (existingReply.content ?? "").trim();
    if (!textToDeliver) {
      logger.warn("job.process_message.redeliver_empty_content", {
        jobId: job.id,
        replyId: existingReply.id,
        inboundId: inbound.id,
      });
      textToDeliver = await runAgentHandler({
        jobId: job.id,
        channel: inbound.channel,
        channelChatId: telegramChatId,
        inboundId: inbound.id,
        telegramChatId,
      });
      const { error: repairErr } = await supabase
        .from("messages")
        .update({ content: textToDeliver })
        .eq("id", existingReply.id);
      if (repairErr) {
        throw new Error(
          `Failed to repair empty assistant message: ${repairErr.message}`,
        );
      }
    }

    await telegramSendChunkedMessage({
      chatId: existingChatId,
      text: textToDeliver,
    });

    const { error: deliveredErr } = await supabase
      .from("messages")
      .update({ channel_sent_at: new Date().toISOString() })
      .eq("id", existingReply.id);
    if (deliveredErr) {
      logger.warn("job.process_message.mark_delivered_failed", {
        jobId: job.id,
        replyId: existingReply.id,
        error: deliveredErr,
      });
    }
    logger.info("job.process_message.redelivered", {
      jobId: job.id,
      replyId: existingReply.id,
    });
    return;
  }

  // Happy path: run agent (handles placeholder + persistence) and stream to Telegram
  const reply = await runAgentHandler({
    jobId: job.id,
    channel: inbound.channel,
    channelChatId: telegramChatId,
    inboundId: inbound.id,
    telegramChatId,
    streamMode: MESSAGE_STREAM_MODE,
  });

  logger.info("job.process_message.done", {
    jobId: job.id,
    replyLength: reply.length,
  });
}

async function runAgentHandler(params: {
  jobId: number;
  channel: string;
  channelChatId: string;
  inboundId?: number;
  userMessage?: {
    content: string;
    role?: "user" | "system";
    channelUpdateId?: string;
  };
  telegramChatId: string;
  streamMode?: TelegramStreamMode;
}) {
  const showToolCalls =
    getConfigBoolean("channels.telegram.show_tool_calls") === true;
  const tgToolState = new Map<
    string,
    { tgMsgId: string; toolName: string; args: Record<string, unknown> }
  >();

  const draft = params.streamMode
    ? createTelegramDraftStream({
      chatId: params.telegramChatId,
      mode: params.streamMode,
      throttleMs: TELEGRAM_STREAM_PARAMS.throttleMs,
      minInitialChars: TELEGRAM_STREAM_PARAMS.minInitialChars,
      textLimit: TELEGRAM_STREAM_PARAMS.textLimit,
      chunkSoftLimit: TELEGRAM_STREAM_PARAMS.chunkSoftLimit,
      blockMinChars: TELEGRAM_STREAM_PARAMS.blockMinChars,
    })
    : null;
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  if (draft) {
    const sendTyping = () =>
      telegramSendChatAction({
        chatId: params.telegramChatId,
        action: "typing",
      }).catch(() => {});
    sendTyping();
    typingInterval = setInterval(sendTyping, 4_000);
  }

  let rawReply: string;
  try {
    const result = await runAgent({
      channel: params.channel,
      channelChatId: params.channelChatId,
      inboundId: params.inboundId,
      userMessage: params.userMessage,
    });
    let fullText = "";

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        fullText += part.text;
        if (draft) await draft.update(fullText);
      } else if (part.type === "tool-call" && showToolCalls) {
        const args = part.input as Record<string, unknown>;
        try {
          const startText = toolDisplay(part.toolName, args, null) ?? summarize(args);
          const tgMsgId = await telegramSendMessage({
            chatId: params.telegramChatId,
            text: `⚙️ ${part.toolName} ${startText}`,
          });
          if (tgMsgId) {
            tgToolState.set(part.toolCallId, { tgMsgId, toolName: part.toolName, args });
          }
        } catch (e) {
          logger.warn("tool-call.telegram_send_failed", { error: e });
        }
      } else if (part.type === "tool-result" && showToolCalls) {
        const state = tgToolState.get(part.toolCallId);
        if (state?.tgMsgId) {
          const doneText = toolDisplay(state.toolName, state.args, part.output) ?? summarize(part.output);
          await telegramEditMessageText({
            chatId: params.telegramChatId,
            messageId: state.tgMsgId,
            text: `✅ ${state.toolName} ${doneText}`,
          }).catch((e: unknown) =>
            logger.warn("tool-call.telegram_edit_failed", { error: e })
          );
        }
      }
    }

    rawReply = fullText.trim();
  } catch (err) {
    if (draft) await draft.clearDraft();
    const errMsg = err instanceof Error ? err.message : String(err);
    if (showToolCalls) {
      for (const [, s] of tgToolState) {
        telegramEditMessageText({
          chatId: params.telegramChatId,
          messageId: s.tgMsgId,
          text: `❌ ${s.toolName} ${summarize(errMsg)}`,
        }).catch(() => {});
      }
    }
    throw err;
  } finally {
    clearInterval(typingInterval);
  }

  const reply = rawReply;
  if (!reply) {
    logger.warn("job.process_message.reply_empty", {
      jobId: params.jobId,
    });
    if (draft) await draft.finalize(FALLBACK_REPLY);
    return FALLBACK_REPLY;
  }
  if (draft) await draft.finalize(reply);
  logger.debug("job.process_message.reply_generated", {
    jobId: params.jobId,
    replyLength: reply.length,
  });
  return reply;
}

async function processRunTask(job: JobRow) {
  const taskId = job.payload.task_id as number;
  const prompt = job.payload.prompt as string;
  const sessionId = job.payload.session_id as string;
  const taskType = (job.payload.task_type as string) || "reminder";

  if (!taskId || !prompt || !sessionId) {
    throw new Error("Invalid run_task payload");
  }

  logger.info("job.run_task.start", { jobId: job.id, taskId, taskType });

  const { data: session, error: sessErr } = await supabase
    .from("sessions")
    .select("id, channel, channel_chat_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessErr) throw new Error(`Failed to load session: ${sessErr.message}`);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.channel !== "telegram") {
    logger.info("job.run_task.skip_channel", { jobId: job.id, taskId, channel: session.channel });
    return;
  }

  const chatId = session.channel_chat_id;
  const role = taskType === "agent_turn" ? "user" as const : "system" as const;
  const content = taskType === "reminder" ? `Reminder: ${prompt}` : prompt;

  await runAgentHandler({
    jobId: job.id,
    channel: session.channel,
    channelChatId: chatId,
    userMessage: {
      content,
      role,
      channelUpdateId: `task:${taskId}:${Date.now()}`,
    },
    telegramChatId: chatId,
    streamMode: MESSAGE_STREAM_MODE,
  });

  await updateTaskAfterRun(taskId);

  logger.info("job.run_task.done", { jobId: job.id, taskId });
}

function processTrigger(job: JobRow) {
  void job;
}

type EmbedConfig = {
  table: "memories" | "messages" | "files";
  idKey: "memory_id" | "message_id" | "file_id";
};

const EMBED_CONFIG: Partial<Record<JobRow["type"], EmbedConfig>> = {
  embed_memory: { table: "memories", idKey: "memory_id" },
  embed_message: { table: "messages", idKey: "message_id" },
  embed_file: { table: "files", idKey: "file_id" },
};

async function processEmbed(job: JobRow, config: EmbedConfig) {
  logger.info("job.embed.start", {
    jobId: job.id,
    type: job.type,
    table: config.table,
  });
  const id = job.payload[config.idKey];
  if (!id) throw new Error(`Invalid ${job.type} payload`);

  const { data: row, error: loadErr } = await supabase
    .from(config.table)
    .select("id, content")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) {
    throw new Error(`Failed to load ${job.type}: ${loadErr.message}`);
  }
  if (!row) return;

  const embedding = await embedText(row.content);

  const { error: updateErr } = await supabase
    .from(config.table)
    .update({
      embedding,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updateErr) {
    throw new Error(
      `Failed to update ${job.type} embedding: ${updateErr.message}`,
    );
  }
  logger.info("job.embed.done", { jobId: job.id, type: job.type, id });
}

async function processJob(job: JobRow) {
  if (job.type === "process_message") return await processProcessMessage(job);
  if (job.type === "run_task") return await processRunTask(job);
  const embedConfig = EMBED_CONFIG[job.type];
  if (embedConfig) return await processEmbed(job, embedConfig);
  if (job.type === "trigger") return processTrigger(job);
  throw new Error(`Unknown job type: ${job.type}`);
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
    const jobs = await claimJobs(workerId, 3);
    if (jobs.length === 0) {
      logger.debug("worker.request.no_jobs", { workerId });
      return jsonResponse({ results: [] });
    }

    const results: Array<{ jobId: number; ok: boolean; error?: string }> = [];

    for (const job of jobs) {
      const jobStartedAt = Date.now();
      logger.info("worker.job.start", {
        workerId,
        jobId: job.id,
        type: job.type,
      });
      try {
        await processJob(job);
        await jobSucceed(job.id);
        results.push({ jobId: job.id, ok: true });
        logger.info("worker.job.success", {
          workerId,
          jobId: job.id,
          type: job.type,
          ms: Date.now() - jobStartedAt,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        await jobFail(job.id, msg, 60);
        results.push({ jobId: job.id, ok: false, error: msg });
        logger.error("worker.job.failed", {
          workerId,
          jobId: job.id,
          type: job.type,
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
