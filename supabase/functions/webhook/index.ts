import { createServiceClient } from "../_shared/supabase.ts";
import {
  getBearerToken,
  jsonResponse,
  mustGetEnv,
  textResponse,
  timingSafeEqual,
  type VerifiedJwt,
  verifySupabaseJwt,
} from "../_shared/helpers.ts";
import { logger } from "../_shared/logger.ts";
import { telegramDownloadFile } from "../_shared/telegram.ts";
import { uploadInboundFile } from "../_shared/storage.ts";

const supabase = createServiceClient();

const ALLOWED_JOB_TYPES = new Set([
  "trigger",
  "process_message",
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

function verifyTelegramSecret(req: Request) {
  const expected = mustGetEnv("TELEGRAM_WEBHOOK_SECRET");
  const actual = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  return timingSafeEqual(expected, actual);
}

type TelegramUpdate = {
  update_id: number | string;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

type TelegramDocument = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramPhotoSize = {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
};

type TelegramMessage = {
  message_id: number | string;
  from?: { id: number | string };
  chat: { id: number | string; type: string };
  text?: string;
  caption?: string;
  document?: TelegramDocument;
  photo?: TelegramPhotoSize[];
};

type InboundAttachment = {
  fileId: string;
  fileName: string;
  mimeType?: string;
  size?: number;
  caption?: string;
};

function isAllowedTelegramUser(message: TelegramMessage): boolean {
  const allowedId = mustGetEnv("TELEGRAM_ALLOWED_USER_ID").trim();
  if (!allowedId) {
    throw new Error(
      "TELEGRAM_ALLOWED_USER_ID must be a non-empty Telegram user id",
    );
  }
  return String(message.from?.id ?? "") === allowedId;
}

function getTelegramTextContent(message: TelegramMessage): string | undefined {
  if (typeof message.text === "string" && message.text.trim()) {
    return message.text;
  }
  return undefined;
}

function getTelegramAttachment(
  message: TelegramMessage,
): InboundAttachment | undefined {
  if (message.document) {
    return {
      fileId: message.document.file_id,
      fileName: message.document.file_name ?? "document",
      mimeType: message.document.mime_type,
      size: message.document.file_size,
      caption: message.caption,
    };
  }
  if (message.photo?.length) {
    const largest = message.photo[message.photo.length - 1];
    return {
      fileId: largest.file_id,
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      size: largest.file_size,
      caption: message.caption,
    };
  }
  return undefined;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.ceil(bytes / 1024)}KB`;
}

async function kickAgentWorkerNow() {
  const workerSecret = Deno.env.get("WORKER_SECRET")?.trim();
  if (!workerSecret) return;
  const baseUrl = (Deno.env.get("SUPABASE_URL") ?? "").trim().replace(
    /\/+$/,
    "",
  );
  if (!baseUrl) return;
  const url = `${baseUrl}/functions/v1/agent-worker`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-secret": workerSecret,
      },
      body: "{}",
      signal: ctrl.signal,
    });
  } catch {
    // Best effort: cron remains the durable backstop.
  } finally {
    clearTimeout(timer);
  }
}

function routeHead(req: Request): "trigger" | "telegram" | null {
  const { pathname } = new URL(req.url);
  const parts = pathname.split("/").filter(Boolean);
  // Edge runtime can forward either "/webhook/<route>" or
  // "/functions/v1/webhook/<route>" depending on invocation path.
  const short =
    parts.length === 2 && parts[0] === "webhook" ? parts[1] : null;
  const full =
    parts.length === 4 &&
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
    logger.error("webhook.trigger.enqueue_failed", { type, error: error.message });
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

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
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

  const attachment = getTelegramAttachment(message);
  let content = getTelegramTextContent(message);
  let fileId: string | null = null;

  if (attachment) {
    const downloaded = await telegramDownloadFile(attachment.fileId);
    const safeName = attachment.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const objectPath = `uploads/${updateId}_${safeName}`;
    const file = await uploadInboundFile({
      objectPath,
      data: downloaded.data,
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

  const { error: ingestErr } = await supabase.rpc("ingest_inbound", {
    p_channel: "telegram",
    p_channel_chat_id: chatId,
    p_channel_update_id: updateId,
    p_content: content ?? "",
    p_channel_message_id: messageId,
    p_channel_from_user_id: fromUserId,
    p_job_max_attempts: 10,
    p_file_id: fileId,
  });
  if (ingestErr) {
    logger.error("webhook.telegram.ingest_failed", {
      error: ingestErr.message,
      updateId,
    });
    return jsonResponse({ error: ingestErr.message }, { status: 500 });
  }

  await kickAgentWorkerNow();
  return textResponse("ok");
}

Deno.serve(async (req) => {
  const head = routeHead(req);
  if (head === "trigger") return await handleTrigger(req);
  if (head === "telegram") return await handleTelegram(req);
  logger.warn("webhook.route_not_found", { path: new URL(req.url).pathname });
  return textResponse("not found", { status: 404 });
});

