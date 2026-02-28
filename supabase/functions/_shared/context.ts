import { createServiceClient } from "../_shared/supabase.ts";
import { buildSkillsInstructionsBlock } from "./skills.ts";
import { downloadTextFromWorkspace } from "./storage.ts";
import { getConfigNumber } from "./helpers.ts";
import type { Tables } from "./database.types.ts";

type MessageRow =
  | Pick<
    Tables<"messages">,
    | "role"
    | "content"
    | "file_id"
    | "tool_name"
    | "tool_result"
    | "tool_status"
    | "tool_error"
  >
  | { role: "system"; content: string };

async function buildSystemPrompt(): Promise<string> {
  const [agents, soul, identity, user, bootstrap, heartbeat, tools, memory] =
    await Promise.all([
      downloadTextFromWorkspace(".agents/AGENTS.md", { optional: true }),
      downloadTextFromWorkspace(".agents/SOUL.md", { optional: true }),
      downloadTextFromWorkspace(".agents/IDENTITY.md", { optional: true }),
      downloadTextFromWorkspace(".agents/USER.md", { optional: true }),
      downloadTextFromWorkspace(".agents/BOOTSTRAP.md", { optional: true }),
      downloadTextFromWorkspace(".agents/HEARTBEAT.md", { optional: true }),
      downloadTextFromWorkspace(".agents/TOOLS.md", { optional: true }),
      downloadTextFromWorkspace(".agents/MEMORY.md", { optional: true }),
    ]);

  const parts: string[] = [];
  parts.push("You are SupaClaw, a cloud-native personal agent.");

  if (agents?.trim()) {
    parts.push("\n## AGENTS\n" + agents?.trim());
  }

  if (soul?.trim()) {
    parts.push("\n## SOUL\n" + soul?.trim());
  }

  if (identity?.trim()) {
    parts.push("\n## IDENTITY\n" + identity?.trim());
  }

  if (user?.trim()) {
    parts.push("\n## USER\n" + user?.trim());
  }

  if (bootstrap?.trim()) {
    parts.push("\n## BOOTSTRAP\n" + bootstrap?.trim());
  }

  if (heartbeat?.trim()) {
    parts.push("\n## HEARTBEAT\n" + heartbeat?.trim());
  }

  if (memory?.trim()) {
    parts.push("\n## MEMORY (long term from MEMORY.md)\n" + memory?.trim());
  }

  if (tools?.trim()) {
    parts.push("\n## TOOLS\n" + tools?.trim());
  }

  const skillsBlock = await buildSkillsInstructionsBlock().catch(() => "");
  if (skillsBlock.trim()) {
    parts.push(skillsBlock);
  }

  return parts.join("\n");
}

export async function buildInputMessages({
  sessionId,
}: {
  sessionId: string;
}): Promise<MessageRow[]> {
  const supabase = createServiceClient();
  const latestMessagesCount = getConfigNumber("agent.latest_messages_count") ??
    20;

  const systemPrompt = await buildSystemPrompt();

  // Build short chat context (last N messages).
  // Query newest first for index efficiency, then reverse for chronological model input.
  const { data: recent, error: recentErr } = await supabase
    .from("messages")
    .select(
      "role, content, file_id, tool_name, tool_result, tool_status, tool_error",
    )
    .eq("session_id", sessionId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(latestMessagesCount);
  if (recentErr) {
    throw new Error(`Failed to load recent messages: ${recentErr.message}`);
  }

  const messages: MessageRow[] = [
    { role: "system", content: systemPrompt },
    ...(recent ?? []).reverse(),
  ];

  return messages;
}
