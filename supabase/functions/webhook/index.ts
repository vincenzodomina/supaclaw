import { Adapter, Attachment, Chat, Message, Thread } from "chat";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createTeamsAdapter } from "@chat-adapter/teams";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createServiceClient } from "../_shared/supabase.ts";
import { DuplicateInboundError, runAgent } from "../_shared/agent.ts";
import { updateTaskAfterRun } from "../_shared/tasks.ts";
import { uploadFile } from "../_shared/storage.ts";
import {
  formatBytes,
  getBearerToken,
  getConfigString,
  jsonResponse,
  mustGetEnv,
  textResponse,
  timingSafeEqual,
  type VerifiedJwt,
  verifySupabaseJwt,
} from "../_shared/helpers.ts";
import { logger } from "../_shared/logger.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const supabase = createServiceClient();

const adapters: Record<string, Adapter> = {};

const slackToken = Deno.env.get("SLACK_BOT_TOKEN");
const slackSecret = Deno.env.get("SLACK_SIGNING_SECRET");
if (slackToken && slackSecret) {
  adapters.slack = createSlackAdapter({
    botToken: slackToken,
    signingSecret: slackSecret,
  });
}

const telegramToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
const telegramSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
if (telegramToken && telegramSecret) {
  adapters.telegram = createTelegramAdapter({
    botToken: telegramToken,
    secretToken: telegramSecret,
  });
}

const teamsAppId = Deno.env.get("TEAMS_APP_ID");
const teamsAppPassword = Deno.env.get("TEAMS_APP_PASSWORD");
if (teamsAppId && teamsAppPassword) {
  const appType = Deno.env.get("TEAMS_APP_TYPE") === "SingleTenant"
    ? "SingleTenant"
    : "MultiTenant";
  const teamsTenantId = Deno.env.get("TEAMS_APP_TENANT_ID");
  adapters.teams = createTeamsAdapter({
    appId: teamsAppId,
    appPassword: teamsAppPassword,
    appType,
    appTenantId: appType === "SingleTenant" ? teamsTenantId : undefined,
  });
}

const discordBotToken = Deno.env.get("DISCORD_BOT_TOKEN");
const discordPublicKey = Deno.env.get("DISCORD_PUBLIC_KEY");
const discordApplicationId = Deno.env.get("DISCORD_APPLICATION_ID");
if (discordBotToken && discordPublicKey && discordApplicationId) {
  adapters.discord = createDiscordAdapter({
    botToken: discordBotToken,
    publicKey: discordPublicKey,
    applicationId: discordApplicationId,
    mentionRoleIds: Deno.env.get("DISCORD_MENTION_ROLE_IDS")
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  });
}

const bot = new Chat({
  userName: getConfigString("agent.name") ?? "supaclaw",
  adapters,
  state: createMemoryState(),
});

// ── Unified message handler for all channels ────────────────────────

function channelOf(threadId: string): string {
  const i = threadId.indexOf(":");
  return i > 0 ? threadId.slice(0, i) : threadId;
}

type ReplyMode = "all" | "mention";

function getReplyMode(scope: "dm" | "group"): ReplyMode {
  const key = scope === "dm"
    ? "channels.dm.reply_mode"
    : "channels.group.reply_mode";
  const value = getConfigString(key);
  return value === "all" ? "all" : "mention";
}

function shouldHandleNewMessage(
  thread: Thread<Record<string, unknown>, unknown>,
  message: Message<unknown>,
): boolean {
  const mode = thread.isDM ? getReplyMode("dm") : getReplyMode("group");
  if (mode === "all") return true;
  return Boolean(message.isMention);
}

async function handleMessage(
  thread: Thread<Record<string, unknown>, unknown>,
  message: Message<unknown>,
) {
  const channel = channelOf(thread.id);

  if (channel === "telegram") {
    const allowedId = Deno.env.get("TELEGRAM_ALLOWED_USER_ID")?.trim();
    if (allowedId && message.author.userId !== allowedId) return;
  }

  let content = (message.text ?? "").trim();
  let fileId: string | undefined;

  if (message.attachments?.length) {
    const att = message.attachments[0] as Attachment;
    const raw = await att?.fetchData?.();
    if (!raw) {
      logger.error("webhook.message.attachment_fetch_failed", {
        channel,
        messageId: message.id,
      });
      return;
    }
    const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const safeName = (att.name ?? "file").replace(/[^a-zA-Z0-9._-]/g, "_");
    const objectPath = `uploads/${message.id}_${safeName}`;
    const file = await uploadFile(objectPath, data, {
      name: att.name,
      mimeType: att.mimeType,
    });
    fileId = file.id;

    const meta = [att.name ?? "file"];
    if (att.mimeType) meta.push(att.mimeType);
    if (att.size) meta.push(formatBytes(att.size));
    const desc = `[File: ${meta.join(", ")}] → ${objectPath}`;
    content = content ? `${desc}\n${content}` : desc;
  }

  if (!content && !fileId) return;

  try {
    const result = await runAgent({
      channel,
      channelChatId: thread.id,
      userMessage: {
        content,
        channelUpdateId: message.id,
        channelMessageId: message.id,
        channelFromUserId: message.author.userId,
        fileId,
      },
    });
    await thread.post(result.textStream);
  } catch (err) {
    if (err instanceof DuplicateInboundError) return;
    logger.error("webhook.agent_error", { channel, error: err });
    await thread.post("I hit an error. Please try again.").catch(() => {});
  }
}

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await handleMessage(thread, message);
});

bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;
  await handleMessage(thread, message);
});

bot.onNewMessage(/[\s\S]*/, async (thread, message) => {
  if (!shouldHandleNewMessage(thread, message)) return;
  if (thread.isDM) {
    await thread.subscribe();
  }
  await handleMessage(thread, message);
});

// ── Trigger (external services / job enqueue) ───────────────────────

const ALLOWED_JOB_TYPES = new Set([
  "trigger",
  "embed_memory",
  "embed_message",
  "embed_file",
  "run_task",
]);

type AuthContext =
  | { authType: "secret" }
  | { authType: "jwt"; claims: VerifiedJwt };

async function authorizeTrigger(req: Request): Promise<AuthContext> {
  const token = getBearerToken(req);
  if (timingSafeEqual(mustGetEnv("TRIGGER_WEBHOOK_SECRET"), token)) {
    return { authType: "secret" };
  }
  const claims = await verifySupabaseJwt(token);
  if (!claims.sub) throw new Error("Invalid JWT: missing subject claim");
  const role = typeof claims.role === "string" ? claims.role : null;
  if (!role || (role !== "authenticated" && role !== "service_role")) {
    throw new Error("Invalid JWT role for this endpoint");
  }
  return { authType: "jwt", claims };
}

async function handleTrigger(req: Request) {
  if (req.method !== "POST") {
    return textResponse("method not allowed", { status: 405 });
  }

  let auth: AuthContext;
  try {
    auth = await authorizeTrigger(req);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Invalid authorization";
    logger.warn("webhook.trigger.auth_failed", { message });
    return jsonResponse({ ok: false, error: message }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const type = typeof body?.type === "string" ? body.type : "trigger";
  if (!ALLOWED_JOB_TYPES.has(type)) {
    logger.warn("webhook.trigger.unsupported_type", { type });
    return jsonResponse(
      { ok: false, error: `unsupported job type: ${type}` },
      { status: 400 },
    );
  }

  const dedupeKey =
    typeof body?.dedupe_key === "string" && body.dedupe_key.trim()
      ? body.dedupe_key
      : `trigger:${crypto.randomUUID()}`;
  const payload = typeof body?.payload === "object" && body.payload
    ? body.payload
    : body;
  const enrichedPayload = auth.authType === "jwt"
    ? {
      ...payload,
      auth_user_id: auth.claims.sub,
      auth_user_role: auth.claims.role ?? null,
      auth_user_email: auth.claims.email ?? null,
    }
    : payload;

  const { data, error } = await supabase.rpc("enqueue_job", {
    p_dedupe_key: dedupeKey,
    p_type: type,
    p_payload: enrichedPayload,
    p_run_at: new Date().toISOString(),
    p_max_attempts: 5,
  });

  if (error) {
    logger.error("webhook.trigger.enqueue_failed", {
      type,
      error: error.message,
    });
    return jsonResponse({ ok: false, error: error.message }, { status: 500 });
  }
  logger.info("webhook.trigger.enqueued", { type, jobId: data });
  return jsonResponse({ ok: true, job_id: data });
}

// ── Cron: process due tasks (Slack sessions) ────────────────────────

async function handleCron(req: Request) {
  if (req.method !== "POST") {
    return textResponse("method not allowed", { status: 405 });
  }
  const secret = mustGetEnv("WORKER_SECRET");
  if (!timingSafeEqual(secret, req.headers.get("x-worker-secret") ?? "")) {
    return textResponse("forbidden", { status: 403 });
  }

  const { data: tasks, error } = await supabase
    .from("tasks")
    .select(
      "id, prompt, task_type, session_id, sessions!inner(channel_chat_id)",
    )
    .not("enabled_at", "is", null)
    .not("next_run_at", "is", null)
    .lte("next_run_at", new Date().toISOString())
    .eq("sessions.channel", "slack");
  if (error) {
    logger.error("webhook.cron.query_failed", { error });
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
      await supabase.from("tasks").update({ next_run_at: null }).eq(
        "id",
        task.id,
      );

      const role = taskType === "agent_turn"
        ? "user" as const
        : "system" as const;
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
      logger.info("webhook.cron.task_done", { taskId: task.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("webhook.cron.task_failed", { taskId: task.id, error: msg });
      await updateTaskAfterRun(task.id);
      results.push({ taskId: task.id, ok: false, error: msg });
    }
  }

  return jsonResponse({ ok: true, processed: results.length, results });
}

// ── Router ──────────────────────────────────────────────────────────

type Route = "trigger" | "telegram" | "slack" | "teams" | "discord" | "cron";
const ROUTES = new Set<Route>([
  "trigger",
  "telegram",
  "slack",
  "teams",
  "discord",
  "cron",
]);

function routeHead(req: Request): Route | null {
  const { pathname } = new URL(req.url);
  const parts = pathname.split("/").filter(Boolean);
  const head =
    (parts.length === 2 && parts[0] === "webhook" ? parts[1] : null) ??
      (parts.length === 4 &&
          parts[0] === "functions" &&
          parts[1] === "v1" &&
          parts[2] === "webhook"
        ? parts[3]
        : null);
  return head && ROUTES.has(head as Route) ? (head as Route) : null;
}

Deno.serve(async (req) => {
  const head = routeHead(req);
  if (head === "trigger") return await handleTrigger(req);
  if (head === "slack" && adapters.slack) {
    return await bot.webhooks.slack(req, { waitUntil: EdgeRuntime.waitUntil });
  }
  if (head === "telegram" && adapters.telegram) {
    return await bot.webhooks.telegram(req, {
      waitUntil: EdgeRuntime.waitUntil,
    });
  }
  if (head === "teams" && adapters.teams) {
    return await bot.webhooks.teams(req, { waitUntil: EdgeRuntime.waitUntil });
  }
  if (head === "discord" && adapters.discord) {
    return await bot.webhooks.discord(req, {
      waitUntil: EdgeRuntime.waitUntil,
    });
  }
  if (head === "cron") return await handleCron(req);
  logger.warn("webhook.route_not_found", { path: new URL(req.url).pathname });
  return textResponse("not found", { status: 404 });
});
