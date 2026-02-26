import {
  getBearerToken,
  jsonResponse,
  mustGetEnv,
  textResponse,
  timingSafeEqual,
  type VerifiedJwt,
  verifySupabaseJwt,
  formatBytes,
} from "../_shared/helpers.ts";
import { logger } from "../_shared/logger.ts";
import {
  isAllowedTelegramUser,
  runAgentAndStreamToTelegram,
  telegramDownloadFile,
  TELEGRAM_STREAM_PARAMS,
  telegramSendChunkedMessage,
  verifyTelegramSecret,
} from "../_shared/telegram.ts";
import { DuplicateInboundError } from "../_shared/agent.ts";
import { uploadFile } from "../_shared/storage.ts";
import { ChannelUpdate, getChannelAttachment } from "../_shared/channels.ts";
import { createServiceClient } from "../_shared/supabase.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const supabase = createServiceClient();

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

function routeHead(req: Request): "trigger" | "telegram" | null {
  const { pathname } = new URL(req.url);
  const parts = pathname.split("/").filter(Boolean);
  // Edge runtime can forward either "/webhook/<route>" or
  // "/functions/v1/webhook/<route>" depending on invocation path.
  const short = parts.length === 2 && parts[0] === "webhook" ? parts[1] : null;
  const full = parts.length === 4 &&
      parts[0] === "functions" &&
      parts[1] === "v1" &&
      parts[2] === "webhook"
    ? parts[3]
    : null;
  const head = short ?? full;
  if (head !== "trigger" && head !== "telegram") return null;
  return head;
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
    return jsonResponse({ ok: false, error: `unsupported job type: ${type}` }, {
      status: 400,
    });
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

async function handleTelegram(req: Request) {
  if (req.method !== "POST") {
    return textResponse("method not allowed", { status: 405 });
  }
  if (!verifyTelegramSecret(req)) {
    logger.warn("webhook.telegram.secret_mismatch");
    return textResponse("forbidden", { status: 403 });
  }

  let update: ChannelUpdate;
  try {
    update = (await req.json()) as ChannelUpdate;
  } catch {
    logger.warn("webhook.telegram.invalid_json");
    return textResponse("invalid json", { status: 400 });
  }
  const message = update.message ?? update.edited_message;
  if (!message) return textResponse("ok");

  if (!isAllowedTelegramUser(message)) {
    logger.info("webhook.telegram.user_not_allowed");
    return textResponse("ok");
  }

  const chatId = String(message.chat.id);
  const updateId = String(update.update_id);
  const messageId = String(message.message_id);
  const fromUserId = message.from?.id == null ? null : String(message.from.id);

  const attachment = getChannelAttachment(message);
  let content = typeof message.text === "string" && message.text.trim()
    ? message.text
    : undefined;
  let fileId: string | undefined;

  if (attachment) {
    const downloaded = await telegramDownloadFile(attachment.fileId);
    const safeName = attachment.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const objectPath = `uploads/${updateId}_${safeName}`;
    const file = await uploadFile(objectPath, downloaded.data, {
      name: attachment.fileName,
      mimeType: attachment.mimeType,
    });
    fileId = file.id;

    const meta = [attachment.fileName];
    if (attachment.mimeType) meta.push(attachment.mimeType);
    if (downloaded.size) meta.push(formatBytes(downloaded.size));
    const desc = `[File: ${meta.join(", ")}] → ${objectPath}`;
    content = attachment.caption ? `${desc}\n${attachment.caption}` : desc;
  }

  if (!content && !fileId) return textResponse("ok");

  const processing = runAgentAndStreamToTelegram({
    channel: "telegram",
    channelChatId: chatId,
    userMessage: {
      content: content ?? "",
      channelUpdateId: updateId,
      channelMessageId: messageId,
      channelFromUserId: fromUserId ?? undefined,
      fileId,
    },
    telegramChatId: chatId,
    streamMode: TELEGRAM_STREAM_PARAMS.mode,
  }).catch((err) => {
    if (err instanceof DuplicateInboundError) {
      logger.info("webhook.telegram.duplicate_message", { updateId });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("webhook.telegram.process_failed", { error: msg, updateId });
    telegramSendChunkedMessage({
      chatId,
      text: "I hit a temporary issue generating a response. Please try again in a moment.",
    }).catch(() => {});
  });

  EdgeRuntime.waitUntil(processing);
  return textResponse("ok");
}

Deno.serve(async (req) => {
  const head = routeHead(req);
  if (head === "trigger") return await handleTrigger(req);
  if (head === "telegram") return await handleTelegram(req);
  logger.warn("webhook.route_not_found", { path: new URL(req.url).pathname });
  return textResponse("not found", { status: 404 });
});
