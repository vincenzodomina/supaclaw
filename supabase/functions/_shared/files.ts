import { createServiceClient } from "./supabase.ts";
import { cleanupWorkspacePrefix, downloadFile, uploadFile } from "./storage.ts";
import { logger } from "./logger.ts";
import { renderDocumentToPngPages } from "./documents.ts";
import { ocrPageImage } from "./ocr.ts";

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

function derivedPrefix(objectPath: string): string {
  // Requirement: deterministic folder named exactly like the stored path.
  return objectPath.replace(/\/+$/, "");
}

function pageImagePath(objectPath: string, pageNumber: number): string {
  return `${derivedPrefix(objectPath)}/page_${pad4(pageNumber)}.png`;
}

function pageTextPath(objectPath: string, pageNumber: number): string {
  return `${derivedPrefix(objectPath)}/page_${pad4(pageNumber)}.txt`;
}

function fullTextPath(objectPath: string): string {
  return `${derivedPrefix(objectPath)}/full.txt`;
}

function isTextLike(mimeType: string | null): boolean {
  const mt = (mimeType ?? "").toLowerCase();
  return mt.startsWith("text/") || mt.includes("json") || mt.includes("xml");
}

export async function processFileById(fileId: string): Promise<void> {
  const supabase = createServiceClient();

  try {
    const { data: file, error: loadErr } = await supabase
      .from("files")
      .select("id, bucket, object_path, name, mime_type, content")
      .eq("id", fileId)
      .maybeSingle();
    if (loadErr) throw new Error(`Failed to load file: ${loadErr.message}`);
    if (!file) throw new Error(`File not found: ${fileId}`);

    const objectPath = file.object_path;
    const name = file.name;
    const mimeType = file.mime_type;

    const now = new Date().toISOString();
    const patch = isTextLike(mimeType)
      ? {
        processing_status: "skipped" as const,
        processed_at: now,
        page_count: 1,
        last_error: null,
        updated_at: now,
      }
      : {
        processing_status: "processing" as const,
        processed_at: null,
        page_count: null,
        last_error: null,
        updated_at: now,
      };

    await supabase.from("files").update(patch).eq("id", fileId);

    if (isTextLike(mimeType)) return;

    const downloaded = await downloadFile(objectPath);
    if (!downloaded?.data?.byteLength) {
      throw new Error(`Original file bytes missing in storage: ${objectPath}`);
    }

    // Cleanup derived artifacts from any previous processing run.
    // Safe: only touches objects under `${objectPath}/...`, never the original blob at `objectPath`.
    const prefix = derivedPrefix(objectPath);
    await cleanupWorkspacePrefix(prefix).catch((error) => {
      logger.warn("file_processing.cleanup_failed", { fileId, prefix, error });
    });

    const render = await renderDocumentToPngPages({
      source: {
        bucket: file.bucket,
        objectPath,
        name,
        mimeType,
      },
      bytes: downloaded.data,
    });

    let assembled = "";
    for (const page of render.pages) {
      const imgPath = pageImagePath(objectPath, page.pageNumber);
      const txtPath = pageTextPath(objectPath, page.pageNumber);

      // Always write page image + page text (even empty text) to avoid retries.
      await uploadFile(imgPath, page.bytes, {
        mimeType: page.mediaType,
        name: `page_${pad4(page.pageNumber)}.png`,
      });

      let text = "";
      try {
        text = await ocrPageImage({
          imageBytes: page.bytes,
          mediaType: page.mediaType,
        });
      } catch (error) {
        logger.error("file_processing.ocr_failed", {
          fileId,
          objectPath,
          pageNumber: page.pageNumber,
          error,
        });
        // Persist empty page text so future runs don't get stuck on one page.
        text = "";
      }

      await uploadFile(txtPath, text, {
        mimeType: "text/plain; charset=utf-8",
        name: `page_${pad4(page.pageNumber)}.txt`,
      });

      if (text.trim()) {
        assembled += (assembled ? "\n\n" : "") + text.trim();
      }
    }

    const fullPath = fullTextPath(objectPath);
    await uploadFile(fullPath, assembled, {
      mimeType: "text/plain; charset=utf-8",
      name: "full.txt",
    });

    const oneLiner = `${name}${mimeType ? ` (${mimeType})` : ""} → ${fullPath}`;

    await supabase.from("files").update({
      processing_status: "succeeded",
      processed_at: new Date().toISOString(),
      page_count: render.pages.length,
      last_error: null,
      content: oneLiner,
      updated_at: new Date().toISOString(),
    }).eq("id", fileId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("file_processing.failed", { fileId, error: msg });
    const { error: updateErr } = await supabase.from("files").update({
      processing_status: "failed",
      processed_at: new Date().toISOString(),
      last_error: msg,
      updated_at: new Date().toISOString(),
    }).eq("id", fileId);
    if (updateErr) {
      logger.warn("file_processing.failed_db_update_failed", {
        fileId,
        error: updateErr,
      });
    }

    // Important: rethrow so the queue job is not deleted and can retry.
    // The worker owns retry semantics; this function owns DB state updates.
    throw error instanceof Error ? error : new Error(msg);
  }
}
