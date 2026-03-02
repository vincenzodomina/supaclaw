import os
import tempfile
import time
import inspect
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from supabase import AClient, AsyncClientOptions, create_async_client

from . import office_to_pdf, pdf_to_png_pages


app = FastAPI(title="office-to-png", version="0.1.0")


def _get_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing required env: {name}")
    return value


def _validate_object_path(p: str) -> None:
    # Keep this intentionally strict: Storage object keys should be relative.
    if not p or p.startswith("/") or "\\\\" in p or "\\/" in p:
        raise HTTPException(status_code=400, detail="invalid storage path")
    parts = p.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise HTTPException(status_code=400, detail="invalid storage path")


def _extract_bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split(" ", 1)
    if len(parts) != 2:
        return None
    scheme, token = parts[0].strip(), parts[1].strip()
    if scheme.lower() != "bearer" or not token:
        return None
    return token


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def _supabase_user_client(access_token: str) -> AClient:
    url = _get_env("SUPABASE_URL")
    anon_key = _get_env("SUPABASE_ANON_KEY")
    options = AsyncClientOptions(
        auto_refresh_token=False,
        persist_session=False,
        headers={"Authorization": f"Bearer {access_token}"},
    )
    return await create_async_client(url, anon_key, options=options)


def _bytes_from_download(result: Any) -> bytes:
    if isinstance(result, (bytes, bytearray)):
        return bytes(result)
    data = getattr(result, "data", None)
    if isinstance(data, (bytes, bytearray)):
        return bytes(data)
    if isinstance(data, str):
        # Some clients may return decoded text; Storage objects are bytes.
        return data.encode("utf-8")
    raise RuntimeError("unexpected download result type")


class StorageRef(BaseModel):
    bucket: str = Field(..., min_length=1)
    path: str = Field(..., min_length=1)


class RenderOptions(BaseModel):
    dpi: int = Field(200, ge=50, le=600)
    timeout_s: int = Field(120, ge=10, le=3600)


class RenderRequest(BaseModel):
    input: StorageRef
    output: StorageRef
    options: RenderOptions = Field(default_factory=RenderOptions)


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/v1/render")
async def render(
    req: RenderRequest,
    authorization: str | None = Header(default=None),
):
    t0 = time.time()

    _validate_object_path(req.input.path)
    _validate_object_path(req.output.path)

    access_token = _extract_bearer_token(authorization)
    if not access_token:
        raise HTTPException(status_code=401, detail="missing bearer token")

    supabase = await _supabase_user_client(access_token)

    # Validate token early (also helps produce a clean 401).
    try:
        await _maybe_await(supabase.auth.get_user(access_token))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=401, detail="invalid access token") from e

    try:
        dl = supabase.storage.from_(req.input.bucket).download(req.input.path)
        input_bytes = _bytes_from_download(await _maybe_await(dl))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status_code=404, detail="failed to download input from storage"
        ) from e

    input_name = Path(req.input.path).name
    input_suffix = Path(input_name).suffix.lower()

    with tempfile.TemporaryDirectory(prefix="office_to_png_http_") as td:
        tmpdir = Path(td)
        local_in = tmpdir / input_name
        local_in.write_bytes(input_bytes)

        local_out = tmpdir / "out"
        local_out.mkdir(parents=True, exist_ok=True)

        tmp_pdf: Path | None = None
        try:
            if input_suffix == ".pdf":
                pdf_path = local_in
            else:
                tmp_pdf = office_to_pdf(local_in, timeout_s=req.options.timeout_s)
                pdf_path = tmp_pdf

            pages = pdf_to_png_pages(pdf_path, outdir=local_out, dpi=req.options.dpi)

            artifacts: list[dict[str, Any]] = []
            for page_path in sorted(local_out.glob("page_*.png")):
                object_key = f"{req.output.path.rstrip('/')}/{page_path.name}"
                try:
                    up = supabase.storage.from_(req.output.bucket).upload(
                        object_key,
                        page_path.read_bytes(),
                        file_options={"content-type": "image/png", "upsert": "true"},
                    )
                    await _maybe_await(up)
                except Exception as e:  # noqa: BLE001
                    raise HTTPException(
                        status_code=500, detail=f"failed to upload {page_path.name}"
                    ) from e

                artifacts.append(
                    {
                        "bucket": req.output.bucket,
                        "path": object_key,
                        "content_type": "image/png",
                        "size": page_path.stat().st_size,
                    }
                )

            return {
                "ok": True,
                "pages": pages,
                "input": {"bucket": req.input.bucket, "path": req.input.path},
                "output_prefix": {"bucket": req.output.bucket, "path": req.output.path},
                "artifacts": artifacts,
                "elapsed_ms": int((time.time() - t0) * 1000),
            }
        finally:
            if tmp_pdf is not None:
                # office_to_pdf created a temp directory; clean it up.
                try:
                    import shutil

                    shutil.rmtree(tmp_pdf.parent, ignore_errors=True)
                except Exception:
                    pass

