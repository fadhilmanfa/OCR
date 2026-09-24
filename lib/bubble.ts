// Deteksi speech bubble via Python sidecar (YOLOv8 ogkalu) — dipanggil
// SEKALI per job agar load model PyTorch hanya 1x. Semua kegagalan
// (Python tidak ada, model belum di-download, timeout) mengembalikan
// array kosong supaya route fallback ke OCR full-page. Tidak pernah throw.
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import sharp from "sharp";
import type { BBox } from "./ocr";

const execFileAsync = promisify(execFile);

export interface BubbleBox extends BBox {
  conf: number;
}

const SCRIPT = path.join(process.cwd(), "detector", "detect.py");
let warned = false;

// Registry model YOLO bubble. conf/imgsz = default tiap model
// (card psimera pakai conf 0.25), masih bisa dioverride via
// env BUBBLE_CONF / BUBBLE_IMGSZ.
const MODELS = {
  ogkalu: {
    file: "comic-speech-bubble-detector.pt",
    conf: 0.3,
    imgsz: 1024,
    desc: "komik barat + manga + webtoon",
  },
  psimera: {
    file: "bubbles_detect.pt",
    conf: 0.25,
    imgsz: 1024,
    desc: "manga (mAP50 0.977)",
  },
} as const;

export type BubbleModelId = keyof typeof MODELS;
export const DEFAULT_MODEL: BubbleModelId = "ogkalu";

export interface ResolvedModel extends Record<string, string | number> {
  id: BubbleModelId;
  path: string;
  conf: number;
  imgsz: number;
}

// "1"/kosong = default (env BUBBLE_MODEL atau ogkalu). "0" ditangani
// bubbleEnabled, tidak sampai sini.
export function resolveBubbleModel(requested?: string): ResolvedModel {
  let id: BubbleModelId = DEFAULT_MODEL;
  const cand = (requested || process.env.BUBBLE_MODEL || "").toLowerCase();
  if (cand === "psimera" || cand === "ogkalu") id = cand;
  const m = MODELS[id];
  const envConf = Number(process.env.BUBBLE_CONF);
  const envImgsz = Number(process.env.BUBBLE_IMGSZ);
  return {
    id,
    path: path.join(process.cwd(), "detector", "models", m.file),
    conf: Number.isFinite(envConf) && envConf > 0 ? envConf : m.conf,
    imgsz: Number.isFinite(envImgsz) && envImgsz > 0 ? envImgsz : m.imgsz,
  };
}

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

export function bubbleEnabled(requested = true): boolean {
  const env = (process.env.BUBBLE_ENABLED || "").toLowerCase();
  if (["0", "false", "off", "no"].includes(env)) return false;
  return requested;
}

// Kandidat interpreter: hormati BUBBLE_PYTHON, kalau tidak diisi coba
// berurutan (Windows sering hanya punya `py` launcher atau Store `python`).
function pythonCandidates(): string[] {
  const explicit = (process.env.BUBBLE_PYTHON || "").trim();
  if (explicit) return [explicit];
  return process.platform === "win32"
    ? ["python", "py", "python3"]
    : ["python3", "python"];
}

interface RawBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  conf: number;
}

function sanitize(
  boxes: unknown,
  W: number,
  H: number,
  max: number,
  minSide: number,
): BubbleBox[] {
  if (!Array.isArray(boxes) || !W || !H) return [];
  const out: BubbleBox[] = [];
  for (const b of boxes) {
    const r = b as Partial<RawBox>;
    const nums = [r.x0, r.y0, r.x1, r.y1].map(Number);
    if (!nums.every(Number.isFinite)) continue;
    const x0 = Math.max(0, Math.min(W, Math.floor(nums[0])));
    const y0 = Math.max(0, Math.min(H, Math.floor(nums[1])));
    const x1 = Math.max(0, Math.min(W, Math.ceil(nums[2])));
    const y1 = Math.max(0, Math.min(H, Math.ceil(nums[3])));
    if (x1 - x0 < minSide || y1 - y0 < minSide) continue;
    out.push({ x0, y0, x1, y1, conf: Number(r.conf) || 0 });
  }
  // Utamakan confidence tertinggi kalau harus memangkas.
  out.sort((a, b) => b.conf - a.conf);
  return out.slice(0, max);
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

async function runDetector(
  files: string[],
  model: ResolvedModel,
  timeoutMs: number,
): Promise<unknown> {
  const args = [
    SCRIPT,
    "--images",
    ...files,
    "--model",
    model.path,
    "--conf",
    String(model.conf),
    "--imgsz",
    String(model.imgsz),
  ];
  let lastErr: unknown = null;
  for (const bin of pythonCandidates()) {
    try {
      const { stdout } = await execFileAsync(bin, args, {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      return extractJson(stdout);
    } catch (e: unknown) {
      // Interpreter tidak ada -> coba kandidat berikut. Selain itu
      // (exit != 0 / timeout) langsung kembalikan error terakhir.
      const code = (e as NodeJS.ErrnoException)?.code;
      lastErr = e;
      if (code === "ENOENT") continue;
      // Sertakan stderr/pesan python kalau ada (mis. model_not_found).
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const detail = String(err.stdout || err.stderr || err.message || e);
      throw new Error(detail.slice(0, 500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// buffers: gambar yang SUDAH dinormalisasi (koordinat hasil = koordinat ini).
// return: daftar bubble per gambar + id model yg dipakai.
// [] per gambar = tidak ada / fitur mati / gagal (fallback OCR full-page).
export async function detectBubbles(
  buffers: Buffer[],
  requestedModel?: string,
): Promise<{ lists: BubbleBox[][]; model: BubbleModelId }> {
  const model = resolveBubbleModel(requestedModel);
  const none = { lists: buffers.map(() => [] as BubbleBox[]), model: model.id };
  if (!buffers.length || !fs.existsSync(SCRIPT)) return none;

  const timeoutMs = num("BUBBLE_TIMEOUT_MS", 300000);
  const max = Math.floor(num("BUBBLE_MAX", 40));
  const minSide = Math.floor(num("BUBBLE_MIN_SIDE", 24));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-bubbles-"));
  try {
    const files: string[] = [];
    const sizes: Array<{ w: number; h: number }> = [];
    for (let i = 0; i < buffers.length; i++) {
      const meta = await sharp(buffers[i]).metadata();
      sizes.push({ w: meta.width || 0, h: meta.height || 0 });
      const f = path.join(dir, `p${i}.png`);
      fs.writeFileSync(f, buffers[i]);
      files.push(f);
    }

    const parsed = await runDetector(files, model, timeoutMs);
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in (parsed as Record<string, unknown>)
    ) {
      const p = parsed as Record<string, unknown>;
      warnOnce(
        `[bubble] nonaktif (${String(p.error)}). ${String(p.hint || "Lihat detector/README atau README bagian Bubble YOLO.")}`,
      );
      return none;
    }
    if (!Array.isArray(parsed) || parsed.length !== buffers.length) {
      warnOnce("[bubble] output python tidak sesuai, pakai OCR penuh.");
      return none;
    }
    return {
      lists: parsed.map((row, i) =>
        sanitize(
          (row as { boxes?: unknown })?.boxes,
          sizes[i].w,
          sizes[i].h,
          max,
          minSide,
        ),
      ),
      model: model.id,
    };
  } catch (e) {
    warnOnce(
      `[bubble] gagal, pakai OCR penuh. (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`,
    );
    return none;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface BubbleCrop {
  buffer: Buffer;
  bbox: BBox; // bbox (dengan pad) dalam koordinat gambar asli
}

const BOX_COLORS = ["#ff0000", "#00c853", "#2962ff", "#ffab00", "#d500f9", "#00b8d4"];

// Gambar kotak bubble (nomor + confidence) di atas kopian gambar.
// Dipakai untuk preview "Asli" supaya terlihat apa yang terdeteksi;
// gambar hasil ID tidak disentuh (tetap bersih).
export async function drawBubbleBoxes(
  image: Buffer,
  boxes: BubbleBox[],
): Promise<Buffer> {
  if (!boxes.length) return image;
  const { width = 0, height = 0 } = await sharp(image).metadata();
  const shapes = boxes
    .map((b, i) => {
      const c = BOX_COLORS[i % BOX_COLORS.length];
      const lx = b.x0 + 4;
      const ly = Math.max(14, b.y0 - 8);
      return (
        `<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="none" stroke="${c}" stroke-width="4"/>` +
        `<text x="${lx}" y="${ly}" font-family="Arial" font-size="28" font-weight="bold" fill="${c}" stroke="black" stroke-width="1">${i}:${b.conf.toFixed(2)}</text>`
      );
    })
    .join("");
  return sharp(image)
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`,
        ),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
}

// Crop bubble + pad, upscale 2x, grayscale+normalize agar OCR akurat.
export async function cropBubble(
  image: Buffer,
  box: BBox,
  W: number,
  H: number,
): Promise<BubbleCrop | null> {
  const pad = 8;
  const left = Math.max(0, Math.floor(box.x0 - pad));
  const top = Math.max(0, Math.floor(box.y0 - pad));
  const right = Math.min(W, Math.ceil(box.x1 + pad));
  const bottom = Math.min(H, Math.ceil(box.y1 + pad));
  const w = right - left;
  const h = bottom - top;
  if (w < 16 || h < 16) return null;
  const buffer = await sharp(image)
    .extract({ left, top, width: w, height: h })
    .resize({ width: w * 2 })
    .grayscale()
    .normalize()
    .png()
    .toBuffer();
  return { buffer, bbox: { x0: left, y0: top, x1: right, y1: bottom } };
}
