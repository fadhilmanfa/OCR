// Engine OCR "google_vision": Google Cloud Vision API via REST + API key
// (TANPA SDK @google-cloud/vision — cukup fetch, sama seperti provider
// lain di repo ini yang juga tanpa SDK).
//
// Dua jalur, dipilih otomatis seperti tesseract:
//   - ocrGoogleBubbleCrops() : TEXT_DETECTION per crop bubble YOLO.
//     Signature & output SAMA PERSIS dengan ocrBubbleCrops() (lib/ocr.ts)
//     dan ocrVisionBubbleCrops() (lib/ocrVisionLLM.ts):
//       input  : Buffer[]  (daftar crop bubble)
//       output : Array<{ text: string; conf: number } | null>
//   - ocrGoogleFullPage()    : DOCUMENT_TEXT_DETECTION per halaman penuh.
//     Output = OcrBox[] (tipe SAMA seperti ocrEnglish() di lib/ocr.ts).
//
// Kontrak kegagalan (sesuai keputusan user: BUKAN fallback diam-diam):
//   - API error (key kosong/salah, API belum aktif, kuota habis,
//     rate-limit, network/timeout) -> THROW dengan pesan Bahasa Indonesia
//     yang actionable. Route menangkapnya -> job gagal eksplisit.
//   - Crop/halaman yang tidak terbaca (response valid tapi teks kosong)
//     -> null / dilewati (BUKAN error), overlay tetap jalan.
//
// Kuota: images:annotate menerima batch ≤16 gambar per request, jadi crop
// digabung per-chunk (hemat request; unit kuota tetap dihitung per gambar
// oleh Google — cek harga aktif di Cloud Console).
import sharp from "sharp";
import type { BBox, OcrBox } from "./ocr";

const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";

// Maks gambar per 1 request batch (batas API). 1 halaman komik bisa
// 20-40 bubble -> dipecah jadi beberapa chunk berurutan.
const BATCH = 16;

// Confidence minimum paragraf full-page (0..1, skala Google).
// Sejajar semangat MIN_CONFIDENCE di lib/ocr.ts (55/100).
const MIN_PARA_CONF = 0.5;

export function googleVisionConfig(apiKey?: string): { apiKey: string } {
  return {
    apiKey: apiKey?.trim() || process.env.GOOGLE_VISION_API_KEY?.trim() || "",
  };
}

function requireKey(requestApiKey?: string): string {
  const { apiKey } = googleVisionConfig(requestApiKey);
  if (!apiKey) {
    throw new Error(
      "API key Google Vision belum diisi. Masukkan di UI atau atur GOOGLE_VISION_API_KEY di .env.",
    );
  }
  return apiKey;
}

function visionTimeoutMs(): number {
  const v = Number(process.env.GOOGLE_VISION_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 60000;
}

// ---------------------------------------------------------------------------
// Tipe longgar untuk response JSON Vision API (hanya field yang dipakai).
// ---------------------------------------------------------------------------
interface VisionVertex {
  x?: number;
  y?: number;
}

interface VisionBoundingPoly {
  vertices?: VisionVertex[];
  normalizedVertices?: VisionVertex[];
}

interface VisionSymbol {
  text?: string;
}

interface VisionWord {
  symbols?: VisionSymbol[];
  confidence?: number;
}

interface VisionParagraph {
  words?: VisionWord[];
  confidence?: number;
  boundingBox?: VisionBoundingPoly;
}

interface VisionBlock {
  paragraphs?: VisionParagraph[];
  confidence?: number;
  boundingBox?: VisionBoundingPoly;
}

interface VisionPage {
  blocks?: VisionBlock[];
  confidence?: number;
}

interface VisionTextAnnotation {
  description?: string;
}

interface VisionSingleResponse {
  textAnnotations?: VisionTextAnnotation[];
  fullTextAnnotation?: { text?: string; pages?: VisionPage[] };
  error?: { code?: number; message?: string };
}

interface VisionAnnotateResponse {
  responses?: VisionSingleResponse[];
}

// ---------------------------------------------------------------------------
// Error mapping: kode HTTP / error per-gambar -> pesan ID yang actionable.
// Selalu throw (kontrak no-fallback engine ini).
// ---------------------------------------------------------------------------
function throwHttpError(status: number, body: string): never {
  const detail = String(body || "").slice(0, 300);
  if (status === 400) {
    throw new Error(
      "google vision 400: request ditolak (biasanya API key salah/tidak valid). Cek key di UI atau GOOGLE_VISION_API_KEY di .env.",
    );
  }
  if (status === 401 || status === 403) {
    throw new Error(
      `google vision ${status}: akses ditolak (key salah, Vision API belum diaktifkan di Cloud Console, atau kuota habis). Detail: ${detail}`,
    );
  }
  if (status === 429) {
    throw new Error("google vision 429: rate-limit. Tunggu sebentar lalu coba lagi.");
  }
  throw new Error(`google vision ${status} ${detail}`);
}

function throwImageError(index: number, code: number | undefined, message: string): never {
  throw new Error(
    `google vision: gambar ke-${index + 1} ditolak API (${code ?? "?"} ${message.slice(0, 200)}).`,
  );
}

// ---------------------------------------------------------------------------
// Satu request images:annotate untuk 1..BATCH gambar. Return array
// VisionSingleResponse sejajar urutan input. API error -> throw.
// ---------------------------------------------------------------------------
async function annotate(
  imagesBase64: string[],
  featureType: "TEXT_DETECTION" | "DOCUMENT_TEXT_DETECTION",
  apiKey: string,
): Promise<VisionSingleResponse[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), visionTimeoutMs());
  try {
    let res: Response;
    try {
      res = await fetch(`${VISION_URL}?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          requests: imagesBase64.map((content) => ({
            image: { content },
            features: [{ type: featureType }],
          })),
        }),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(
          `google vision timeout setelah ${visionTimeoutMs()}ms (cek koneksi / kecilkan batch).`,
        );
      }
      throw new Error(
        `google vision tidak terjangkau (cek internet). (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throwHttpError(res.status, t);
    }
    const data = (await res.json()) as VisionAnnotateResponse;
    const responses = data?.responses;
    if (!Array.isArray(responses) || responses.length !== imagesBase64.length) {
      throw new Error("google vision: respons API tidak sesuai (jumlah hasil beda).");
    }
    responses.forEach((r, i) => {
      if (r?.error) throwImageError(i, r.error.code, String(r.error.message || ""));
    });
    return responses;
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(text: string | undefined | null): string {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

// Rata-rata confidence blok (0..1) sebagai conf crop (0..100).
// Kosong/tak ada info -> 90 (teks terbaca = cukup yakin).
function cropConfidence(resp: VisionSingleResponse): number {
  const confs: number[] = [];
  for (const page of resp?.fullTextAnnotation?.pages || []) {
    for (const block of page.blocks || []) {
      if (Number.isFinite(block.confidence)) confs.push(Number(block.confidence));
    }
  }
  if (!confs.length) return 90;
  return Math.round((confs.reduce((s, c) => s + c, 0) / confs.length) * 100);
}

// Teks 1 crop: fullTextAnnotation.text (sudah urut baca versi Google).
// Diekspor untuk unit test parser (scripts/test-google-vision.ts).
export function visionCropText(resp: VisionSingleResponse): string {
  const t = cleanText(resp?.fullTextAnnotation?.text);
  if (t) return t;
  // Cadangan: anotasi pertama = keseluruhan teks terdeteksi.
  return cleanText(resp?.textAnnotations?.[0]?.description);
}

// Ubah boundingBox (vertices piksel ATAU normalizedVertices 0..1)
// jadi BBox. Return null bila tak bisa dibaca.
function polyToBBox(poly: VisionBoundingPoly | undefined, W: number, H: number): BBox | null {
  if (!poly) return null;
  let pts: Array<{ x: number; y: number }> | null = null;
  if (Array.isArray(poly.vertices) && poly.vertices.length >= 3) {
    pts = poly.vertices.map((v) => ({ x: Number(v.x) || 0, y: Number(v.y) || 0 }));
  } else if (Array.isArray(poly.normalizedVertices) && poly.normalizedVertices.length >= 3) {
    pts = poly.normalizedVertices.map((v) => ({
      x: (Number(v.x) || 0) * W,
      y: (Number(v.y) || 0) * H,
    }));
  }
  if (!pts) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const box: BBox = {
    x0: Math.max(0, Math.floor(Math.min(...xs))),
    y0: Math.max(0, Math.floor(Math.min(...ys))),
    x1: Math.min(W, Math.ceil(Math.max(...xs))),
    y1: Math.min(H, Math.ceil(Math.max(...ys))),
  };
  if (box.x1 - box.x0 < 4 || box.y1 - box.y0 < 4) return null;
  return box;
}

// Bangun OcrBox[] dari 1 response DOCUMENT_TEXT_DETECTION.
// Diekspor untuk unit test parser.
export function visionBoxesFromResponse(resp: VisionSingleResponse, W: number, H: number): OcrBox[] {
  const out: OcrBox[] = [];
  for (const page of resp?.fullTextAnnotation?.pages || []) {
    for (const block of page.blocks || []) {
      for (const para of block.paragraphs || []) {
        const text = cleanText(
          (para.words || [])
            .map((w) => (w.symbols || []).map((s) => s.text || "").join(""))
            .join(" "),
        );
        if (!text) continue;
        const conf = Number(para.confidence ?? block.confidence ?? 0);
        if (!Number.isFinite(conf) || conf < MIN_PARA_CONF) continue;
        const bbox = polyToBBox(para.boundingBox, W, H);
        if (!bbox) continue;
        out.push({ text, conf: Math.round(conf * 100), bbox });
      }
    }
  }
  // Urutan baca SAMA seperti ocrEnglish: atas->bawah, kanan->kiri.
  out.sort((a, b) => a.bbox.y0 - b.bbox.y0 || b.bbox.x0 - a.bbox.x0);
  return out;
}

// ---------------------------------------------------------------------------
// Region bubble dari blok teks (sumber bubble alternatif pengganti YOLO,
// dipakai bila dropdown bubble = "google").
//
// Blok Vision lebih kasar dari bubble (kotak teks, bukan outline), jadi:
//   1. visionBlocksFromResponse() ambil semua blok + bbox-nya,
//   2. mergeVisionBlocks() gabung blok berdekatan (satu bubble sering
//      pecah jadi beberapa blok/paragraf) lalu beri margin agar outline
//      bubble masuk ke dalam region untuk extractBubbleShapes().
// Kedua fungsi pure (tanpa network) -> unit-testable offline.
// ---------------------------------------------------------------------------
export interface VisionBlockBox {
  bbox: BBox;
  conf: number;
}

// Ambil blok apa adanya (tanpa filter confidence — paragraf teksnya
// sudah difilter di visionBoxesFromResponse; region hanya untuk bentuk).
// Diekspor untuk unit test.
export function visionBlocksFromResponse(resp: VisionSingleResponse, W: number, H: number): VisionBlockBox[] {
  const out: VisionBlockBox[] = [];
  for (const page of resp?.fullTextAnnotation?.pages || []) {
    for (const block of page.blocks || []) {
      const bbox = polyToBBox(block.boundingBox, W, H);
      if (!bbox) continue;
      out.push({ bbox, conf: Number(block.confidence) || 0 });
    }
  }
  return out;
}

function regionPad(): number {
  const v = Number(process.env.GOOGLE_REGION_PAD);
  return Number.isFinite(v) && v >= 0 ? v : 12;
}

function regionGap(): number {
  const v = Number(process.env.GOOGLE_REGION_GAP);
  return Number.isFinite(v) && v >= 0 ? v : 24;
}

function unionBox(a: BBox, b: BBox): BBox {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

// Jarak tepi-ke-tepi dua box (0 bila tumpang-tindih/sentuh).
function edgeGap(a: BBox, b: BBox): number {
  const dx = Math.max(0, Math.max(a.x0 - b.x1, b.x0 - a.x1));
  const dy = Math.max(0, Math.max(a.y0 - b.y1, b.y0 - a.y1));
  return Math.hypot(dx, dy);
}

// Gabung blok yang berdekatan (jarak tepi <= gap) via union-find, lalu
// expand margin final + clamp ke gambar. Return region-region bubble.
// Diekspor untuk unit test.
export function mergeVisionBlocks(blocks: VisionBlockBox[], W: number, H: number, gap?: number, pad?: number): BBox[] {
  const list = blocks.map((b) => ({ ...b.bbox }));
  if (!list.length || !W || !H) return [];
  const maxGap = gap ?? regionGap();
  const margin = pad ?? regionPad();

  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (edgeGap(list[i], list[j]) <= maxGap) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, BBox>();
  for (let i = 0; i < list.length; i++) {
    const r = find(i);
    groups.set(r, groups.has(r) ? unionBox(groups.get(r)!, list[i]) : { ...list[i] });
  }
  const out: BBox[] = [];
  for (const g of groups.values()) {
    const box: BBox = {
      x0: Math.max(0, Math.floor(g.x0 - margin)),
      y0: Math.max(0, Math.floor(g.y0 - margin)),
      x1: Math.min(W, Math.ceil(g.x1 + margin)),
      y1: Math.min(H, Math.ceil(g.y1 + margin)),
    };
    if (box.x1 - box.x0 >= 16 && box.y1 - box.y0 >= 16) out.push(box);
  }
  // Besar dulu (bubble utama didahulukan, konsisten dengan YOLO top-conf).
  out.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  return out;
}

// Cari region yang memuat titik tengah bbox (terkecil bila beberapa).
// Di luar semua region -> null (pemanggil pakai fallback elips).
// Diekspor untuk unit test.
export function findRegionForBox(box: BBox, regions: BBox[]): number {
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  let best = -1;
  let bestArea = Infinity;
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    if (cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1) {
      const area = (r.x1 - r.x0) * (r.y1 - r.y0);
      if (area < bestArea) {
        bestArea = area;
        best = i;
      }
    }
  }
  return best;
}

export interface GooglePageDetail {
  paras: OcrBox[];
  blocks: VisionBlockBox[];
}

// 1 request DOCUMENT_TEXT_DETECTION -> paragraf (teks) + blok (region).
// API error -> throw (kontrak no-fallback engine ini).
export async function ocrGooglePageDetail(imageBuffer: Buffer, apiKey?: string): Promise<GooglePageDetail> {
  const key = requireKey(apiKey);
  const { width = 0, height = 0 } = await sharp(imageBuffer).metadata();
  const [resp] = await annotate([imageBuffer.toString("base64")], "DOCUMENT_TEXT_DETECTION", key);
  if (!width || !height) return { paras: [], blocks: [] };
  return {
    paras: visionBoxesFromResponse(resp, width, height),
    blocks: visionBlocksFromResponse(resp, width, height),
  };
}

// ---------------------------------------------------------------------------
// ocrGoogleBubbleCrops: pengganti ocrBubbleCrops() / ocrVisionBubbleCrops().
// Crop kosong (tak terbaca) -> null. API error -> throw (no-fallback).
// ---------------------------------------------------------------------------
export async function ocrGoogleBubbleCrops(
  crops: Buffer[],
  onProgress?: (done: number, total: number) => void,
  apiKey?: string,
): Promise<Array<{ text: string; conf: number } | null>> {
  const out: Array<{ text: string; conf: number } | null> = crops.map(() => null);
  if (!crops.length) return out;
  const key = requireKey(apiKey);

  let done = 0;
  for (let i = 0; i < crops.length; i += BATCH) {
    const chunk = crops.slice(i, i + BATCH);
    const responses = await annotate(
      chunk.map((c) => c.toString("base64")),
      "TEXT_DETECTION",
      key,
    );
    responses.forEach((resp, k) => {
      const text = visionCropText(resp);
      out[i + k] = text ? { text, conf: cropConfidence(resp) } : null;
      done++;
      onProgress?.(done, crops.length);
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ocrGoogleFullPage: pengganti ocrEnglish() untuk engine google_vision.
// onProgress pecahan 0..1 (Vision tak memberi progres tengah, jadi 1x di
// akhir — route hanya memakainya untuk progress bar).
// ---------------------------------------------------------------------------
export async function ocrGoogleFullPage(
  imageBuffer: Buffer,
  onProgress?: (progress: number) => void,
  apiKey?: string,
): Promise<OcrBox[]> {
  const { paras } = await ocrGooglePageDetail(imageBuffer, apiKey);
  onProgress?.(1);
  return paras;
}
