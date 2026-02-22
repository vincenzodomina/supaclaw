import { readFileTool } from "./read_file.ts";
import { writeFileTool } from "./write_file.ts";
import { listFilesTool } from "./list_files.ts";
import { editFileTool } from "./edit_file.ts";
import { skillsTool } from "./skills.ts";
import { createCronTool } from "./cron.ts";
import { webFetchTool } from "./web_fetch.ts";
import { webSearchTool } from "./web_search.ts";
import { createMemorySearchTool } from "./memory_search.ts";
import { createBashTool } from "./bash.ts";

export const tools = {
  read_file: readFileTool,
  write_file: writeFileTool,
  list_files: listFilesTool,
  edit_file: editFileTool,
  skills: skillsTool,
  web_fetch: webFetchTool,
  web_search: webSearchTool,
} as const;

export function createAllTools(sessionId: string) {
  return {
    ...tools,
    cron: createCronTool(sessionId),
    memory_search: createMemorySearchTool(sessionId),
    bash: createBashTool(sessionId),
  } as const;
}
