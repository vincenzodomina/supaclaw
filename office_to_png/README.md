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

