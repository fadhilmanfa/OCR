// Engine OCR alternatif "comics_text_plus" (FCENet deteksi + MASTER
// rekognisi, via library Python comics-ocr) — dipanggil SEKALI per job
// agar load model PyTorch hanya 1x.
//
// Pola bridge ini MENIRU lib/bubble.ts plek-plek:
//  - panggil `python detector/ocr_comics.py --images ... --conf ...`
//    via execFile (bukan shell, aman dari spasi di path),
//  - parse 1 baris JSON dari stdout,
//  - GAGAL APAPUN (python tidak ada, library/checkpoint belum install,
//    timeout, JSON aneh) -> return [] per gambar, TIDAK PERNAH throw,
//    supaya route bisa fallback ke Tesseract.
//
// Output fungsi ini = OcrBox[] per gambar (tipe yang SAMA PERSIS dengan
// hasil ocrEnglish() di lib/ocr.ts), jadi interchangeable:
//   - translateBatch() hanya butuh array string  -> boxes.map(b => b.text)
//   - overlayTranslations() hanya butuh {text, bbox} -> langsung cocok
// Bentuk PageBox {en, id, bbox} (components/types.ts) BARU terbentuk
// di route SETELAH translate: { en: b.text, id: idTexts[k], bbox: b.bbox }.
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import sharp from "sharp";
import type { BBox, OcrBox } from "./ocr";

const execFileAsync = promisify(execFile);

// ID engine yang dikirim dari UI (UploadForm) / query param (?ocrEngine=).
// "tesseract" = default, kode lama, tidak diubah sama sekali.
// "vision_llm" = Vision LLM via OpenRouter (lihat lib/ocrVisionLLM.ts).
// "google_vision" = Google Cloud Vision API (lihat lib/ocrGoogleVision.ts).
export type OcrEngine = "tesseract" | "comics_text_plus" | "vision_llm" | "google_vision";
export const DEFAULT_OCR_ENGINE: OcrEngine = "tesseract";

// Normalisasi input user/env jadi salah satu ID valid. Nilai asing
// (termasuk undefined/kosong) -> default "tesseract" (tidak breaking).
export function resolveOcrEngine(requested?: string): OcrEngine {
  const cand = (requested || process.env.OCR_ENGINE || "")
    .toLowerCase()
    .trim();
  if (cand === "comics_text_plus") return "comics_text_plus";
  if (cand === "vision_llm") return "vision_llm";
  if (cand === "google_vision") return "google_vision";
  return "tesseract";
}

const SCRIPT = path.join(process.cwd(), "detector", "ocr_comics.py");
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

// Kandidat interpreter: hormati COMICS_PYTHON dulu, lalu BUBBLE_PYTHON
// (biar bisa 1 venv yang sama), kalau tidak diisi coba berurutan
// (Windows sering hanya punya `py` launcher atau Store `python`).
function pythonCandidates(): string[] {
  const explicit = (
    process.env.COMICS_PYTHON ||
    process.env.BUBBLE_PYTHON ||
    ""
  ).trim();
  if (explicit) return [explicit];
  return process.platform === "win32"
    ? ["python", "py", "python3"]
    : ["python3", "python"];
}

// Bentuk mentah 1 box dari Python: {"text","bbox":[x,y,w,h],"confidence"}.
interface RawComicsBox {
  text?: unknown;
  bbox?: unknown;
  confidence?: unknown;
}

// Ubah bbox [x,y,w,h] (Python) -> {x0,y0,x1,y1} (proyek ini), sekaligus
// buang box sampah: teks kosong, ukuran 0/negatif, di luar gambar.
function sanitize(
  boxes: unknown,
  W: number,
  H: number,
  max: number,
  minSide: number,
): OcrBox[] {
  if (!Array.isArray(boxes) || !W || !H) return [];
  const out: OcrBox[] = [];
  for (const b of boxes) {
    const r = b as Partial<RawComicsBox>;
    const text = String(r.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const bb = r.bbox;
    if (!Array.isArray(bb) || bb.length < 4) continue;
    const nums = (bb as unknown[]).slice(0, 4).map(Number);
    if (!nums.every(Number.isFinite)) continue;
    const [x, y, w, h] = nums;
    if (w < minSide || h < minSide) continue;
    // Jepit ke dalam gambar (hasil FCENet kadang 1-2px keluar).
    const x0 = Math.max(0, Math.min(W, Math.floor(x)));
    const y0 = Math.max(0, Math.min(H, Math.floor(y)));
    const x1 = Math.max(0, Math.min(W, Math.ceil(x + w)));
    const y1 = Math.max(0, Math.min(H, Math.ceil(y + h)));
    if (x1 - x0 < minSide || y1 - y0 < minSide) continue;
    out.push({ text, conf: Number(r.confidence) || 0, bbox: { x0, y0, x1, y1 } });
  }
  // Urutan baca SAMA seperti ocrEnglish: atas->bawah, kanan->kiri.
  out.sort((a, b) => a.bbox.y0 - b.bbox.y0 || b.bbox.x0 - a.bbox.x0);
  return out.slice(0, max);
}

// Gabung bbox (union) — dipakai saat menjahit baris.
function unionBox(a: BBox, b: BBox): BBox {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

// Apakah box b adalah LANJUTAN baris dari box a? (Heuristik yang sama
// semangatnya dengan sameTextRegion() di lib/ocr.ts: tepat di bawah,
// jarak vertikal wajar, dan overlap horizontal cukup.)
function isNextLine(a: BBox, b: BBox): boolean {
  const gap = b.y0 - a.y1;
  const minH = Math.min(a.y1 - a.y0, b.y1 - b.y0);
  if (minH <= 0) return false;
  if (gap < -minH * 0.4) return false; // tumpuk vertikal = kolom lain
  if (gap > Math.max(12, minH * 1.2)) return false; // jauh = bubble lain
  const minW = Math.min(a.x1 - a.x0, b.x1 - b.x0);
  const xOverlap = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  return xOverlap >= minW * 0.35;
}

// Jahit box per-baris FCENet jadi per-bubble/paragraf: teks digabung
// dengan SPASI (MASTER tidak mengenal karakter spasi, jadi tanpa ini
// satu bubble pecah jadi "enter-enter" tanpa pemisah). conf = nilai
// terkecil, bbox = gabungan. Baris terpisah jauh tetap box sendiri.
// Diekspor supaya bisa di-unit-test.
export function stitchLines(boxes: OcrBox[]): OcrBox[] {
  const sorted = [...boxes].sort(
    (a, b) => a.bbox.y0 - b.bbox.y0 || b.bbox.x0 - a.bbox.x0,
  );
  const out: OcrBox[] = [];
  for (const item of sorted) {
    const target = out.find((entry) => isNextLine(entry.bbox, item.bbox));
    if (target) {
      // Kata terpotong tanda hubung ("SHO-" + "P") -> sambung langsung.
      target.text = target.text.endsWith("-")
        ? target.text + item.text
        : target.text + " " + item.text;
      target.conf = Math.min(target.conf, item.conf);
      target.bbox = unionBox(target.bbox, item.bbox);
    } else {
      out.push({ ...item, bbox: { ...item.bbox } });
    }
  }
  return out;
}

// Ambil JSON dari stdout yang mungkin kecampur log berisik library
// (mmocr suka print INFO). Cari kurung buka pertama lalu JSON.parse.
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

async function runComicsOcr(
  files: string[],
  conf: number,
  timeoutMs: number,
): Promise<unknown> {
  const args = [SCRIPT, "--images", ...files, "--conf", String(conf)];
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
      if (code === "ENOENT") continue; // interpreter tidak ada -> coba berikut
      const err = e as { stdout?: string; stderr?: string; message?: string };
      // Script kita SELALU cetak {"error":...} ke stdout walau exit != 0,
      // jadi coba parse dulu: kalau dapat error JSON, kembalikan baik-baik
      // (bukan throw) supaya pemanggil bisa log hint-nya dengan rapi.
      const raw = String(err.stdout || "");
      try {
        const parsed = extractJson(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          "error" in (parsed as Record<string, unknown>)
        )
          return parsed;
      } catch {
        // stdout bukan JSON -> lanjut ke pesan error biasa
      }
      const detail = String(err.stdout || err.stderr || err.message || e);
      throw new Error(detail.slice(0, 500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// buffers: gambar yang SUDAH dinormalisasi (koordinat hasil = koordinat ini).
// return: daftar OcrBox per gambar (boleh [] = tidak terbaca / fitur gagal).
// Overload string[] didukung biar signature cocok dengan CLI Python
// (--images = list path): kalau input string, file langsung dipakai.
export async function ocrComicsPlus(buffers: Buffer[]): Promise<OcrBox[][]>;
export async function ocrComicsPlus(
  imagePaths: string[],
): Promise<OcrBox[][]>;
export async function ocrComicsPlus(
  inputs: Buffer[] | string[],
): Promise<OcrBox[][]> {
  const none: OcrBox[][] = inputs.map(() => []);
  if (!inputs.length || !fs.existsSync(SCRIPT)) {
    if (inputs.length && !fs.existsSync(SCRIPT))
      warnOnce("[comics-ocr] detector/ocr_comics.py tidak ada.");
    return none;
  }

  const timeoutMs = num("COMICS_TIMEOUT_MS", 300000); // load model CPU lama
  const max = Math.floor(num("COMICS_MAX", 200)); // OCR bisa banyak baris
  const minSide = Math.floor(num("COMICS_MIN_SIDE", 8));
  const conf = Number(process.env.COMICS_CONF);
  const confArg = Number.isFinite(conf) && conf >= 0 ? conf : 0.3;

  const fromFiles = typeof inputs[0] === "string";
  const dir = fromFiles
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), "ocr-comics-"));
  try {
    const files: string[] = [];
    const sizes: Array<{ w: number; h: number }> = [];
    if (fromFiles) {
      for (const f of inputs as string[]) {
        const meta = await sharp(f).metadata();
        sizes.push({ w: meta.width || 0, h: meta.height || 0 });
        files.push(f);
      }
    } else {
      for (let i = 0; i < (inputs as Buffer[]).length; i++) {
        const buf = (inputs as Buffer[])[i];
        const meta = await sharp(buf).metadata();
        sizes.push({ w: meta.width || 0, h: meta.height || 0 });
        const f = path.join(dir as string, `p${i}.png`);
        fs.writeFileSync(f, buf);
        files.push(f);
      }
    }

    const parsed = await runComicsOcr(files, confArg, timeoutMs);
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in (parsed as Record<string, unknown>)
    ) {
      const p = parsed as Record<string, unknown>;
      warnOnce(
        `[comics-ocr] nonaktif (${String(p.error)}). ${String(p.hint || "pip install -r detector/requirements.txt + taruh checkpoint di detector/models/comics_text_plus/")}`,
      );
      return none;
    }
    if (!Array.isArray(parsed) || parsed.length !== inputs.length) {
      warnOnce("[comics-ocr] output python tidak sesuai, hasil dikosongkan.");
      return none;
    }
    // Jahit baris jadi bubble (bisa dimatikan via COMICS_STITCH=0 untuk
    // debugging — lihat hasil mentah per baris FCENet).
    const stitch = process.env.COMICS_STITCH !== "0";
    return parsed.map((row, i) => {
      const boxes = sanitize(
        (row as { boxes?: unknown })?.boxes,
        sizes[i].w,
        sizes[i].h,
        max,
        minSide,
      );
      return stitch ? stitchLines(boxes) : boxes;
    });
  } catch (e) {
    warnOnce(
      `[comics-ocr] gagal, hasil dikosongkan. (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`,
    );
    return none;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Re-export tipe BBox supaya konsumen cukup import dari sini kalau mau.
export type { BBox };
