import { createServiceClient } from "./supabase.ts";
import { logger } from "./logger.ts";

const supabase = createServiceClient();

function getWorkspaceBucketName(): string {
  return Deno.env.get("WORKSPACE_BUCKET") ?? "workspace";
}

export function sanitizeObjectPath(objectPath: string): string {
  const normalizedPath = objectPath.replace(/\\/g, "/").replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  if (!normalizedPath || normalizedPath.includes("..")) {
    throw new Error("Invalid storage path");
  }
  return normalizedPath;
}

export function sanitizeObjectPrefix(objectPathPrefix: string): string {
  const raw = objectPathPrefix.trim();
  if (!raw || raw === "." || raw === "./") return "";

  const normalizedPath = raw
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");

  if (normalizedPath.includes("..")) {
    throw new Error("Invalid storage path");
  }
  return normalizedPath;
}

function isStorageNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as Record<string, unknown>;
  const statusCode = err.statusCode;
  const status = err.status;
  const message = typeof err.message === "string" ? err.message.toLowerCase() : "";
  return statusCode === 404 || status === 404 || message.includes("not found");
}

export async function downloadTextFromWorkspace(
  objectPath: string,
  options?: { optional?: boolean },
): Promise<string | null> {
  const bucket = getWorkspaceBucketName();
  const safePath = sanitizeObjectPath(objectPath);
  const { data, error } = await supabase.storage.from(bucket).download(
    safePath,
  );
  if (error) {
    if (isStorageNotFound(error)) {
      // Agent/profile files are optional; callers should treat missing files as absent context.
      logger.debug("storage.download.not_found", { bucket, objectPath: safePath });
      return null;
    }
    if (options?.optional) {
      // Optional reads should not produce warn-level noise in normal flows.
      logger.debug("storage.download.optional_unavailable", {
        bucket,
        objectPath: safePath,
        error,
      });
      return null;
    }
    logger.warn("storage.download.failed", {
      bucket,
      objectPath: safePath,
      error,
    });
    return null;
  }
  return await data.text();
}

export async function uploadFileToWorkspace(
  objectPath: string,
  content: string | Uint8Array,
  options?: { mimeType?: string; defaultMimeType?: string },
): Promise<{ bucket: string; objectPath: string }> {
  const bucket = getWorkspaceBucketName();
  const safePath = sanitizeObjectPath(objectPath);
  const part = typeof content === "string"
    ? content
    : content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
  const body = new Blob([part], {
    type: options?.mimeType ?? options?.defaultMimeType ?? "application/octet-stream",
  });

  const { error } = await supabase.storage.from(bucket).upload(safePath, body, {
    upsert: true,
    contentType: options?.mimeType,
  });
  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  return { bucket, objectPath: safePath };
}

export async function listWorkspaceObjects(
  objectPathPrefix = "",
  options?: { limit?: number; offset?: number },
): Promise<{
  bucket: string;
  prefix: string;
  objects: Array<{
    name: string;
    id?: string;
    updated_at?: string;
    created_at?: string;
    last_accessed_at?: string;
    metadata?: Record<string, unknown>;
  }>;
}> {
  const bucket = getWorkspaceBucketName();
  const prefix = sanitizeObjectPrefix(objectPathPrefix);

  const { data, error } = await supabase.storage.from(bucket).list(prefix, {
    limit: options?.limit,
    offset: options?.offset,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) {
    throw new Error(`Storage list failed: ${error.message}`);
  }

  return { bucket, prefix, objects: data ?? [] };
}

/** Upload string or binary content to storage and upsert a file DB record. */
export async function uploadFile(
  objectPath: string,
  content: string | Uint8Array,
  options?: { mimeType?: string; name?: string },
): Promise<{ id: string; bucket: string; objectPath: string }> {
  const isText = typeof content === "string";
  const defaultMime = isText ? "text/plain; charset=utf-8" : undefined;
  const upload = await uploadFileToWorkspace(objectPath, content, {
    mimeType: options?.mimeType,
    defaultMimeType: defaultMime,
  });

  const textContent = isText
    ? content
    : (options?.mimeType?.startsWith("text/")
      ? new TextDecoder().decode(content)
      : "");
  const sizeBytes = isText
    ? new TextEncoder().encode(content).byteLength
    : content.byteLength;
  const name = options?.name ??
    upload.objectPath.split("/").filter(Boolean).pop() ?? upload.objectPath;

  const { data: row, error } = await supabase
    .from("files")
    .upsert(
      {
        bucket: upload.bucket,
        object_path: upload.objectPath,
        name,
        content: textContent,
        size_bytes: sizeBytes,
        mime_type: options?.mimeType ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "bucket,object_path" },
    )
    .select("id")
    .single();

  if (error) throw new Error(`Failed to upsert file record: ${error.message}`);
  return { id: row.id, ...upload };
}
