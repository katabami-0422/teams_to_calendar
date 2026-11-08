import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import os from 'node:os';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const OCR_PS1 = path.join(SRC, 'ocr.ps1');
const PDF2IMG_PY = path.join(SRC, 'pdf2img.py');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err || out}`));
    });
  });
}

async function ocrImageFile(imagePath) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ocr-'));
  const outFile = path.join(tmp, 'text.txt');
  try {
    await run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', OCR_PS1,
      '-Path', imagePath,
      '-OutFile', outFile,
    ]);
    return await readFile(outFile, 'utf8');
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function ocrImage(imagePath) {
  const text = await ocrImageFile(imagePath);
  return text.trim();
}

export async function ocrPdf(pdfPath) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ocrpdf-'));
  try {
    const imgDir = path.join(tmp, 'pages');
    const list = await run('python', [PDF2IMG_PY, pdfPath, imgDir]);
    const pages = list.split('\n').map((s) => s.trim()).filter(Boolean);
    const texts = [];
    for (const p of pages) {
      texts.push(await ocrImageFile(p));
    }
    return texts.join('\n').trim();
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function ocrFile(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.pdf')) return ocrPdf(filePath);
  return ocrImage(filePath);
}

// 埋め込みテキスト層。フォント由来のモジバケでも ASCII の日付は残るため、日付抽出のヒントに使う。
export async function pdfEmbeddedText(pdfPath) {
  try {
    return await run('python', [
      '-c',
      'import pymupdf,sys; d=pymupdf.open(sys.argv[1]); print("\\n".join(p.get_text() for p in d))',
      pdfPath,
    ]);
  } catch {
    return '';
  }
}
