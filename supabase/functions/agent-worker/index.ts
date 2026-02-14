import { createServiceClient } from "../_shared/supabase.ts";
import { mustGetEnv } from "../_shared/env.ts";
import { jsonResponse, textResponse } from "../_shared/http.ts";
import { telegramSendMessage } from "../_shared/telegram.ts";
import { logger } from "../_shared/logger.ts";
import {
  buildSystemPrompt,
  type ChatMessage,
  generateAgentReply,
} from "../_shared/llm.ts";
import { downloadTextFromWorkspace } from "../_shared/storage.ts";
import { embedText } from "../_shared/embeddings.ts";

type JobRow = {
  id: number;
  type: string;
  payload: Record<string, unknown>;
};

type MemoryCandidate = {
  type: "pinned_fact" | "summary";
  content: string;
  session_id: string | null;
};

type RecentMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const supabase = createServiceClient();
const FALLBACK_REPLY =
  "I hit a temporary issue generating a response. Please try again in a moment.";

function isAuthorized(req: Request) {
  const expected = mustGetEnv("WORKER_SECRET");
  const actual = req.headers.get("x-worker-secret");
  return actual === expected;
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
  const { data: existingReply, error: rErr } = await supabase
    .from("messages")
    .select("id, content, telegram_chat_id, telegram_sent_at")
    .eq("reply_to_message_id", inbound.id)
    .eq("role", "assistant")
    .maybeSingle();
  if (rErr) {
    throw new Error(`Failed to check existing replies: ${rErr.message}`);
  }
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
      textToDeliver = await buildAssistantReply({
        jobId: job.id,
        sessionId,
        inboundId: inbound.id,
        inboundContent: inbound.content,
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

    await telegramSendMessage({
      chatId: existingChatId,
      text: textToDeliver,
    });

    const { error: deliveredErr } = await supabase
      .from("messages")
      .update({ telegram_sent_at: new Date().toISOString() })
      .eq("id", existingReply.id);
    if (deliveredErr) {
      throw new Error(
        `Failed to mark assistant message as delivered: ${deliveredErr.message}`,
      );
    }
    logger.info("job.process_message.redelivered", {
      jobId: job.id,
      replyId: existingReply.id,
    });
    return;
  }

  const reply = await buildAssistantReply({
    jobId: job.id,
    sessionId,
    inboundId: inbound.id,
    inboundContent: inbound.content,
  });

  // Persist assistant message before delivery; retries will deliver pending messages.
  const { data: savedReply, error: saveErr } = await supabase
    .from("messages")
    .insert({
      session_id: sessionId,
      reply_to_message_id: inbound.id,
      role: "assistant",
      content: reply,
      provider: "telegram",
      telegram_chat_id: telegramChatId,
      telegram_sent_at: null,
      raw: {},
    })
    .select("id")
    .single();
  if (saveErr) {
    throw new Error(`Failed to persist assistant message: ${saveErr.message}`);
  }

  await telegramSendMessage({ chatId: telegramChatId, text: reply });

  const { error: deliveredErr } = await supabase
    .from("messages")
    .update({ telegram_sent_at: new Date().toISOString() })
    .eq("id", savedReply.id);
  if (deliveredErr) {
    throw new Error(
      `Failed to mark assistant message as delivered: ${deliveredErr.message}`,
    );
  }
  logger.info("job.process_message.done", {
    jobId: job.id,
    replyMessageId: savedReply.id,
  });
}

async function buildAssistantReply(params: {
  jobId: number;
  sessionId: string;
  inboundId: number;
  inboundContent: string;
}) {
  const [agents, soul, identity, user, bootstrap, heartbeat, tools, memory] =
    await Promise.all([
      downloadTextFromWorkspace(".agents/AGENTS.md"),
      downloadTextFromWorkspace(".agents/SOUL.md"),
      downloadTextFromWorkspace(".agents/IDENTITY.md"),
      downloadTextFromWorkspace(".agents/USER.md"),
      downloadTextFromWorkspace(".agents/BOOTSTRAP.md"),
      downloadTextFromWorkspace(".agents/HEARTBEAT.md"),
      downloadTextFromWorkspace(".agents/TOOLS.md"),
      downloadTextFromWorkspace(".agents/MEMORY.md"),
    ]);

  // Memory retrieval in one query (pinned facts + summaries), then split by type.
  // We fetch a slightly larger candidate pool to preserve quality after filtering.
  const queryEmbedding = await embedText(params.inboundContent);
  logger.debug("job.process_message.embedding_ready", {
    jobId: params.jobId,
    inboundId: params.inboundId,
  });
  const { data: hybrid, error: memErr } = await supabase.rpc("hybrid_search", {
    query_text: params.inboundContent,
    query_embedding: queryEmbedding,
    match_count: 30,
    search_tables: ["memories"],
    filter_type: ["pinned_fact", "summary"],
    filter_session_id: null,
  });
  if (memErr) {
    throw new Error(`hybrid_search failed: ${memErr.message}`);
  }

  const memoryCandidates = (hybrid?.memories ?? []) as MemoryCandidate[];
  const pinnedFacts: MemoryCandidate[] = [];
  const summaries: MemoryCandidate[] = [];
  for (const memory of memoryCandidates) {
    if (memory.type === "pinned_fact" && pinnedFacts.length < 5) {
      pinnedFacts.push(memory);
      continue;
    }
    if (
      memory.type === "summary" && memory.session_id === params.sessionId &&
      summaries.length < 5
    ) {
      summaries.push(memory);
    }
    if (pinnedFacts.length >= 5 && summaries.length >= 5) break;
  }

  const memoryStrings = [...pinnedFacts, ...summaries].map((m) =>
    `[${m.type}] ${m.content}`
  );

  const system = await buildSystemPrompt({
    agents: agents ?? undefined,
    soul: soul ?? undefined,
    identity: identity ?? undefined,
    user: user ?? undefined,
    bootstrap: bootstrap ?? undefined,
    heartbeat: heartbeat ?? undefined,
    tools: tools ?? undefined,
    memory: memory ?? undefined,
    memories: memoryStrings,
  });

  // Build short chat context (last N messages).
  // Query newest first for index efficiency, then reverse for chronological model input.
  const { data: recent, error: recentErr } = await supabase
    .from("messages")
    .select("role, content")
    .eq("session_id", params.sessionId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (recentErr) {
    throw new Error(`Failed to load recent messages: ${recentErr.message}`);
  }

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...(recent ?? []).reverse().map((m: RecentMessage) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  const rawReply = await generateAgentReply({ messages });
  const reply = rawReply.trim();
  if (!reply) {
    logger.warn("job.process_message.reply_empty", {
      jobId: params.jobId,
      inboundId: params.inboundId,
      recentCount: recent?.length ?? 0,
    });
    return FALLBACK_REPLY;
  }
  logger.debug("job.process_message.reply_generated", {
    jobId: params.jobId,
    replyLength: reply.length,
  });
  return reply;
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
