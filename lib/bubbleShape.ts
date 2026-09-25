// Ekstraksi bentuk bubble via Python sidecar (OpenCV) — dipanggil SEKALI
// per halaman agar import cv2 hanya 1x. Pola bridge ini MENIRU
// lib/bubble.ts plek-plek:
//  - tulis crop MENTAH (extract saja, tanpa upscale/grayscale) ke tmpdir,
//  - panggil `python detector/bubble_shape.py --images ...` via execFile,
//  - parse 1 baris JSON dari stdout,
//  - GAGAL APAPUN -> array null (fallback elips di overlay). Tidak pernah throw.
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import sharp from "sharp";
import type { BBox } from "./ocr";

const execFileAsync = promisify(execFile);

export interface BubblePoint {
  x: number;
  y: number;
}

export interface BubbleShape {
  /** Titik polygon dalam koordinat HALAMAN (sudah digeser +left/+top). */
  points: BubblePoint[];
  /** Bbox ketat polygon dalam koordinat halaman. */
  bbox: BBox;
  kind: string;
  conf: number;
}

export type BubbleShapeResult = BubbleShape | null;

const SCRIPT = path.join(process.cwd(), "detector", "bubble_shape.py");
let warned = false;

function warnOnce(msg: string) {
  if (!warned) {
    warned = true;
    console.warn(msg);
  }
}

function num(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// Kandidat interpreter: hormati BUBBLE_SHAPE_PYTHON, lalu BUBBLE_PYTHON,
// kalau tidak diisi coba berurutan (Windows: python -> py -> python3).
function pythonCandidates(): string[] {
  const explicit = (process.env.BUBBLE_SHAPE_PYTHON || process.env.BUBBLE_PYTHON || "").trim();
  if (explicit) return [explicit];
  return process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
}

function extractJson(stdout: string): unknown {
  const text = String(stdout || "").trim();
  const start = Math.min(
    ...["[", "{"].map((c) => {
      const i = text.indexOf(c);
      return i < 0 ? Infinity : i;
    }),
  );
  if (!isFinite(start)) throw new Error("empty stdout");
  return JSON.parse(text.slice(start));
}

async function runShapeExtractor(files: string[], timeoutMs: number): Promise<unknown> {
  const epsilon = Number(process.env.BUBBLE_SHAPE_EPSILON);
  const minArea = Number(process.env.BUBBLE_SHAPE_MIN_AREA);
  const args = [SCRIPT, "--images", ...files];
  if (Number.isFinite(epsilon) && epsilon > 0) args.push("--epsilon", String(epsilon));
  if (Number.isFinite(minArea) && minArea > 0) args.push("--min-area-ratio", String(minArea));
  let lastErr: unknown = null;
  for (const bin of pythonCandidates()) {
    try {
      const { stdout } = await execFileAsync(bin, args, {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      return extractJson(stdout);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      lastErr = e;
      if (code === "ENOENT") continue;
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const detail = String(err.stdout || err.stderr || err.message || e);
      throw new Error(detail.slice(0, 500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface RawShapeRow {
  polygon?: unknown;
  bbox?: unknown;
  shape?: unknown;
  kind?: unknown;
  conf?: unknown;
}

// Validasi 1 baris Python -> BubbleShape (koordinat halaman) atau null
// (= fallback elips). Syarat: shape=contour, >=3 titik finite, bbox >=8px.
function toShape(row: unknown, left: number, top: number, W: number, H: number): BubbleShape | null {
  try {
    const r = row as Partial<RawShapeRow>;
    if (r.shape !== "contour" || !Array.isArray(r.polygon)) return null;
    const pts: BubblePoint[] = [];
    for (const p of r.polygon as unknown[]) {
      if (!Array.isArray(p) || (p as unknown[]).length < 2) return null;
      const x = Number((p as unknown[])[0]);
      const y = Number((p as unknown[])[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      // Geser crop-lokal -> halaman, jepit ke dalam gambar.
      pts.push({
        x: Math.max(0, Math.min(W, left + x)),
        y: Math.max(0, Math.min(H, top + y)),
      });
    }
    if (pts.length < 3 || pts.length > 512) return null;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const bbox: BBox = {
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys),
    };
    if (bbox.x1 - bbox.x0 < 8 || bbox.y1 - bbox.y0 < 8) return null;
    return {
      points: pts,
      bbox,
      kind: typeof r.kind === "string" ? r.kind : "unknown",
      conf: Number(r.conf) || 0,
    };
  } catch {
    return null;
  }
}

// regions: bbox area bubble (biasanya bbox pad dari cropBubble) dalam
// koordinat gambar `pageBuffer`. Return sejajar dengan input (null = elips).
export async function extractBubbleShapes(
  pageBuffer: Buffer,
  regions: BBox[],
): Promise<BubbleShapeResult[]> {
  const none: BubbleShapeResult[] = regions.map(() => null);
  if (!regions.length || !fs.existsSync(SCRIPT)) return none;
  // Fail-fast via env (debug): BUBBLE_SHAPE=0 mematikan ekstraksi.
  if (["0", "false", "off", "no"].includes((process.env.BUBBLE_SHAPE || "1").toLowerCase())) {
    return none;
  }

  const timeoutMs = num("BUBBLE_SHAPE_TIMEOUT_MS", 120000);
  const pad = 8; // sama seperti cropBubble agar kontur dapat outline utuh
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-shapes-"));
  try {
    const meta = await sharp(pageBuffer).metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    if (!W || !H) return none;

    const files: string[] = [];
    const origins: Array<{ left: number; top: number }> = [];
    for (let i = 0; i < regions.length; i++) {
      const b = regions[i];
      const left = Math.max(0, Math.floor(b.x0 - pad));
      const top = Math.max(0, Math.floor(b.y0 - pad));
      const right = Math.min(W, Math.ceil(b.x1 + pad));
      const bottom = Math.min(H, Math.ceil(b.y1 + pad));
      const w = right - left;
      const h = bottom - top;
      if (w < 16 || h < 16) {
        files.push("");
        origins.push({ left, top });
        continue;
      }
      // Crop MENTAH (tanpa upscale/grayscale) agar outline asli terjaga.
      const buf = await sharp(pageBuffer)
        .extract({ left, top, width: w, height: h })
        .png()
        .toBuffer();
      const f = path.join(dir, `s${i}.png`);
      fs.writeFileSync(f, buf);
      files.push(f);
      origins.push({ left, top });
    }

    const validIdx = files.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
    if (!validIdx.length) return none;
    const parsed = await runShapeExtractor(
      validIdx.map((i) => files[i]),
      timeoutMs,
    );
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in (parsed as Record<string, unknown>)
    ) {
      const p = parsed as Record<string, unknown>;
      warnOnce(`[shape] nonaktif (${String(p.error)}). ${String(p.hint || "")}`);
      return none;
    }
    if (!Array.isArray(parsed) || parsed.length !== validIdx.length) {
      warnOnce("[shape] output python tidak sesuai, pakai elips.");
      return none;
    }
    const out: BubbleShapeResult[] = regions.map(() => null);
    parsed.forEach((row, k) => {
      const i = validIdx[k];
      out[i] = toShape(row, origins[i].left, origins[i].top, W, H);
    });
    return out;
  } catch (e) {
    warnOnce(
      `[shape] gagal, pakai elips. (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`,
    );
    return none;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
