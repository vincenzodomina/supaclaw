import { jsonSchema, tool } from "ai";
import { logger } from "../logger.ts";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const DEFAULT_TIMEOUT_SECONDS = 25;
const MAX_TIMEOUT_SECONDS = 60;
const DETAIL_MAX_CHARS = 500;
const FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;
const FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const PROVIDERS = ["auto", "brave", "exa"] as const;

type SearchProvider = (typeof PROVIDERS)[number];

type WebSearchArgs = {
  query: string;
  provider?: SearchProvider;
  count?: number;
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  timeout_seconds?: number;
};

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type ExaSearchResult = {
  title?: string;
  url?: string;
  text?: string;
  publishedDate?: string;
};

type ExaSearchResponse = {
  results?: ExaSearchResult[];
};

type SearchResultItem = {
  title: string;
  url: string;
  snippet: string;
  published?: string;
  site_name?: string;
};

type SearchPayload = {
  query: string;
  provider: "brave" | "exa";
  count: number;
  took_ms: number;
  results: SearchResultItem[];
};

type ProviderError = {
  error: string;
  message: string;
  status?: number;
};

type ProviderResult =
  | { ok: true; payload: SearchPayload }
  | { ok: false; failure: ProviderError };

function clampCount(value: number | undefined): number {
  const parsed = typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : DEFAULT_COUNT;
  return Math.max(1, Math.min(MAX_COUNT, parsed));
}

function clampTimeoutSeconds(value: number | undefined): number {
  const parsed = typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_SECONDS;
  return Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, parsed));
}

function trimAndLimit(value: string | undefined, maxChars: number): string {
  const normalized = (value ?? "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars);
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (FRESHNESS_SHORTCUTS.has(trimmed)) return trimmed;

  const match = trimmed.match(FRESHNESS_RANGE);
  if (!match) return undefined;
  const start = match[1];
  const end = match[2];
  if (!start || !end) return undefined;
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) return undefined;
  if (start > end) return undefined;
  return `${start}to${end}`;
}

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function readErrorDetail(input: string): string {
  const detail = input.trim();
  if (!detail) return "";
  if (detail.length <= DETAIL_MAX_CHARS) return detail;
  return detail.slice(0, DETAIL_MAX_CHARS);
}

async function runBraveSearch(params: {
  query: string;
  apiKey: string;
  count: number;
  timeoutSeconds: number;
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
}): Promise<ProviderResult> {
  const requestUrl = new URL(BRAVE_SEARCH_ENDPOINT);
  requestUrl.searchParams.set("q", params.query);
  requestUrl.searchParams.set("count", String(params.count));
  if (params.country) requestUrl.searchParams.set("country", params.country);
  if (params.search_lang) requestUrl.searchParams.set("search_lang", params.search_lang);
  if (params.ui_lang) requestUrl.searchParams.set("ui_lang", params.ui_lang);
  if (params.freshness) requestUrl.searchParams.set("freshness", params.freshness);

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutSeconds * 1000);

  try {
    const res = await fetch(requestUrl.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": params.apiKey,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = readErrorDetail(await res.text());
      return {
        ok: false,
        failure: {
          error: "brave_search_failed",
          status: res.status,
          message: detail
            ? `Brave Search API error (${res.status}): ${detail}`
            : `Brave Search API error (${res.status}).`,
        },
      };
    }

    const data = await res.json() as BraveSearchResponse;
    const rawResults = Array.isArray(data.web?.results) ? data.web?.results : [];
    const results = rawResults.map((entry) => {
      const url = trimAndLimit(entry.url, 2_000);
      const title = trimAndLimit(entry.title, 300);
      const snippet = trimAndLimit(entry.description, 600);
      return {
        title,
        url,
        snippet,
        published: trimAndLimit(entry.age, 80) || undefined,
        site_name: resolveSiteName(url),
      };
    }).filter((entry) => entry.url || entry.title || entry.snippet);

    return {
      ok: true,
      payload: {
        query: params.query,
        provider: "brave",
        count: results.length,
        took_ms: Date.now() - startedAt,
        results,
      },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      failure: {
        error: "brave_search_error",
        message,
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runExaSearch(params: {
  query: string;
  apiKey: string;
  count: number;
  timeoutSeconds: number;
}): Promise<ProviderResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutSeconds * 1000);

  try {
    const res = await fetch(EXA_SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": params.apiKey,
      },
      body: JSON.stringify({
        query: params.query,
        numResults: params.count,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = readErrorDetail(await res.text());
      return {
        ok: false,
        failure: {
          error: "exa_search_failed",
          status: res.status,
          message: detail ? `Exa API error (${res.status}): ${detail}` : `Exa API error (${res.status}).`,
        },
      };
    }

    const data = await res.json() as ExaSearchResponse;
    const rawResults = Array.isArray(data.results) ? data.results : [];
    const results = rawResults.map((entry) => {
      const url = trimAndLimit(entry.url, 2_000);
      const title = trimAndLimit(entry.title, 300);
      const snippet = trimAndLimit(entry.text, 600);
      return {
        title,
        url,
        snippet,
        published: trimAndLimit(entry.publishedDate, 80) || undefined,
        site_name: resolveSiteName(url),
      };
    }).filter((entry) => entry.url || entry.title || entry.snippet);

    return {
      ok: true,
      payload: {
        query: params.query,
        provider: "exa",
        count: results.length,
        took_ms: Date.now() - startedAt,
        results,
      },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      failure: {
        error: "exa_search_error",
        message,
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export const webSearchTool = tool({
  description: [
    "Search the web and return compact, structured results.",
    "",
    "Use this when you need current events or information beyond the model's knowledge cutoff.",
    "If you need full page content from one result, call web_fetch on that result URL.",
    "Provider behavior: auto tries Brave first, then Exa as fallback when configured.",
    "",
    "Notes:",
    "- count is clamped to 1-10 (default 5).",
    "- freshness supports pd/pw/pm/py or YYYY-MM-DDtoYYYY-MM-DD.",
    "- For current events, include the current year in your query.",
  ].join("\n"),
  inputSchema: jsonSchema<WebSearchArgs>({
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query.",
      },
      provider: {
        type: "string",
        enum: ["auto", "brave", "exa"],
        description: "Search provider. auto (default) tries Brave, then Exa fallback if available.",
      },
      count: {
        type: "number",
        description: "Number of results to return (1-10, default 5).",
      },
      country: {
        type: "string",
        description: "2-letter country code for region-specific results (e.g. US, DE, ALL).",
      },
      search_lang: {
        type: "string",
        description: "Language code for search results (e.g. en, de, fr).",
      },
      ui_lang: {
        type: "string",
        description: "Language code for UI labels.",
      },
      freshness: {
        type: "string",
        description: "pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD.",
      },
      timeout_seconds: {
        type: "number",
        description: "HTTP timeout in seconds (default 25, max 60).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  }),
  execute: async (args: WebSearchArgs) => {
    const { query, provider, count, country, search_lang, ui_lang, freshness, timeout_seconds } = args;
    const braveApiKey = (Deno.env.get("BRAVE_API_KEY") ?? "").trim();
    const exaApiKey = (Deno.env.get("EXA_API_KEY") ?? "").trim();

    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return { error: "invalid_query", message: "query must be a non-empty string." };
    }

    const normalizedFreshness = freshness ? normalizeFreshness(freshness) : undefined;
    if (freshness && !normalizedFreshness) {
      return {
        error: "invalid_freshness",
        message: "freshness must be one of pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD.",
      };
    }

    const timeout = clampTimeoutSeconds(timeout_seconds);
    const limit = clampCount(count);
    const normalizedCountry = trimAndLimit(country, 8);
    const normalizedSearchLang = trimAndLimit(search_lang, 16);
    const normalizedUiLang = trimAndLimit(ui_lang, 16);

    const requestedProvider = provider ?? "auto";
    const tries: Array<"brave" | "exa"> = requestedProvider === "brave"
      ? ["brave"]
      : requestedProvider === "exa"
      ? ["exa"]
      : ["brave", "exa"];

    let lastFailure: ProviderError | undefined;
    for (const candidate of tries) {
      if (candidate === "brave") {
        if (!braveApiKey) {
          lastFailure = {
            error: "missing_brave_api_key",
            message: "BRAVE_API_KEY is not set.",
          };
          continue;
        }
        const brave = await runBraveSearch({
          query: normalizedQuery,
          apiKey: braveApiKey,
          count: limit,
          timeoutSeconds: timeout,
          country: normalizedCountry || undefined,
          search_lang: normalizedSearchLang || undefined,
          ui_lang: normalizedUiLang || undefined,
          freshness: normalizedFreshness,
        });
        if (brave.ok) {
          if (requestedProvider === "auto") {
            return { ...brave.payload, attempted: tries };
          }
          return brave.payload;
        }
        lastFailure = brave.failure;
        logger.warn("tool.web_search.provider_failed", {
          provider: "brave",
          message: brave.failure.message,
          status: brave.failure.status,
        });
        continue;
      }

      if (!exaApiKey) {
        lastFailure = {
          error: "missing_exa_api_key",
          message: "EXA_API_KEY is not set.",
        };
        continue;
      }
      const exa = await runExaSearch({
        query: normalizedQuery,
        apiKey: exaApiKey,
        count: limit,
        timeoutSeconds: timeout,
      });
      if (exa.ok) {
        if (requestedProvider === "auto") {
          return { ...exa.payload, attempted: tries };
        }
        return exa.payload;
      }
      lastFailure = exa.failure;
      logger.warn("tool.web_search.provider_failed", {
        provider: "exa",
        message: exa.failure.message,
        status: exa.failure.status,
      });
    }

    if (requestedProvider === "auto") {
      return {
        error: "web_search_unavailable",
        message:
          "No configured web search provider succeeded. Set BRAVE_API_KEY and/or EXA_API_KEY.",
        attempted: tries,
        last_failure: lastFailure,
      };
    }

    if (requestedProvider === "brave" && !braveApiKey) {
      return {
        error: "missing_brave_api_key",
        message:
          "web_search provider=brave requires BRAVE_API_KEY. Set it with `supabase secrets set BRAVE_API_KEY=...`.",
      };
    }

    if (requestedProvider === "exa" && !exaApiKey) {
      return {
        error: "missing_exa_api_key",
        message:
          "web_search provider=exa requires EXA_API_KEY. Set it with `supabase secrets set EXA_API_KEY=...`.",
      };
    }

    return {
      error: "web_search_error",
      message: lastFailure?.message || "Web search provider failed.",
      status: lastFailure?.status,
      provider: requestedProvider,
    };
  },
});
