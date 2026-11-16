// Ekstraksi bentuk bubble via Python sidecar (OpenCV) — dipanggil SEKALI
// per halaman agar import cv2 hanya 1x. Pola bridge ini MENIRU
// lib/bubble.ts plek-plek:
//  - tulis crop MENTAH (extract saja, tanpa upscale/grayscale) ke tmpdir,
//  - panggil `python detector/bubble_shape.py --images ...` via execFile,
//  - parse 1 baris JSON dari stdout,
//  - GAGAL APAPUN -> array null (overlay memilih fallback per sumber). Tidak pernah throw.
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
  const local = path.join(
    process.cwd(), "detector", ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const system = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
  return fs.existsSync(local) ? [local, ...system] : system;
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

async function runShapeExtractor(
  files: string[],
  seeds: Array<{ x: number; y: number }>,
  edges: string[],
  source: "yolo" | "google",
  timeoutMs: number,
): Promise<unknown> {
  const epsilon = Number(process.env.BUBBLE_SHAPE_EPSILON);
  const minArea = Number(process.env.BUBBLE_SHAPE_MIN_AREA);
  const args = [SCRIPT, "--images", ...files];
  args.push("--seeds", ...seeds.map((s) => `${s.x},${s.y}`));
  args.push("--edges", ...edges);
  if (Number.isFinite(epsilon) && epsilon > 0) args.push("--epsilon", String(epsilon));
  if (Number.isFinite(minArea) && minArea > 0) args.push("--min-area-ratio", String(minArea));
  else if (source === "google") args.push("--min-area-ratio", "0.08");
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

// Validasi 1 baris Python -> BubbleShape (koordinat halaman) atau null.
// Syarat: shape=contour, >=3 titik finite, bbox >=8px.
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

function polygonArea(points: BubblePoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return Math.abs(sum) / 2;
}

// Kontur kadang justru mengikuti baris teks (bukan outline bubble), misalnya
// pada bubble yang terpotong tepi halaman. Kontur seperti itu kecil/berongga:
// kalau span atau luasnya jauh di bawah region, lebih aman fallback ke
// kotak/elips daripada menimpa hanya sebagian teks.
function coversRegion(shape: BubbleShape, region: BBox): boolean {
  const rw = Math.max(1, region.x1 - region.x0);
  const rh = Math.max(1, region.y1 - region.y0);
  const sw = shape.bbox.x1 - shape.bbox.x0;
  const sh = shape.bbox.y1 - shape.bbox.y0;
  if (sw < rw * 0.55 || sh < rh * 0.55) return false;
  return polygonArea(shape.points) >= rw * rh * 0.4;
}

// regions: bbox area bubble (YOLO) atau teks (Google) dalam koordinat
// gambar `pageBuffer`. Return sejajar dengan input (null = fallback).
export async function extractBubbleShapes(
  pageBuffer: Buffer,
  regions: BBox[],
  source: "yolo" | "google" = "yolo",
): Promise<BubbleShapeResult[]> {
  const none: BubbleShapeResult[] = regions.map(() => null);
  if (!regions.length || !fs.existsSync(SCRIPT)) return none;
  // Fail-fast via env (debug): BUBBLE_SHAPE=0 mematikan ekstraksi.
  if (["0", "false", "off", "no"].includes((process.env.BUBBLE_SHAPE || "1").toLowerCase())) {
    return none;
  }

  const timeoutMs = num("BUBBLE_SHAPE_TIMEOUT_MS", 120000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-shapes-"));
  try {
    const meta = await sharp(pageBuffer).metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    if (!W || !H) return none;

    const files: string[] = [];
    const origins: Array<{ left: number; top: number }> = [];
    const seeds: Array<{ x: number; y: number }> = [];
    // Sisi crop yang berimpit dengan tepi gambar asli: kontur boleh
    // menyentuhnya (bubble terpotong tepi halaman).
    const edges: string[] = [];
    for (let i = 0; i < regions.length; i++) {
      const b = regions[i];
      // Google memberi kotak TEKS, bukan kotak bubble. Perlu ruang jauh
      // lebih besar agar outline bubble tidak terpotong oleh crop.
      const span = Math.max(b.x1 - b.x0, b.y1 - b.y0);
      const pad = source === "google"
        ? Math.min(120, Math.max(16, Math.round(span * 0.45)))
        : Math.min(80, Math.max(24, Math.round(span * 0.25)));
      const left = Math.max(0, Math.floor(b.x0 - pad));
      const top = Math.max(0, Math.floor(b.y0 - pad));
      const right = Math.min(W, Math.ceil(b.x1 + pad));
      const bottom = Math.min(H, Math.ceil(b.y1 + pad));
      const w = right - left;
      const h = bottom - top;
      if (w < 16 || h < 16) {
        files.push("");
        origins.push({ left, top });
        seeds.push({ x: 0, y: 0 });
        edges.push("0000");
        continue;
      }
      edges.push(
        `${left <= 0 ? 1 : 0}${top <= 0 ? 1 : 0}${right >= W ? 1 : 0}${bottom >= H ? 1 : 0}`,
      );
      // Crop MENTAH (tanpa upscale/grayscale) agar outline asli terjaga.
      const buf = await sharp(pageBuffer)
        .extract({ left, top, width: w, height: h })
        .png()
        .toBuffer();
      const f = path.join(dir, `s${i}.png`);
      fs.writeFileSync(f, buf);
      files.push(f);
      origins.push({ left, top });
      seeds.push({ x: (b.x0 + b.x1) / 2 - left, y: (b.y0 + b.y1) / 2 - top });
    }

    const validIdx = files.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
    if (!validIdx.length) return none;
    const parsed = await runShapeExtractor(
      validIdx.map((i) => files[i]),
      validIdx.map((i) => seeds[i]),
      validIdx.map((i) => edges[i]),
      source,
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
      const shape = toShape(row, origins[i].left, origins[i].top, W, H);
      out[i] = shape && coversRegion(shape, regions[i]) ? shape : null;
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
