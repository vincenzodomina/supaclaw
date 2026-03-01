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
      throw new Error(
        "renderDocumentToPngPages: missing bytes for image source",
      );
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

  // TODO: Implement actual document rendering
  const rendered = [];

  const pages: RenderedPage[] = await Promise.resolve([
    { pageNumber: 1, mediaType: "image/png", bytes: new Uint8Array() },
  ]);

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
