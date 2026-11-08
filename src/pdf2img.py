"""Render PDF pages to PNG images for OCR."""
import sys
import os
import pymupdf

def main():
    if len(sys.argv) != 3:
        print("usage: pdf2img.py <pdf> <outdir>", file=sys.stderr)
        sys.exit(2)
    pdf_path, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    doc = pymupdf.open(pdf_path)
    paths = []
    for i, page in enumerate(doc):
        # zoom for OCR legibility
        pix = page.get_pixmap(matrix=pymupdf.Matrix(2.2, 2.2))
        out = os.path.join(outdir, f"page-{i + 1:03d}.png")
        pix.save(out)
        paths.append(out)
    doc.close()
    print("\n".join(paths))

if __name__ == "__main__":
    main()
