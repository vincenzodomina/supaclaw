import { readFileTool } from "./read_file.ts";
import { writeFileTool } from "./write_file.ts";
import { listFilesTool } from "./list_files.ts";
import { editFileTool } from "./edit_file.ts";
import { skillsTool } from "./skills.ts";
import { createCronTool } from "./cron.ts";

export { computeNextRun } from "./cron.ts";

export const tools = {
  read_file: readFileTool,
  write_file: writeFileTool,
  list_files: listFilesTool,
  edit_file: editFileTool,
  skills: skillsTool,
} as const;

export function createAllTools(sessionId: string) {
  return {
    ...tools,
    cron: createCronTool(sessionId),
  } as const;
}
