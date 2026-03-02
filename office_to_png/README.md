# office-to-png

Convert Office documents and PDFs into **OCR-friendly, per-page PNGs**.

- **Office → PDF**: uses LibreOffice (`libreoffice` / `soffice`) in headless mode
- **PDF → PNG**: renders pages via `pypdfium2` and writes `page_0001.png`, `page_0002.png`, …

## Requirements

- **Python**: 3.10+
- **LibreOffice**: required for non-PDF inputs (`.docx`, `.pptx`, `.xlsx`, …)
  - The binary must be discoverable as `libreoffice` or `soffice` on `PATH`.

## Install (recommended: one command)

```bash
./office_to_png/install.sh
```

This will:
- install LibreOffice + common fonts (macOS + Linux, best-effort)
- create a venv at `~/.office-to-png/.venv`
- install this package into the venv
- symlink `office-to-png` into `~/.local/bin/office-to-png`

If `office-to-png` is not found afterwards:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Usage

Show help:

```bash
office-to-png --help
```

### Convert an Office file (default output folder)

```bash
office-to-png --input /path/to/report.docx
```

If you omit `--outdir`, outputs go to a sibling folder next to the input named after the input file:

- `/path/to/report.docx` → `/path/to/report/page_0001.png`, …

### Convert an Office file (custom output folder)

```bash
office-to-png --input /path/to/report.pptx --outdir /tmp/report-pages --dpi 200
```

### Convert a PDF (LibreOffice not used)

```bash
office-to-png --input /path/to/file.pdf --outdir ./out --dpi 250
```

### Tune timeouts (Office → PDF step)

```bash
office-to-png --input ./big.xlsx --timeout-s 300
```

## Output

The command writes:
- `page_0001.png`
- `page_0002.png`
- …

PNG output is deterministic and “OCR-friendly” (no alpha channel).

## Docker (optional)

Build + run locally:

```bash
docker build -t office-to-png ./office_to_png
docker run --rm -v "$PWD:/work" office-to-png --input /work/in.docx --outdir /work/out --dpi 200
```

Or via the included compose file (uses `./office_to_png/data` mounted to `/data`):

```bash
docker compose -f office_to_png/docker-compose.yml run --rm office_to_png --input /data/in.docx --outdir /data/out --dpi 200
```

## HTTP mode (Supabase Storage, user-scoped JWT)

The Docker image also supports running a **slim HTTP wrapper** around the converter. This is useful when you want an external service your Edge Function can call, while keeping reads/writes **user-scoped** via the passed Supabase JWT.

### How it works (high level)
- Caller (e.g. Edge Function) sends:
  - `Authorization: Bearer <SUPABASE_USER_JWT>`
  - input Storage `{bucket, path}`
  - output Storage `{bucket, path}` (treated as an output *prefix*)
- The service:
  - validates the token (`auth.get_user`)
  - downloads the input via Supabase Storage APIs using that JWT
  - converts in-process (imports the converter; no wrapper subprocess)
  - uploads `page_XXXX.png` files back to Storage using that JWT

### Run the HTTP service via docker compose

```bash
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SUPABASE_ANON_KEY="<your anon key>"
docker compose -f office_to_png/docker-compose.yml up --build office_to_png_http
```

### Call the service

```bash
curl -sS -X POST "http://localhost:8000/v1/render" \
  -H "authorization: Bearer $SUPABASE_USER_JWT" \
  -H "content-type: application/json" \
  -d '{
    "input": { "bucket": "uploads", "path": "user123/in/report.docx" },
    "output": { "bucket": "uploads", "path": "user123/out/report" },
    "options": { "dpi": 200, "timeout_s": 120 }
  }'
```

Response includes `pages`, `elapsed_ms`, and an `artifacts` list with uploaded object paths.

### Private-by-default networking

The compose setup binds the port to `127.0.0.1` for host testing and avoids public exposure on a VPS.
Other containers on the Docker network can still reach the service at:

- `http://office_to_png_http:8000/v1/render`

If you need to make this reachable from outside the host (e.g. Supabase Cloud Edge Functions), publish it
behind a reverse proxy and add rate limiting / IP allowlists as appropriate.

