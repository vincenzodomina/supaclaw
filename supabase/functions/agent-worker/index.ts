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

  // Fetch the inbound message content
  const { data: inbound, error: iErr } = await supabase
    .from("messages")
    .select("id, content, created_at, channel")
    .eq("session_id", sessionId)
    .eq("channel_update_id", updateId)
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
        sessionId,
        inboundId: inbound.id,
        inboundContent: inbound.content,
        telegramChatId,
        channel: inbound.channel,
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
      channel: inbound.channel,
      channel_chat_id: telegramChatId,
      channel_sent_at: null,
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
    channel: inbound.channel,
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
    .update({ channel_sent_at: new Date().toISOString() })
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
  channel: string;
  streamMode?: TelegramStreamMode;
}) {
  const showToolCalls =
    getConfigBoolean("channels.telegram.show_tool_calls") === true;
  const toolState = new Map<
    string,
    { rowId: number; tgMsgId?: string; toolName: string; args: Record<string, unknown>; startedAt: number }
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
    const result = await runAgent({ sessionId: params.sessionId });
    let fullText = "";

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        fullText += part.text;
        if (draft) await draft.update(fullText);
      } else if (part.type === "tool-call") {
        const args = part.input as Record<string, unknown>;
        const { data, error } = await supabase.from("messages").insert({
          session_id: params.sessionId,
          reply_to_message_id: params.inboundId,
          role: "system",
          type: "tool-call",
          content: JSON.stringify(args),
          tool_name: part.toolName,
          tool_status: "started",
          channel: "telegram",
          channel_update_id: `tool:${params.inboundId}:${part.toolCallId}`,
          channel_chat_id: params.telegramChatId,
        }).select("id").single();

        if (error) {
          logger.warn("tool-call.insert_failed", { error: error.message });
        } else {
          let tgMsgId: string | undefined;
          if (showToolCalls) {
            try {
              const startText = toolDisplay(part.toolName, args, null) ?? summarize(args);
              tgMsgId = await telegramSendMessage({
                chatId: params.telegramChatId,
                text: `⚙️ ${part.toolName} ${startText}`,
              });
              if (tgMsgId) {
                await supabase.from("messages")
                  .update({
                    channel_message_id: tgMsgId,
                    channel_sent_at: new Date().toISOString(),
                  })
                  .eq("id", data.id);
              }
            } catch (e) {
              logger.warn("tool-call.telegram_send_failed", { error: e });
            }
          }
          toolState.set(part.toolCallId, {
            rowId: data.id,
            toolName: part.toolName,
            args,
            startedAt: Date.now(),
            tgMsgId,
          });
        }
      } else if (part.type === "tool-result") {
        const state = toolState.get(part.toolCallId);
        if (state) {
          await supabase.from("messages").update({
            tool_status: "succeeded",
            tool_result: part.output ?? null,
            tool_duration_ms: Date.now() - state.startedAt,
          }).eq("id", state.rowId);

          if (showToolCalls && state.tgMsgId) {
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
    }

    rawReply = fullText.trim();
  } catch (err) {
    if (draft) await draft.clearDraft();
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
  const role = taskType === "agent_turn" ? "user" : "system";
  const content = taskType === "reminder" ? `Reminder: ${prompt}` : prompt;

  const { data: msg, error: msgErr } = await supabase
    .from("messages")
    .insert({
      session_id: sessionId,
      role,
      type: "text",
      content,
      channel: session.channel,
      channel_update_id: `task:${taskId}:${Date.now()}`,
      channel_chat_id: chatId,
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
      channel: session.channel,
      channel_chat_id: chatId,
      channel_sent_at: null,
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
    channel: session.channel,
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
    .update({ channel_sent_at: new Date().toISOString() })
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
  // This keeps the /trigger webhook route usable without creating retry noise.
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
