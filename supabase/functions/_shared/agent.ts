import { stepCountIs, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { buildInputMessages } from "./context.ts";
import { createAllTools } from "./tools/index.ts";
import { getConfigNumber, getConfigString } from "./helpers.ts";
import { logger } from "./logger.ts";
import { uploadFile } from "./storage.ts";
import { createServiceClient } from "./supabase.ts";

export type LLMProvider = "openai" | "anthropic" | "google" | "bedrock";

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  openai: "gpt-5.2",
  anthropic: "claude-4-5-opus-latest",
  google: "gemini-3-flash",
  bedrock: "us.anthropic.claude-sonnet-4-20250514-v1:0",
};

function isLLMProvider(value: string): value is LLMProvider {
  return value === "openai" || value === "anthropic" || value === "google" ||
    value === "bedrock";
}

function writeTrace(sessionId: string, trace: Record<string, unknown>) {
  if (Deno.env.get("AGENT_TRACE") === "false") return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = "error" in trace ? "-error" : "";
  uploadFile(
    `.sessions/${sessionId}/${ts}${suffix}.json`,
    JSON.stringify(trace, null, 2),
    { mimeType: "application/json" },
  ).catch((err) => logger.warn("agent.trace.upload_failed", { error: err }));
}

function resolveProviderModel(provider: LLMProvider, model?: string) {
  const resolvedModel = model || DEFAULT_MODELS[provider];
  switch (provider) {
    case "openai": {
      const apiKey = Deno.env.get("OPENAI_API_KEY");
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
      return createOpenAI({ apiKey })(resolvedModel);
    }
    case "anthropic": {
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
      return createAnthropic({ apiKey })(resolvedModel);
    }
    case "google": {
      const apiKey = Deno.env.get("GEMINI_API_KEY");
      if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
      return createGoogleGenerativeAI({ apiKey })(resolvedModel);
    }
    case "bedrock": {
      const region = Deno.env.get("AWS_REGION") ?? "us-east-1";
      const accessKeyId = Deno.env.get("AWS_BEDROCK_ACCESS_KEY");
      const secretAccessKey = Deno.env.get("AWS_BEDROCK_SECRET_ACCESS_KEY");
      if (!accessKeyId || !secretAccessKey) {
        throw new Error(
          "AWS_BEDROCK_ACCESS_KEY and AWS_BEDROCK_SECRET_ACCESS_KEY must be set",
        );
      }
      return createAmazonBedrock({ region, accessKeyId, secretAccessKey })(
        resolvedModel,
      );
    }
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported LLM provider: ${_exhaustive}`);
    }
  }
}

export async function runAgent({
  channel,
  channelChatId,
  userMessage,
  inboundId: existingInboundId,
  provider,
  model,
  maxSteps = getConfigNumber("agent.max_steps") ?? 25,
}: {
  channel: string;
  channelChatId: string;
  userMessage?: {
    content: string;
    role?: "user" | "system";
    channelUpdateId?: string;
    channelMessageId?: string;
    channelFromUserId?: string;
  };
  inboundId?: number;
  provider?: LLMProvider;
  model?: string;
  maxSteps?: number;
}) {
  const supabase = createServiceClient();

  const resolvedProvider = provider ?? getConfigString("llms.agent.provider") ??
    "openai";
  const selectedProvider = isLLMProvider(resolvedProvider)
    ? resolvedProvider
    : "openai";
  const selectedModel = model ?? getConfigString("llms.agent.model");
  const resolvedModel = selectedModel ?? DEFAULT_MODELS[selectedProvider];
  const startedAt = Date.now();
  const providerModel = resolveProviderModel(selectedProvider, selectedModel);

  // 1. Upsert session
  const { data: session, error: sessErr } = await supabase
    .from("sessions")
    .upsert(
      { channel, channel_chat_id: channelChatId, updated_at: new Date().toISOString() },
      { onConflict: "channel,channel_chat_id" },
    )
    .select("id")
    .single();
  if (sessErr || !session) {
    throw new Error(`Session upsert failed: ${sessErr?.message}`);
  }
  const sessionId = session.id as string;

  // 2. Insert user message or use existing
  let inboundId: number;
  if (existingInboundId != null) {
    inboundId = existingInboundId;
  } else if (userMessage) {
    const { data: inbound, error: inErr } = await supabase
      .from("messages")
      .insert({
        session_id: sessionId,
        role: userMessage.role ?? "user",
        type: "text",
        content: userMessage.content,
        channel,
        channel_update_id: userMessage.channelUpdateId,
        channel_message_id: userMessage.channelMessageId,
        channel_chat_id: channelChatId,
        channel_from_user_id: userMessage.channelFromUserId,
      })
      .select("id")
      .single();
    if (inErr) throw new Error(`Failed to insert user message: ${inErr.message}`);
    inboundId = inbound.id as number;
  } else {
    throw new Error("Either userMessage or inboundId must be provided");
  }

  // 3. Insert assistant placeholder
  const { data: assistantRow, error: saveErr } = await supabase
    .from("messages")
    .insert({
      session_id: sessionId,
      reply_to_message_id: inboundId,
      role: "assistant",
      type: "text",
      content: "",
      channel,
      channel_chat_id: channelChatId,
      channel_sent_at: null,
    })
    .select("id")
    .single();
  if (saveErr) {
    throw new Error(`Failed to persist assistant placeholder: ${saveErr.message}`);
  }

  // 4. Build context and stream
  const messages = await buildInputMessages({ sessionId });
  const toolState = new Map<string, { rowId: number; startedAt: number }>();

  const result = streamText({
    model: providerModel,
    messages,
    tools: createAllTools(sessionId),
    stopWhen: stepCountIs(maxSteps),

    async onChunk({ chunk }) {
      if (chunk.type === "tool-call") {
        const args = chunk.input as Record<string, unknown>;
        const { data, error } = await supabase.from("messages").insert({
          session_id: sessionId,
          reply_to_message_id: inboundId,
          role: "system",
          type: "tool-call",
          content: JSON.stringify(args),
          tool_name: chunk.toolName,
          tool_status: "started",
          channel,
          channel_update_id: `tool:${inboundId}:${chunk.toolCallId}`,
          channel_chat_id: channelChatId,
        }).select("id").single();

        if (error) {
          logger.warn("tool-call.insert_failed", { error: error.message });
        } else {
          toolState.set(chunk.toolCallId, { rowId: data.id, startedAt: Date.now() });
        }
      } else if (chunk.type === "tool-result") {
        const state = toolState.get(chunk.toolCallId);
        if (state) {
          await supabase.from("messages").update({
            tool_status: "succeeded",
            tool_result: chunk.output ?? null,
            tool_duration_ms: Date.now() - state.startedAt,
          }).eq("id", state.rowId);
        }
      }
    },

    async onFinish({ text }) {
      await supabase.from("messages").update({
        content: text.trim(),
        channel_sent_at: new Date().toISOString(),
      }).eq("id", assistantRow.id);
    },

    async onError({ error }) {
      const errMsg = error instanceof Error ? error.message : String(error);
      for (const [, s] of toolState) {
        await supabase.from("messages")
          .update({
            tool_status: "failed",
            tool_error: errMsg,
            tool_duration_ms: Date.now() - s.startedAt,
          })
          .eq("id", s.rowId).eq("tool_status", "started");
      }
    },
  });

  // Trace writing (fire-and-forget)
  Promise.resolve(result.text).then(async (text) => {
    const steps = await result.steps;
    const lastStep = steps.at(-1);
    const durationMs = Date.now() - startedAt;
    logger.debug("llm.runAgent", {
      textLength: text.length,
      steps: steps.length,
      finishReason: lastStep?.finishReason,
      durationMs,
    });
    const [usage, request, response] = await Promise.all([
      result.usage,
      result.request,
      result.response,
    ]);
    const toolSummary: Record<string, number> = {};
    for (const s of steps) {
      for (const tc of s.toolCalls) {
        toolSummary[tc.toolName] = (toolSummary[tc.toolName] ?? 0) + 1;
      }
    }
    writeTrace(sessionId, {
      timestamp: new Date().toISOString(),
      sessionId,
      provider: selectedProvider,
      model: resolvedModel,
      durationMs,
      input: { messages, maxSteps },
      request: { body: request.body },
      steps: steps.map((s) => ({
        text: s.text,
        toolCalls: s.toolCalls,
        toolResults: s.toolResults,
        finishReason: s.finishReason,
        usage: s.usage,
        request: { body: s.request.body },
        response: {
          id: s.response.id,
          modelId: s.response.modelId,
          timestamp: s.response.timestamp,
          body: s.response.body,
        },
      })),
      output: { text: text.trim(), finishReason: lastStep?.finishReason },
      toolSummary,
      usage,
      lastCallUsage: lastStep?.usage,
      response: {
        id: response.id,
        modelId: response.modelId,
        timestamp: response.timestamp,
      },
    });
  }).catch((err: unknown) => {
    writeTrace(sessionId, {
      timestamp: new Date().toISOString(),
      sessionId,
      provider: selectedProvider,
      model: resolvedModel,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : { message: String(err) },
    });
  });

  return result;
}
