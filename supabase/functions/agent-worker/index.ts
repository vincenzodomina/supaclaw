import { createServiceClient } from "../_shared/supabase.ts";
import {
  getConfigBoolean,
  jsonResponse,
  mustGetEnv,
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
import {
  runAgent,
  type ToolStreamEvent,
} from "../_shared/agent.ts";
import { embedText } from "../_shared/embeddings.ts";
import { computeNextRun } from "../_shared/tools/cron.ts";

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
  const updateId = job.payload.provider_update_id as string | undefined;
  const telegramChatId = job.payload.telegram_chat_id as string | undefined;

  if (!sessionId || !updateId || !telegramChatId) {
    throw new Error("Invalid process_message payload");
  }

  // Fetch the inbound message content
  const { data: inbound, error: iErr } = await supabase
    .from("messages")
    .select("id, content, created_at")
    .eq("session_id", sessionId)
    .eq("provider_update_id", updateId)
    .eq("role", "user")
    .maybeSingle();
  if (iErr) throw new Error(`Failed to load inbound message: ${iErr.message}`);
  if (!inbound) {
    // Nothing to do (could be a duplicate update we ignored)
    logger.info("job.process_message.no_inbound", {
      jobId: job.id,
      sessionId,
      updateId,
    });
    return;
  }

  // Idempotency + retry-safe delivery:
  // - If an assistant row already exists and was delivered, do nothing.
  // - If it exists but wasn't delivered yet, deliver now and mark sent.
  const { data: existingReplies, error: rErr } = await supabase
    .from("messages")
    .select("id, content, telegram_chat_id, telegram_sent_at")
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
    if (existingReply.telegram_sent_at) return;
    logger.info("job.process_message.redeliver_pending", {
      jobId: job.id,
      replyId: existingReply.id,
    });

    const existingChatId =
      existingReply?.telegram_chat_id?.toString()?.trim() || telegramChatId;
    let textToDeliver = (existingReply.content ?? "").trim();
    if (!textToDeliver) {
      logger.warn("job.process_message.redeliver_empty_content", {
        jobId: job.id,
        replyId: existingReply.id,
        inboundId: inbound.id,
      });
      textToDeliver = await runAgentHandler({
        jobId: job.id,
        sessionId,
        inboundId: inbound.id,
        inboundContent: inbound.content,
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
      .update({ telegram_sent_at: new Date().toISOString() })
      .eq("id", existingReply.id);
    if (deliveredErr) {
      // Warn-only: message was already sent; throwing would cause a retry and duplicate delivery.
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

  // Persist assistant placeholder before delivery; retries can repair/resend this row.
  const { data: savedReply, error: saveErr } = await supabase
    .from("messages")
    .insert({
      session_id: sessionId,
      reply_to_message_id: inbound.id,
      role: "assistant",
      type: "text",
      content: "",
      provider: "telegram",
      telegram_chat_id: telegramChatId,
      telegram_sent_at: null,
    })
    .select("id")
    .single();
  if (saveErr) {
    throw new Error(`Failed to persist assistant message: ${saveErr.message}`);
  }

  const reply = await runAgentHandler({
    jobId: job.id,
    sessionId,
    inboundId: inbound.id,
    inboundContent: inbound.content,
    telegramChatId,
    streamMode: MESSAGE_STREAM_MODE,
  });

  const { error: contentErr } = await supabase
    .from("messages")
    .update({ content: reply })
    .eq("id", savedReply.id);
  if (contentErr) {
    // Warn-only: reply is already delivered; retrying would likely duplicate delivery.
    logger.warn("job.process_message.update_content_failed", {
      jobId: job.id,
      replyId: savedReply.id,
      error: contentErr,
    });
  }

  const { error: deliveredErr } = await supabase
    .from("messages")
    .update({ telegram_sent_at: new Date().toISOString() })
    .eq("id", savedReply.id);
  if (deliveredErr) {
    // Warn-only: message was already sent; throwing would cause a retry and duplicate delivery.
    logger.warn("job.process_message.mark_delivered_failed", {
      jobId: job.id,
      replyId: savedReply.id,
      error: deliveredErr,
    });
  }
  logger.info("job.process_message.done", {
    jobId: job.id,
    replyMessageId: savedReply.id,
  });
}

async function runAgentHandler(params: {
  jobId: number;
  sessionId: string;
  inboundId: number;
  inboundContent: string;
  telegramChatId: string;
  streamMode?: TelegramStreamMode;
}) {
  // Tool-call stream handler: persist each tool call as a timeline row + optional Telegram rendering
  const showToolCalls =
    getConfigBoolean("channels.telegram.show_tool_calls") === true;
  let toolSeq = 0;
  const toolState = new Map<
    string,
    { rowId: number; tgMsgId?: string; toolName: string; startedAt: number }
  >();

  const onToolEvent = async (event: ToolStreamEvent) => {
    if (event.type === "tool-call-start") {
      toolSeq++;
      const { data, error } = await supabase.from("messages").insert({
        session_id: params.sessionId,
        reply_to_message_id: params.inboundId,
        role: "system",
        type: "tool-call",
        content: JSON.stringify(event.args),
        tool_name: event.toolName,
        tool_status: "started",
        provider: "telegram",
        provider_update_id: `tool:${params.inboundId}:${event.toolCallId}`,
        telegram_chat_id: params.telegramChatId,
      }).select("id").single();

      if (error) {
        logger.warn("tool-call.insert_failed", { error: error.message });
        return;
      }

      let tgMsgId: string | undefined;
      if (showToolCalls) {
        try {
          tgMsgId = await telegramSendMessage({
            chatId: params.telegramChatId,
            text: `${event.toolName} — started`,
          });
          if (tgMsgId) {
            await supabase.from("messages")
              .update({
                telegram_message_id: tgMsgId,
                telegram_sent_at: new Date().toISOString(),
              })
              .eq("id", data.id);
          }
        } catch (e) {
          logger.warn("tool-call.telegram_send_failed", { error: e });
        }
      }

      toolState.set(event.toolCallId, {
        rowId: data.id,
        toolName: event.toolName,
        startedAt: Date.now(),
        tgMsgId,
      });
    } else {
      const state = toolState.get(event.toolCallId);
      if (!state) return;

      await supabase.from("messages").update({
        tool_status: "succeeded",
        tool_result: event.result ?? null,
        tool_duration_ms: Date.now() - state.startedAt,
      }).eq("id", state.rowId);

      if (showToolCalls && state.tgMsgId) {
        await telegramEditMessageText({
          chatId: params.telegramChatId,
          messageId: state.tgMsgId,
          text: `${event.toolName} — succeeded`,
        }).catch((e: unknown) =>
          logger.warn("tool-call.telegram_edit_failed", { error: e })
        );
      }
    }
  };

  let rawReply: string;
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
  try {
    rawReply = await runAgent({
      sessionId: params.sessionId,
      onToolEvent,
      onTextDelta: async (_delta, fullText) => {
        if (!draft) return;
        await draft.update(fullText);
      },
    });
  } catch (err) {
    if (draft) await draft.clearDraft();
    // Mark any pending tool calls as failed
    const errMsg = err instanceof Error ? err.message : String(err);
    for (const [, s] of toolState) {
      await supabase.from("messages")
        .update({
          tool_status: "failed",
          tool_error: errMsg,
          tool_duration_ms: Date.now() - s.startedAt,
        })
        .eq("id", s.rowId).eq("tool_status", "started");
      if (showToolCalls && s.tgMsgId) {
        telegramEditMessageText({
          chatId: params.telegramChatId,
          messageId: s.tgMsgId,
          text: `${s.toolName} — failed`,
        }).catch(() => {});
      }
    }
    throw err;
  } finally {
    clearInterval(typingInterval);
  }

  const reply = rawReply.trim();
  if (!reply) {
    logger.warn("job.process_message.reply_empty", {
      jobId: params.jobId,
      inboundId: params.inboundId,
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

async function updateTaskAfterRun(taskId: number) {
  const { data: task, error } = await supabase
    .from("tasks")
    .select("schedule_type, cron_expr, timezone, run_count")
    .eq("id", taskId)
    .maybeSingle();
  if (error || !task) return;

  const patch: Record<string, unknown> = {
    last_run_at: new Date().toISOString(),
    run_count: task.run_count + 1,
    last_error: null,
    updated_at: new Date().toISOString(),
  };

  if (task.schedule_type === "recurring" && task.cron_expr) {
    const next = computeNextRun(task.cron_expr, task.timezone ?? "UTC");
    patch.next_run_at = next?.toISOString() ?? null;
  } else if (task.schedule_type === "once") {
    patch.enabled_at = null;
  }

  await supabase.from("tasks").update(patch).eq("id", taskId);
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

  const chatId = session.channel_chat_id;
  const role = taskType === "agent_turn" ? "user" : "system";
  const content = taskType === "reminder" ? `Reminder: ${prompt}` : prompt;

  const { data: msg, error: msgErr } = await supabase
    .from("messages")
    .insert({
      session_id: sessionId,
      role,
      type: "text",
      content,
      provider: "system",
      provider_update_id: `task:${taskId}:${Date.now()}`,
      telegram_chat_id: chatId,
    })
    .select("id")
    .single();
  if (msgErr) {
    throw new Error(`Failed to insert task message: ${msgErr.message}`);
  }

  const { data: saved, error: saveErr } = await supabase
    .from("messages")
    .insert({
      session_id: sessionId,
      reply_to_message_id: msg.id,
      role: "assistant",
      type: "text",
      content: "",
      provider: "telegram",
      telegram_chat_id: chatId,
      telegram_sent_at: null,
    })
    .select("id")
    .single();
  if (saveErr) throw new Error(`Failed to persist reply: ${saveErr.message}`);

  const reply = await runAgentHandler({
    jobId: job.id,
    sessionId,
    inboundId: msg.id,
    inboundContent: content,
    telegramChatId: chatId,
    streamMode: MESSAGE_STREAM_MODE,
  });

  const { error: contentErr } = await supabase
    .from("messages")
    .update({ content: reply })
    .eq("id", saved.id);
  if (contentErr) {
    logger.warn("job.run_task.update_content_failed", {
      jobId: job.id,
      replyId: saved.id,
      error: contentErr,
    });
  }

  const { error: deliveredErr } = await supabase
    .from("messages")
    .update({ telegram_sent_at: new Date().toISOString() })
    .eq("id", saved.id);
  if (deliveredErr) {
    logger.warn("job.run_task.mark_delivered_failed", {
      jobId: job.id,
      replyId: saved.id,
      error: deliveredErr,
    });
  }

  await updateTaskAfterRun(taskId);

  logger.info("job.run_task.done", {
    jobId: job.id,
    taskId,
    replyId: saved.id,
  });
}

function processTrigger(job: JobRow) {
  // Trigger jobs are intentionally accepted as no-op for now.
  // This keeps trigger-webhook usable without creating retry noise.
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
