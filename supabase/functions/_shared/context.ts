import { createServiceClient } from "../_shared/supabase.ts";
import { buildSkillsInstructionsBlock } from "./skills.ts";
import { decodeUtf8, downloadFile } from "./storage.ts";
import { getConfigNumber } from "./helpers.ts";
import type { Tables } from "./database.types.ts";

type MessageRow =
  & Pick<Tables<"messages">, "role" | "content">
  & Partial<
    Pick<
      Tables<"messages">,
      "file_id" | "tool_name" | "tool_result" | "tool_status" | "tool_error"
    >
  >;

type TimelineRow = Pick<
  Tables<"messages">,
  | "role"
  | "type"
  | "content"
  | "file_id"
  | "tool_name"
  | "tool_result"
  | "tool_status"
  | "tool_error"
>;

export async function buildSystemPrompt(): Promise<string> {
  const readOptionalText = async (path: string) => {
    const file = await downloadFile(path, { optional: true });
    return file ? decodeUtf8(file) : null;
  };
  const [agents, soul, identity, user, bootstrap, heartbeat, tools, memory] =
    await Promise.all([
      readOptionalText(".agents/AGENTS.md"),
      readOptionalText(".agents/SOUL.md"),
      readOptionalText(".agents/IDENTITY.md"),
      readOptionalText(".agents/USER.md"),
      readOptionalText(".agents/BOOTSTRAP.md"),
      readOptionalText(".agents/HEARTBEAT.md"),
      readOptionalText(".agents/TOOLS.md"),
      readOptionalText(".agents/MEMORY.md"),
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
      "role, type, content, file_id, tool_name, tool_result, tool_status, tool_error",
    )
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(latestMessagesCount);
  if (recentErr) {
    throw new Error(`Failed to load recent messages: ${recentErr.message}`);
  }

  const messages: MessageRow[] = [
    { role: "system", content: systemPrompt },
    ...((recent ?? []) as unknown as TimelineRow[]).reverse().map(
      (row: TimelineRow): MessageRow => ({
        role: row.role,
        content: row.content,
        ...(row.type === "file"
          ? {
            file_id: row.file_id,
          }
          : {}),
        ...(row.type === "tool-call"
          ? {
            tool_name: row.tool_name ?? null,
            tool_status: row.tool_status ?? null,
            tool_result: row.tool_result ?? null,
            tool_error: row.tool_error ?? null,
          }
          : {}),
      }),
    ),
  ];

  return messages;
}
