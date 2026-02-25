import { stepCountIs, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
//import { createServiceClient } from "./supabase.ts";
import { buildInputMessages } from "./context.ts";
import { createAllTools } from "./tools/index.ts";
import { getConfigNumber, getConfigString } from "./helpers.ts";
import { logger } from "./logger.ts";
import { uploadFile } from "./storage.ts";

export type LLMProvider = "openai" | "anthropic" | "google" | "bedrock";

export type ToolStreamEvent =
  | {
    type: "tool-call-start";
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }
  | {
    type: "tool-call-done";
    toolCallId: string;
    toolName: string;
    result: unknown;
  };

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
  sessionId,
  provider,
  model,
  maxSteps = getConfigNumber("agent.max_steps") ?? 25,
  onToolEvent,
  onTextDelta,
}: {
  sessionId: string;
  provider?: LLMProvider;
  model?: string;
  maxSteps?: number;
  onToolEvent?: (event: ToolStreamEvent) => void | Promise<void>;
  onTextDelta?: (delta: string, fullText: string) => void | Promise<void>;
}): Promise<string> {
  const startedAt = Date.now();
  const resolvedProvider = provider ?? getConfigString("llms.agent.provider") ??
    "openai";
  const selectedProvider = isLLMProvider(resolvedProvider)
    ? resolvedProvider
    : "openai";
  const selectedModel = model ?? getConfigString("llms.agent.model");
  const resolvedModel = selectedModel ?? DEFAULT_MODELS[selectedProvider];

  try {
    const providerModel = resolveProviderModel(selectedProvider, selectedModel);
    const messages = await buildInputMessages({ sessionId });

    const result = streamText({
      model: providerModel,
      messages,
      tools: createAllTools(sessionId),
      stopWhen: stepCountIs(maxSteps),
    });

    let text = "";
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          text += part.text;
          await onTextDelta?.(part.text, text);
          break;
        case "tool-call":
          await onToolEvent?.({
            type: "tool-call-start",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.input as Record<string, unknown>,
          });
          break;
        case "tool-result":
          await onToolEvent?.({
            type: "tool-call-done",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: part.output,
          });
          break;
      }
    }

    const steps = await result.steps;
    const lastStep = steps.at(-1);
    const finishReason = lastStep?.finishReason;
    const durationMs = Date.now() - startedAt;

    logger.debug("llm.runAgent", {
      textLength: text.length,
      steps: steps.length,
      finishReason,
      durationMs,
    });

    try {
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
        output: { text: text.trim(), finishReason },
        toolSummary,
        usage,
        lastCallUsage: lastStep?.usage,
        response: {
          id: response.id,
          modelId: response.modelId,
          timestamp: response.timestamp,
        },
      });
    } catch (traceErr) {
      logger.warn("agent.trace.build_failed", { error: traceErr });
    }

    return text.trim();
  } catch (err) {
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
    throw err;
  }
}
