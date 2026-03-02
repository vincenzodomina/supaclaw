#!/usr/bin/env python3
import argparse
import io
import shutil
import subprocess
import tempfile
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image


def office_to_pdf(input_path: Path, *, timeout_s: int = 120) -> Path:
    soffice = shutil.which("libreoffice") or shutil.which("soffice")
    if not soffice:
        raise RuntimeError("LibreOffice/soffice not found on $PATH")

    tmpdir = Path(tempfile.mkdtemp(prefix="office_to_png_"))
    try:
        subprocess.run(
            [
                soffice,
                "--headless",
                "--safe-mode",
                "--nologo",
                "--norestore",
                "--convert-to",
                "pdf",
                "--outdir",
                str(tmpdir),
                str(input_path),
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_s,
        )
    except Exception:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise

    # LibreOffice generally outputs "<stem>.pdf", but be defensive.
    expected = tmpdir / f"{input_path.stem}.pdf"
    if expected.exists():
        return expected
    pdfs = sorted(tmpdir.glob("*.pdf"))
    if len(pdfs) == 1:
        return pdfs[0]
    raise RuntimeError(f"LibreOffice conversion succeeded but no PDF found in {tmpdir}")


def pdf_to_png_pages(pdf_path: Path, *, outdir: Path, dpi: int) -> int:
    outdir.mkdir(parents=True, exist_ok=True)
    pdf_bytes = pdf_path.read_bytes()

    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        n_pages = len(doc)
        if n_pages <= 0:
            return 0
        scale = max(0.1, float(dpi) / 72.0)

        for i in range(n_pages):
            page = doc[i]
            pil: Image.Image = page.render(scale=scale).to_pil()
            # Ensure deterministic RGB PNG output (OCR-friendly).
            if pil.mode not in ("RGB", "RGBA"):
                pil = pil.convert("RGB")
            elif pil.mode == "RGBA":
                bg = Image.new("RGB", pil.size, (255, 255, 255))
                bg.paste(pil, mask=pil.getchannel("A"))
                pil = bg

            buf = io.BytesIO()
            pil.save(buf, format="PNG", optimize=False)
            png_bytes = buf.getvalue()
            (outdir / f"page_{i+1:04d}.png").write_bytes(png_bytes)
        return n_pages
    finally:
        doc.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Convert Office/PDF to per-page PNGs.")
    ap.add_argument(
        "--input", required=True, help="Path to input file (docx/pptx/xlsx/pdf/...)."
    )
    ap.add_argument(
        "--outdir", required=True, help="Output directory for page_XXXX.png files."
    )
    ap.add_argument("--dpi", type=int, default=200, help="Render DPI (default: 200).")
    ap.add_argument(
        "--timeout-s",
        type=int,
        default=120,
        help="LibreOffice convert timeout seconds.",
    )
    args = ap.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    outdir = Path(args.outdir).expanduser().resolve()
    if not input_path.exists():
        raise SystemExit(f"input not found: {input_path}")

    tmp_pdf: Path | None = None
    try:
        if input_path.suffix.lower() == ".pdf":
            pdf_path = input_path
        else:
            tmp_pdf = office_to_pdf(input_path, timeout_s=args.timeout_s)
            pdf_path = tmp_pdf

        pages = pdf_to_png_pages(pdf_path, outdir=outdir, dpi=args.dpi)
        print(f"ok pages={pages} outdir={outdir}")
        return 0
    finally:
        if tmp_pdf is not None:
            try:
                shutil.rmtree(tmp_pdf.parent)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
