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

type JobRow = {
  id: number;
  type: string;
  payload: Record<string, unknown>;
};

const supabase = createServiceClient();
const { bot, adapters } = createChatBot();

const FALLBACK_REPLY =
  "I hit a temporary issue generating a response. Please try again in a moment.";

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

  const channel = String(session.channel ?? "").trim();
  const threadId = normalizeThreadId(channel, session.channel_chat_id);
  if (!channel || !threadId) {
    throw new Error("Session is missing channel or channel_chat_id");
  }

  if (!adapters[channel]) {
    logger.info("job.run_task.skip_missing_adapter", {
      jobId: job.id,
      taskId,
      channel,
    });
    return;
  }

  const role = taskType === "agent_turn" ? "user" as const : "system" as const;
  const content = taskType === "reminder" ? `Reminder: ${prompt}` : prompt;

  const result = await runAgent({
    channel,
    channelChatId: threadId,
    userMessage: {
      content,
      role,
      channelUpdateId: `task:${taskId}:${Date.now()}`,
    },
  });

  const reply = ((await result.text) ?? "").trim() || FALLBACK_REPLY;
  const adapter = bot.getAdapter(channel as never);
  await adapter.postMessage(threadId, reply);

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
