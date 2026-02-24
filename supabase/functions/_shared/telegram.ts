import { ChannelMessage } from "./channels.ts";
import { mustGetEnv, timingSafeEqual, sleep, parseRetryAfterMs, getBackoffMs } from "./helpers.ts";

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;

type ApiResult = Record<string, unknown> | null;

export type TelegramStreamMode = "off" | "partial" | "block";

export const TELEGRAM_STREAM_PARAMS = {
  mode: "partial" as TelegramStreamMode,
  throttleMs: 900,
  minInitialChars: 24,
  textLimit: 4096,
  chunkSoftLimit: 3900,
  blockMinChars: 160,
};

export function verifyTelegramSecret(req: Request) {
  const expected = mustGetEnv("TELEGRAM_WEBHOOK_SECRET");
  const actual = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  return timingSafeEqual(expected, actual);
}

export function isAllowedTelegramUser(message: ChannelMessage): boolean {
  const allowedId = mustGetEnv("TELEGRAM_ALLOWED_USER_ID").trim();
  if (!allowedId) {
    throw new Error(
      "TELEGRAM_ALLOWED_USER_ID must be a non-empty Telegram user id",
    );
  }
  return String(message.from?.id ?? "") === allowedId;
}

async function telegramApi(
  method: string,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  const token = mustGetEnv("TELEGRAM_BOT_TOKEN");
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const payload = JSON.stringify(body);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
    } catch (error) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(
          `Telegram ${method} network failure after ${MAX_RETRIES} attempts: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      await sleep(getBackoffMs(attempt, MAX_BACKOFF_MS, BASE_BACKOFF_MS));
      continue;
    }

    if (res.ok) return await res.json().catch(() => null) as ApiResult;

    const respBody = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(
        `Telegram ${method} failed (${res.status}) after ${attempt} attempts: ${respBody}`,
      );
    }

    let retryAfterMs: number | null = parseRetryAfterMs(
      res.headers.get("retry-after"),
    );
    if (res.status === 429 && respBody) {
      try {
        const parsed = JSON.parse(respBody) as {
          parameters?: { retry_after?: unknown };
        };
        const retryAfter = parsed?.parameters?.retry_after;
        retryAfterMs = parseRetryAfterMs(
          retryAfter == null ? null : String(retryAfter),
        ) ?? retryAfterMs;
      } catch {
        // Ignore malformed provider body and fall back to header/backoff.
      }
    }
    await sleep(retryAfterMs ?? getBackoffMs(attempt, MAX_BACKOFF_MS, BASE_BACKOFF_MS));
  }
  throw new Error(`Telegram ${method}: exhausted ${MAX_RETRIES} retries`);
}

function normalizeTelegramText(text: string): string {
  const normalized = text.trim();
  return normalized || "...";
}

function findBreakIndex(text: string, maxChars: number, minChars = 1): number {
  if (text.length <= maxChars) return text.length;
  const cap = Math.max(1, Math.min(maxChars, text.length));
  const floor = Math.max(1, Math.min(minChars, cap));
  const probes = ["\n\n", "\n", ". ", "! ", "? ", " "];
  for (const probe of probes) {
    const idx = text.lastIndexOf(probe, cap);
    if (idx >= floor) return idx + (probe === " " ? 0 : probe.length);
  }
  return cap;
}

export function chunkTelegramText(
  text: string,
  chunkSoftLimit = TELEGRAM_STREAM_PARAMS.chunkSoftLimit,
): string[] {
  const normalized = text;
  if (!normalized) return [];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const remaining = normalized.slice(cursor);
    if (remaining.length <= chunkSoftLimit) {
      chunks.push(remaining);
      break;
    }
    const cut = findBreakIndex(
      remaining,
      chunkSoftLimit,
      Math.floor(chunkSoftLimit * 0.5),
    );
    const chunk = remaining.slice(0, cut);
    if (chunk.trim()) chunks.push(chunk);
    cursor += Math.max(cut, 1);
  }
  return chunks;
}

/** Send a message and return the Telegram message_id (for later edits). */
export async function telegramSendMessage(
  params: { chatId: string; text: string },
): Promise<string | undefined> {
  const chatId = params.chatId?.toString().trim();
  const text = params.text?.toString().trim();
  if (!chatId) throw new Error("telegramSendMessage requires non-empty chatId");
  if (!text) throw new Error("telegramSendMessage requires non-empty text");

  const data = await telegramApi("sendMessage", { chat_id: chatId, text });
  const result = data?.result as { message_id?: number | string } | undefined;
  return result?.message_id?.toString();
}

/** Edit an existing message in-place (used for tool-call status updates). */
export async function telegramEditMessageText(
  params: { chatId: string; messageId: string; text: string },
): Promise<void> {
  const chatId = params.chatId?.toString().trim();
  const messageId = params.messageId?.toString().trim();
  const text = params.text?.toString().trim();
  if (!chatId || !messageId || !text) {
    throw new Error(
      "telegramEditMessageText requires non-empty chatId, messageId, and text",
    );
  }

  try {
    await telegramApi("editMessageText", {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("message is not modified")) return;
    throw error;
  }
}

export async function telegramDeleteMessage(
  params: { chatId: string; messageId: string },
): Promise<void> {
  const chatId = params.chatId?.toString().trim();
  const messageId = params.messageId?.toString().trim();
  if (!chatId || !messageId) {
    throw new Error(
      "telegramDeleteMessage requires non-empty chatId and messageId",
    );
  }
  await telegramApi("deleteMessage", {
    chat_id: chatId,
    message_id: Number(messageId),
  });
}

export async function telegramSendChatAction(
  params: { chatId: string; action?: "typing" },
): Promise<void> {
  const chatId = params.chatId?.toString().trim();
  if (!chatId) {
    throw new Error("telegramSendChatAction requires non-empty chatId");
  }
  await telegramApi("sendChatAction", {
    chat_id: chatId,
    action: params.action ?? "typing",
  });
}

export async function telegramSendChunkedMessage(params: {
  chatId: string;
  text: string;
  chunkSoftLimit?: number;
}): Promise<string[]> {
  const chatId = params.chatId?.toString().trim();
  if (!chatId) {
    throw new Error("telegramSendChunkedMessage requires non-empty chatId");
  }
  const chunks = chunkTelegramText(params.text, params.chunkSoftLimit);
  const messageIds: string[] = [];
  for (const chunk of chunks) {
    const id = await telegramSendMessage({ chatId, text: chunk });
    if (id) messageIds.push(id);
  }
  return messageIds;
}

type DraftStreamParams = {
  chatId: string;
  mode?: TelegramStreamMode;
  throttleMs?: number;
  minInitialChars?: number;
  textLimit?: number;
  chunkSoftLimit?: number;
  blockMinChars?: number;
};

/** Download a file from Telegram servers by its file_id. Channel-specific; callers handle storage. */
export async function telegramDownloadFile(fileId: string): Promise<{
  data: Uint8Array;
  path: string;
  size: number;
}> {
  const result = await telegramApi("getFile", { file_id: fileId });
  const file = result?.result as Record<string, unknown> | undefined;
  const filePath = typeof file?.file_path === "string" ? file.file_path : "";
  if (!filePath) throw new Error("Telegram getFile returned no file_path");

  const token = mustGetEnv("TELEGRAM_BOT_TOKEN");
  const res = await fetch(
    `https://api.telegram.org/file/bot${token}/${filePath}`,
  );
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
  const data = new Uint8Array(await res.arrayBuffer());
  return { data, path: filePath, size: data.byteLength };
}

export function createTelegramDraftStream(params: DraftStreamParams) {
  const chatId = params.chatId;
  const mode = params.mode ?? TELEGRAM_STREAM_PARAMS.mode;
  const throttleMs = params.throttleMs ?? TELEGRAM_STREAM_PARAMS.throttleMs;
  const minInitialChars = params.minInitialChars ??
    TELEGRAM_STREAM_PARAMS.minInitialChars;
  const textLimit = params.textLimit ?? TELEGRAM_STREAM_PARAMS.textLimit;
  const chunkSoftLimit = params.chunkSoftLimit ??
    TELEGRAM_STREAM_PARAMS.chunkSoftLimit;
  const blockMinChars = params.blockMinChars ??
    TELEGRAM_STREAM_PARAMS.blockMinChars;

  let draftMessageId: string | undefined;
  let pendingText = "";
  let lastSentText = "";
  let lastFlushAt = 0;
  let overflowed = false;
  let blockSentChars = 0;

  async function flushPartial(force = false) {
    if (overflowed) return;
    const now = Date.now();
    if (!force && now - lastFlushAt < throttleMs) return;
    const candidate = normalizeTelegramText(pendingText);
    if (candidate.length > textLimit) {
      overflowed = true;
      return;
    }
    if (!draftMessageId && candidate.length < minInitialChars) return;
    if (candidate === lastSentText) return;
    if (!draftMessageId) {
      draftMessageId = await telegramSendMessage({ chatId, text: candidate });
    } else {
      await telegramEditMessageText({
        chatId,
        messageId: draftMessageId,
        text: candidate,
      });
    }
    lastSentText = candidate;
    lastFlushAt = now;
  }

  async function flushBlock(force = false) {
    const now = Date.now();
    if (!force && now - lastFlushAt < throttleMs) return;
    const full = pendingText;
    if (full.length <= blockSentChars) return;
    const remaining = full.slice(blockSentChars);
    let consumed = 0;
    const chunks: string[] = [];

    if (force) {
      chunks.push(...chunkTelegramText(remaining, chunkSoftLimit));
      consumed = remaining.length;
    } else {
      if (remaining.length < blockMinChars) return;
      const cap = Math.min(chunkSoftLimit, remaining.length);
      const cut = findBreakIndex(remaining, cap, Math.min(blockMinChars, cap));
      const piece = remaining.slice(0, cut);
      if (piece.trim()) {
        chunks.push(piece);
        consumed = Math.max(cut, 1);
      }
    }

    for (const chunk of chunks) {
      await telegramSendMessage({ chatId, text: chunk });
    }
    blockSentChars += consumed;
    if (chunks.length > 0) lastFlushAt = now;
  }

  async function update(fullText: string) {
    if (mode === "off") return;
    pendingText = fullText;
    if (mode === "partial") {
      await flushPartial(false);
      return;
    }
    await flushBlock(false);
  }

  async function finalize(finalText: string) {
    const finalClean = normalizeTelegramText(finalText);
    pendingText = finalClean;
    if (mode === "off") {
      await telegramSendChunkedMessage({
        chatId,
        text: finalClean,
        chunkSoftLimit,
      });
      return;
    }
    if (mode === "block") {
      await flushBlock(true);
      return;
    }

    await flushPartial(true);
    if (overflowed || finalClean.length > textLimit) {
      if (draftMessageId) {
        await telegramDeleteMessage({ chatId, messageId: draftMessageId })
          .catch(() => {});
        draftMessageId = undefined;
      }
      await telegramSendChunkedMessage({
        chatId,
        text: finalClean,
        chunkSoftLimit,
      });
      return;
    }
    if (!draftMessageId) {
      draftMessageId = await telegramSendMessage({ chatId, text: finalClean });
      return;
    }
    if (lastSentText !== finalClean) {
      await telegramEditMessageText({
        chatId,
        messageId: draftMessageId,
        text: finalClean,
      });
      lastSentText = finalClean;
    }
  }

  async function clearDraft() {
    if (!draftMessageId) return;
    await telegramDeleteMessage({ chatId, messageId: draftMessageId }).catch(
      () => {},
    );
    draftMessageId = undefined;
  }

  return {
    update,
    finalize,
    clearDraft,
  };
}
