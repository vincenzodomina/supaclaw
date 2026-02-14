import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { workspaceTools } from "./workspace_tools.ts";
import { skillsTools, buildSkillsInstructionsBlock } from "./skills.ts";

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
  maxSteps?: number;
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
    tools: { ...workspaceTools, ...skillsTools },
    ...(useOpenAI ? {} : { maxOutputTokens: 800 }),
  });
  return text?.trim() || "";
}

export async function buildSystemPrompt(params: {
  agents?: string;
  soul?: string;
  identity?: string;
  user?: string;
  bootstrap?: string;
  heartbeat?: string;
  tools?: string;
  memory?: string;
  memories?: string[];
}) {
  const parts: string[] = [];
  parts.push("You are SupaClaw, a cloud-native personal agent.");

  if (params.agents?.trim()) {
    parts.push("\n## AGENTS\n" + params.agents.trim());
  }

  if (params.soul?.trim()) {
    parts.push("\n## SOUL\n" + params.soul.trim());
  }

  if (params.identity?.trim()) {
    parts.push("\n## IDENTITY\n" + params.identity.trim());
  }

  if (params.user?.trim()) {
    parts.push("\n## USER\n" + params.user.trim());
  }

  if (params.bootstrap?.trim()) {
    parts.push("\n## BOOTSTRAP\n" + params.bootstrap.trim());
  }

  if (params.heartbeat?.trim()) {
    parts.push("\n## HEARTBEAT\n" + params.heartbeat.trim());
  }

  if (params.memories?.length) {
    parts.push(
      "\n## MEMORY (retrieved from memory tool)\n" +
        params.memories.map((m) => `- ${m}`).join("\n"),
    );
  }

  if (params.memory?.trim()) {
    parts.push("\n## MEMORY (long term from MEMORY.md)\n" + params.memory.trim());
  }

  if (params.tools?.trim()) {
    parts.push("\n## TOOLS\n" + params.tools.trim());
  }

  const skillsBlock = await buildSkillsInstructionsBlock().catch(() => "");
  if (skillsBlock.trim()) {
    parts.push(skillsBlock);
  }

  return parts.join("\n");
}
