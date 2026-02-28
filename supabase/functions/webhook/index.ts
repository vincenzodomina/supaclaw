import { Attachment, Message, Thread } from "chat";
import { createServiceClient } from "../_shared/supabase.ts";
import { DuplicateInboundError, runAgent } from "../_shared/agent.ts";
import { uploadFile } from "../_shared/storage.ts";
import { toolDisplay } from "../_shared/tools/index.ts";
import { createChatBot } from "../_shared/bot.ts";
import {
  formatBytes,
  getBearerToken,
  getConfigBoolean,
  getConfigString,
  jsonResponse,
  mustGetEnv,
  summarize,
  textResponse,
  timingSafeEqual,
  type VerifiedJwt,
  verifySupabaseJwt,
} from "../_shared/helpers.ts";
import { logger } from "../_shared/logger.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const supabase = createServiceClient();

const { bot, adapters } = createChatBot();

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

function createTextStreamWithToolTelemetry(params: {
  thread: Thread<Record<string, unknown>, unknown>;
  fullStream: AsyncIterable<unknown>;
  showToolCalls: boolean;
}) {
  const toolMsgState = new Map<
    string,
    {
      sent: { edit(content: string): Promise<unknown> };
      toolName: string;
      args: Record<string, unknown>;
    }
  >();

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<string> {
      for await (const part of params.fullStream) {
        const evt = (part && typeof part === "object")
          ? part as Record<string, unknown>
          : null;
        const type = typeof evt?.type === "string" ? evt.type : "";

        if (type === "text-delta") {
          const text = typeof evt?.text === "string" ? evt.text : "";
          if (text) yield text;
          continue;
        }

        if (!params.showToolCalls) continue;

        if (type === "tool-call") {
          const toolName = typeof evt?.toolName === "string"
            ? evt.toolName
            : "tool";
          const toolCallId = typeof evt?.toolCallId === "string"
            ? evt.toolCallId
            : crypto.randomUUID();
          const args = (evt?.input && typeof evt.input === "object")
            ? (evt.input as Record<string, unknown>)
            : {};

          const startText = toolDisplay(toolName, args, null) ??
            summarize(args);
          try {
            const sent = await params.thread.post(
              `⚙️ ${toolName} ${startText}`,
            ) as unknown as {
              edit(content: string): Promise<unknown>;
            };
            toolMsgState.set(toolCallId, { sent, toolName, args });
          } catch (error) {
            logger.warn("tool-call.post_failed", { toolName, error });
          }
          continue;
        }

        if (type === "tool-result") {
          const toolCallId = typeof evt?.toolCallId === "string"
            ? evt.toolCallId
            : "";
          const state = toolMsgState.get(toolCallId);
          if (!state) continue;

          const output = evt?.output;
          const doneText = toolDisplay(state.toolName, state.args, output) ??
            summarize(output);
          try {
            await state.sent.edit(`✅ ${state.toolName} ${doneText}`);
          } catch (error) {
            logger.warn("tool-call.edit_failed", {
              toolName: state.toolName,
              error,
            });
          }
          continue;
        }
      }
    },
  };
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
    const attachmentDescriptions: string[] = [];

    for (const [index, attachment] of message.attachments.entries()) {
      const att = attachment as Attachment;
      const raw = await att?.fetchData?.();
      if (!raw) {
        logger.error("webhook.message.attachment_fetch_failed", {
          channel,
          messageId: message.id,
          attachmentIndex: index,
        });
        continue;
      }

      const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const safeName = (att.name ?? "file").replace(/[^a-zA-Z0-9._-]/g, "_");
      const objectPath = `uploads/${message.id}_${index}_${safeName}`;
      const file = await uploadFile(objectPath, data, {
        name: att.name,
        mimeType: att.mimeType,
      });
      if (!fileId) fileId = file.id;

      const meta = [att.name ?? "file"];
      if (att.mimeType) meta.push(att.mimeType);
      if (att.size) meta.push(formatBytes(att.size));
      attachmentDescriptions.push(`[File: ${meta.join(", ")}] → ${objectPath}`);
    }

    if (attachmentDescriptions.length) {
      const attachmentsText = attachmentDescriptions.join("\n");
      content = content ? `${attachmentsText}\n${content}` : attachmentsText;
    }
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

    const showToolCalls = channel === "telegram" &&
      getConfigBoolean("channels.telegram.show_tool_calls") === true;

    if (channel === "telegram") {
      const stream = createTextStreamWithToolTelemetry({
        thread,
        fullStream: result.fullStream,
        showToolCalls,
      });

      // Chat SDK fallback streaming posts an initial "..." placeholder on Telegram.
      // Workaround: delete the streamed message after completion and repost final text
      // so it appears after any tool telemetry messages.
      const sent = await thread.post(stream);
      const finalText = (sent.text ?? "").trim();

      if (showToolCalls && finalText) {
        await sent.delete().catch(() => {});
        await thread.post(finalText);
      }
      return;
    }

    // Other channels: keep native streaming behavior.
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

// ── Router ──────────────────────────────────────────────────────────

type Route = "trigger" | "telegram" | "slack" | "teams" | "discord";
const ROUTES = new Set<Route>([
  "trigger",
  "telegram",
  "slack",
  "teams",
  "discord",
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
  logger.warn("webhook.route_not_found", { path: new URL(req.url).pathname });
  return textResponse("not found", { status: 404 });
});
