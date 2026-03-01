import { mustGetEnv } from "./helpers.ts";

export type DocumentSource = {
  bucket: string;
  objectPath: string;
  name: string;
  mimeType: string | null;
};

export type RenderedPage = {
  pageNumber: number;
  /** The renderer should prefer PNG for OCR quality. */
  mediaType: "image/png";
  bytes: Uint8Array;
};

export type RenderResult = {
  pages: RenderedPage[];
};

/**
 * Ideal API contract (to be implemented by an external service):
 *
 * POST {DOC_RENDERER_URL}/v1/render
 * Headers:
 *  - Authorization: Bearer <DOC_RENDERER_API_KEY>
 * Body (JSON):
 *  {
 *    "source": { "bucket": "...", "object_path": "...", "name": "...", "mime_type": "..." },
 *    "output": { "format": "png", "max_pages": null }
 *  }
 * Response (JSON):
 *  {
 *    "pages": [
 *      { "page_number": 1, "media_type": "image/png", "bytes_base64": "..." }
 *    ]
 *  }
 */
export async function renderDocumentToPngPages(params: {
  source: DocumentSource;
  /** Original bytes may be provided for single-image sources. */
  bytes?: Uint8Array;
}): Promise<RenderResult> {
  const mime = params.source.mimeType ?? "";
  const isImage = mime.startsWith("image/");

  // Mock behavior: for image uploads, treat as a single "page" without conversion.
  // For PDFs/office docs, require an external renderer API.
  if (isImage) {
    if (!params.bytes?.byteLength) {
      throw new Error("renderDocumentToPngPages: missing bytes for image source");
    }
    return {
      pages: [
        {
          pageNumber: 1,
          mediaType: "image/png",
          bytes: params.bytes,
        },
      ],
    };
  }

  const baseUrl = Deno.env.get("DOC_RENDERER_URL")?.trim();
  if (!baseUrl) {
    throw new Error(
      "DOC_RENDERER_URL is not set (required to render PDFs/office documents into page images)",
    );
  }

  const apiKey = mustGetEnv("DOC_RENDERER_API_KEY");
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/render`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      source: {
        bucket: params.source.bucket,
        object_path: params.source.objectPath,
        name: params.source.name,
        mime_type: params.source.mimeType,
      },
      output: { format: "png", max_pages: null },
    }),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `Document renderer failed (${res.status}): ${text.slice(0, 500)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Document renderer returned invalid JSON");
  }

  const obj = parsed as Record<string, unknown>;
  const pages = Array.isArray(obj.pages) ? obj.pages : [];
  const rendered: RenderedPage[] = [];

  for (const p of pages) {
    const page = p as Record<string, unknown>;
    const pageNumber = Number(page.page_number);
    const mediaType = String(page.media_type || "") as "image/png";
    const b64 = String(page.bytes_base64 || "");
    if (!Number.isFinite(pageNumber) || pageNumber < 1) continue;
    if (mediaType !== "image/png") continue;
    if (!b64) continue;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    rendered.push({ pageNumber, mediaType, bytes });
  }

  if (rendered.length === 0) {
    throw new Error("Document renderer returned zero pages");
  }

  rendered.sort((a, b) => a.pageNumber - b.pageNumber);
  return { pages: rendered };
}

