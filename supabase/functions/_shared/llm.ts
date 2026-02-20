import { stepCountIs, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { tools as defaultTools } from "./tools/index.ts";
import { getConfigNumber } from "./helpers.ts";
import { logger } from "./logger.ts";

export type LLMProvider = "openai" | "anthropic" | "google";

export type ToolSet = Parameters<typeof streamText>[0]["tools"];

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

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
  google: "gemini-2.5-pro",
};

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
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported LLM provider: ${_exhaustive}`);
    }
  }
}

export async function generateLLMResponse({
  messages,
  provider = "openai",
  model,
  maxSteps = getConfigNumber("agent.max_steps") ?? 5,
  tools,
  onToolEvent,
  onTextDelta,
}: {
  messages: ChatMessage[];
  provider?: LLMProvider;
  model?: string;
  maxSteps?: number;
  tools?: ToolSet;
  onToolEvent?: (event: ToolStreamEvent) => void | Promise<void>;
  onTextDelta?: (delta: string, fullText: string) => void | Promise<void>;
}): Promise<string> {
  const providerModel = resolveProviderModel(provider, model);

  const result = streamText({
    model: providerModel,
    messages,
    tools: tools ?? defaultTools,
    ...(provider !== "openai" ? { maxOutputTokens: 800 } : {}),
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

  logger.debug("llm.generateLLMResponse", { textLength: text.length });
  return text.trim();
}
