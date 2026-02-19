import { jsonSchema, tool } from "ai";
import { embedText } from "../embeddings.ts";
import { logger } from "../logger.ts";
import { createServiceClient } from "../supabase.ts";

const supabase = createServiceClient();

const MEMORY_TYPES = ["pinned_fact", "summary"] as const;
const MEMORY_SCOPE = ["auto", "current", "all"] as const;

type MemoryType = (typeof MEMORY_TYPES)[number];
type MemoryScope = (typeof MEMORY_SCOPE)[number];

type MemorySearchArgs = {
  query: string;
  max_results?: number;
  match_count?: number;
  types?: MemoryType[];
  scope?: MemoryScope;
};

type MemoryRow = {
  id: number;
  session_id: string | null;
  type: MemoryType;
  content: string;
  priority: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

function clampInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeTypes(types: MemoryType[] | undefined): MemoryType[] {
  if (!Array.isArray(types) || types.length === 0) {
    return [...MEMORY_TYPES];
  }
  const valid = new Set(MEMORY_TYPES);
  const normalized = Array.from(
    new Set(types.filter((entry) => valid.has(entry))),
  );
  if (normalized.length === 0) {
    return [...MEMORY_TYPES];
  }
  return normalized;
}

function normalizeScope(scope: MemoryScope | undefined): MemoryScope {
  if (!scope) return "auto";
  if (scope === "auto" || scope === "current" || scope === "all") return scope;
  return "auto";
}

function selectAutoScopedMemories(params: {
  rows: MemoryRow[];
  sessionId: string;
  maxResults: number;
  allowedTypes: Set<MemoryType>;
}) {
  const pinnedLimit = Math.max(1, Math.ceil(params.maxResults / 2));
  const summaryLimit = Math.max(0, params.maxResults - pinnedLimit);
  const pinned: MemoryRow[] = [];
  const summaries: MemoryRow[] = [];

  for (const row of params.rows) {
    if (!params.allowedTypes.has(row.type)) continue;
    if (row.type === "pinned_fact" && pinned.length < pinnedLimit) {
      pinned.push(row);
      continue;
    }
    if (
      row.type === "summary" && row.session_id === params.sessionId &&
      summaries.length < summaryLimit
    ) {
      summaries.push(row);
    }
    if (pinned.length >= pinnedLimit && summaries.length >= summaryLimit) break;
  }

  return [...pinned, ...summaries].slice(0, params.maxResults);
}

export function createMemorySearchTool(sessionId: string) {
  return tool({
    description: [
      "Search long-term memory (pinned facts + summaries) using hybrid semantic + full-text ranking.",
      "Use this before answering questions about prior decisions, preferences, tasks, or past context.",
      "Scope defaults to auto: prioritize pinned facts globally and summaries from the current session.",
      "If no relevant memories are found, say that explicitly.",
    ].join(" "),
    inputSchema: jsonSchema<MemorySearchArgs>({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language memory lookup query.",
        },
        max_results: {
          type: "number",
          description: "Max returned memories (default 8, min 1, max 20).",
        },
        match_count: {
          type: "number",
          description:
            "Candidate pool size before post-filtering (default 20, min 1, max 30).",
        },
        types: {
          type: "array",
          items: { type: "string", enum: [...MEMORY_TYPES] },
          description: "Optional memory types filter.",
        },
        scope: {
          type: "string",
          enum: [...MEMORY_SCOPE],
          description: "auto|current|all; default auto.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    execute: async (args: MemorySearchArgs) => {
      try {
        const query = (args.query ?? "").trim();
        if (!query) {
          return { error: "query is required" };
        }

        const maxResults = clampInt(args.max_results, 8, 1, 20);
        const matchCount = clampInt(
          args.match_count,
          Math.max(20, maxResults * 2),
          1,
          30,
        );
        const scope = normalizeScope(args.scope);
        const types = normalizeTypes(args.types);
        const typeSet = new Set(types);

        const queryEmbedding = await embedText(query);
        const filterSessionId = scope === "current" ? sessionId : null;

        const { data, error } = await supabase.rpc("hybrid_search", {
          query_text: query,
          query_embedding: queryEmbedding,
          match_count: matchCount,
          search_tables: ["memories"],
          filter_type: types,
          filter_session_id: filterSessionId,
        });

        if (error) {
          throw new Error(`hybrid_search failed: ${error.message}`);
        }

        const rows = (data?.memories ?? []) as MemoryRow[];
        const selected = scope === "auto"
          ? selectAutoScopedMemories({
            rows,
            sessionId,
            maxResults,
            allowedTypes: typeSet,
          })
          : rows.filter((row) => typeSet.has(row.type)).slice(0, maxResults);

        logger.debug("tool.memory_search.done", {
          queryLength: query.length,
          sessionId,
          scope,
          requestedMaxResults: maxResults,
          candidateCount: rows.length,
          returnedCount: selected.length,
        });

        return {
          query,
          scope,
          types,
          count: selected.length,
          results: selected,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("tool.memory_search.failed", {
          sessionId,
          message,
        });
        return {
          error: "memory_search_failed",
          message,
        };
      }
    },
  });
}
