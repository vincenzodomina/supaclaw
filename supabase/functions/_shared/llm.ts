import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function generateAgentReply({
  messages,
  provider = "openai",
  model = "gpt-5.2",
}: {
  messages: ChatMessage[];
  provider?: "openai" | "anthropic" | "google";
  model?: string;
}): Promise<string> {
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const useOpenAI = provider === "openai";
  const providerModel = useOpenAI
    ? createOpenAI({ apiKey: openaiKey! })(model || "gpt-5.2")
    : createAnthropic({ apiKey: anthropicKey! })(
      model || "claude-4-5-opus-latest",
    );

  const { text } = await generateText({
    model: providerModel,
    messages,
    ...(useOpenAI ? {} : { maxOutputTokens: 800 }),
  });
  return text?.trim() || "";
}

export function buildSystemPrompt(
  params: { soul?: string; memories?: string[] },
) {
  const parts: string[] = [];
  parts.push("You are SupaClaw, a cloud-native personal agent.");

  if (params.soul?.trim()) {
    parts.push("\n## SOUL\n" + params.soul.trim());
  }

  if (params.memories?.length) {
    parts.push(
      "\n## MEMORY (retrieved)\n" +
        params.memories.map((m) => `- ${m}`).join("\n"),
    );
  }

  parts.push(
    "\n## Rules\n- Be concise.\n- If you are unsure, ask a clarifying question.\n",
  );
  return parts.join("\n");
}
