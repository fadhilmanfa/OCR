import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";
import {
  normalizeAppLang,
  tesseractLangsFor,
  type AppLang,
} from "./languages";

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrBox {
  text: string;
  conf: number;
  bbox: BBox;
}

interface TesseractBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface TesseractWord {
  text?: string;
  confidence?: number;
}

interface TesseractLine {
  text?: string;
  confidence?: number;
  bbox?: TesseractBox;
  words?: TesseractWord[];
  lines?: never;
}

interface TesseractParagraph {
  text?: string;
  confidence?: number;
  bbox?: TesseractBox;
  lines?: TesseractLine[];
}

interface TesseractBlock {
  paragraphs?: TesseractParagraph[];
}

interface TesseractData {
  text?: string;
  confidence?: number;
  blocks?: TesseractBlock[];
}

const MIN_CONFIDENCE = 55;

function cleanText(text: string | undefined | null): string {
  return String(text || "")
    .replace(/(^|\s)\|(?=\s|$)/g, "$1I")
    .replace(/\s+/g, " ")
    .trim();
}

function validBox(box: TesseractBox | undefined | null): box is TesseractBox {
  return (
    !!box &&
    [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) &&
    box.x1 > box.x0 &&
    box.y1 > box.y0
  );
}

function letters(text: string): number {
  return (text.match(/[A-Za-z]/g) || []).length;
}

// Huruf Jepang: hiragana, katakana (termasuk halfwidth), kanji/CJK, long mark.
function japaneseChars(text: string): number {
  return (text.match(/[\u3040-\u309f\u30a0-\u30ff\uff61-\uff9f\u4e00-\u9faf\u3400-\u4dbfー]/g) || []).length;
}

// Hanzi Mandarin (CJK Unified Ideographs + Ext A + compatibility ideographs).
function hanChars(text: string): number {
  return (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
}

// Jumlah karakter CJK yang relevan untuk bahasa sumber. Selain JA/ZH
// (bahasa latin), selalu 0.
function cjkChars(text: string, source: AppLang): number {
  if (source === "ja") return japaneseChars(text);
  if (source === "zh") return hanChars(text);
  return 0;
}

// Kelas karakter CJK + tanda baca fullwidth untuk merapikan spasi.
const CJK_CHAR_CLASS =
  "\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";

// Tesseract menyisipkan spasi di antara karakter CJK ("你 好"). Buang spasi
// hanya bila kedua sisi sama-sama CJK agar campuran latin tetap terbaca.
function compactCjkSpaces(text: string, source: AppLang): string {
  if (source !== "ja" && source !== "zh") return text;
  return text.replace(
    new RegExp(`([${CJK_CHAR_CLASS}])[\\s]+(?=[${CJK_CHAR_CLASS}])`, "g"),
    "$1",
  );
}

function plausibleText(text: string, minLetterRatio = 0.48, source: AppLang = "en"): boolean {
  if (source === "ja" || source === "zh") {
    const cjk = cjkChars(text, source);
    if (cjk >= 2) return true;
    // Campuran latin dalam bubble CJK (nama, SFX latin) tetap diterima.
    const count = letters(text);
    const compact = text.replace(/\s/g, "");
    if (count >= 2 && count / Math.max(compact.length, 1) >= minLetterRatio) return true;
    // Balon Mandarin sangat pendek ("嗯", "走") tetap sah; Jepang butuh
    // minimal 2 karakter (mis. 「あ」 saja tidak, 「行け」 ya).
    if (source === "zh") return cjk >= 1;
    return compact.replace(/[ー]/g, "").length >= 2 && cjk >= 1;
  }
  const count = letters(text);
  const compact = text.replace(/\s/g, "");
  return count >= 2 && count / Math.max(compact.length, 1) >= minLetterRatio;
}

function union(a: BBox, b: BBox): BBox {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function intersectionOverSmall(a: BBox, b: BBox): number {
  const w = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const h = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const smaller = Math.min(
    (a.x1 - a.x0) * (a.y1 - a.y0),
    (b.x1 - b.x0) * (b.y1 - b.y0),
  );
  return smaller > 0 ? (w * h) / smaller : 0;
}

function paragraphBoxes(
  data: TesseractData,
  width: number,
  height: number,
  source: AppLang = "en",
): OcrBox[] {
  const out: OcrBox[] = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      const text = compactCjkSpaces(cleanText(para.text), source);
      const bbox = para.bbox;
      const confidence = para.confidence || 0;
      if (!validBox(bbox) || confidence < MIN_CONFIDENCE || !plausibleText(text, 0.48, source))
        continue;
      if (
        bbox.x1 - bbox.x0 > width * 0.7 ||
        bbox.y1 - bbox.y0 > height * 0.55
      )
        continue;
      out.push({ text, conf: confidence, bbox: { ...bbox } });
    }
  }
  return out;
}

function sameTextRegion(a: BBox, b: BBox): boolean {
  const gap = b.y0 - a.y1;
  const minWidth = Math.min(a.x1 - a.x0, b.x1 - b.x0);
  const xOverlap = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const minHeight = Math.min(a.y1 - a.y0, b.y1 - b.y0);
  return (
    gap >= -minHeight * 0.4 &&
    gap <= Math.max(12, minHeight * 1.2) &&
    xOverlap >= minWidth * 0.35
  );
}

function mergeParagraphs(boxes: OcrBox[], source: AppLang = "en"): OcrBox[] {
  const sorted = [...boxes].sort(
    (a, b) => a.bbox.y0 - b.bbox.y0 || b.bbox.x0 - a.bbox.x0,
  );
  const out: OcrBox[] = [];
  for (const item of sorted) {
    const existing = out.find((entry) => sameTextRegion(entry.bbox, item.bbox));
    if (existing) {
      // Jepang & Mandarin tidak pakai spasi antar baris — gabung langsung
      // bila kedua sisi mengandung karakter CJK.
      const joiner =
        (source === "ja" || source === "zh") &&
        cjkChars(existing.text, source) > 0 &&
        cjkChars(item.text, source) > 0
          ? ""
          : " ";
      existing.text += joiner + item.text;
      existing.conf = Math.min(existing.conf, item.conf);
      existing.bbox = union(existing.bbox, item.bbox);
    } else {
      out.push({ ...item, bbox: { ...item.bbox } });
    }
  }
  return out;
}

function sparseLines(
  data: TesseractData,
  primary: OcrBox[],
  width: number,
  height: number,
  source: AppLang = "en",
): OcrBox[] {
  const lines: OcrBox[] = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const text = cleanText(line.text);
        const bbox = line.bbox;
        if (!validBox(bbox) || !plausibleText(text, 0.35, source)) continue;
        if (
          bbox.x1 - bbox.x0 > width * 0.55 ||
          bbox.y1 - bbox.y0 > height * 0.08
        )
          continue;
        if (
          primary.some(
            (item) => intersectionOverSmall(item.bbox, bbox) > 0.45,
          )
        )
          continue;
        lines.push({ text, conf: line.confidence || 0, bbox: { ...bbox } });
      }
    }
  }
  return lines;
}

interface SparseGroup {
  lines: OcrBox[];
  bbox: BBox;
}

function groupSparseLines(lines: OcrBox[], source: AppLang = "en"): SparseGroup[] {
  const pending = [...lines].sort(
    (a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0,
  );
  const groups: SparseGroup[] = [];
  while (pending.length) {
    const first = pending.shift()!;
    const group: OcrBox[] = [first];
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        if (group.some((line) => sameTextRegion(line.bbox, pending[i].bbox))) {
          group.push(pending.splice(i, 1)[0]);
          changed = true;
        }
      }
    }
    group.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
    const strong = group.some((line) => line.conf >= 78);
    const single = group.length === 1;
    const hasCjk =
      (source === "ja" || source === "zh") &&
      group.some((g) => cjkChars(g.text, source) >= 2);
    if (
      !strong ||
      (single && !hasCjk && (group[0].conf < 88 || letters(group[0].text) < 5))
    )
      continue;
    const bbox = group.reduce((b, line) => union(b, line.bbox), group[0].bbox);
    groups.push({ lines: group, bbox });
  }
  return groups;
}

function cleanWord(word: TesseractWord, source: AppLang = "en"): string {
  let text = String(word.text || "").trim();
  if (source === "ja" || source === "zh") {
    // Terima kana/kanji/hanzi + latin/angka; buang murni simbol.
    if (!/[A-Za-z0-9\u3040-\u309f\u30a0-\u30ff\uff61-\uff9f\u4e00-\u9fff\u3400-\u4dbf]/.test(text)) return "";
    if ((word.confidence || 0) < 45 && cjkChars(text, source) < 1 && letters(text) < 4) return "";
    // Jangan strip karakter CJK; hanya rapikan tanda baca tepi latin.
    text = text.replace(/([?!])\d+$/g, "$1");
    return text.trim();
  }
  if (!/[A-Za-z0-9]/.test(text)) return "";
  if ((word.confidence || 0) < 45 && letters(text) < 4) return "";
  text = text.replace(/[^A-Za-z0-9.,!?'"()\-]/g, "");
  text = text.replace(/([?!])\d+$/g, "$1");
  text = text.replace(/^[^A-Za-z0-9(']+|[^A-Za-z0-9).,!?'\-]+$/g, "");
  return text;
}

function cropText(data: TesseractData, source: AppLang = "en"): string {
  const lines: string[] = [];
  const noSpace = source === "ja" || source === "zh";
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const words = (line.words || []).map((w) => cleanWord(w, source)).filter(Boolean);
        if (words.length) lines.push(noSpace ? words.join("") : words.join(" "));
      }
    }
  }
  const joined = noSpace ? lines.join("") : lines.join(" ");
  return compactCjkSpaces(cleanText(joined || data.text), source);
}

// Tesseract worker type is loosely typed across versions; keep local minimal shape.
type RecognizeWorker = {
  recognize: (
    image: Buffer,
  ) => Promise<{ data: TesseractData }>;
  setParameters: (params: Record<string, string | number>) => Promise<void>;
  terminate: () => Promise<void>;
};

async function rereadGroup(
  worker: RecognizeWorker,
  imageBuffer: Buffer,
  group: SparseGroup,
  width: number,
  height: number,
  source: AppLang = "en",
): Promise<OcrBox | null> {
  const pad = Math.max(
    6,
    Math.min(14, Math.round(Math.min(width, height) * 0.006)),
  );
  const left = Math.max(0, Math.floor(group.bbox.x0 - pad));
  const top = Math.max(0, Math.floor(group.bbox.y0 - pad));
  const right = Math.min(width, Math.ceil(group.bbox.x1 + pad));
  const bottom = Math.min(height, Math.ceil(group.bbox.y1 + pad));
  const w = right - left;
  const h = bottom - top;
  if (w < 8 || h < 8 || w > width * 0.6 || h > height * 0.5) return null;
  const crop = await sharp(imageBuffer)
    .extract({ left, top, width: w, height: h })
    .resize({ width: w * 2 })
    .grayscale()
    .normalize()
    .png()
    .toBuffer();
  const { data } = await worker.recognize(crop);
  const text = cropText(data, source);
  if ((data.confidence || 0) < 50 || !plausibleText(text, 0.35, source)) return null;
  return { text, conf: data.confidence || 0, bbox: group.bbox };
}

// OCR ringan untuk crop bubble YOLO: 1 pass PSM.SINGLE_BLOCK per crop
// dengan 1 worker bersama (jauh lebih cepat daripada ocrEnglish yang
// 3 pass + OCR ulang per grup). Crop sudah di-upscale + normalize oleh
// pemanggil (cropBubble). Return null untuk crop yang tidak terbaca.
// lines = kotak per BARIS dalam koordinat crop (buffer upscale 2x),
// dipakai untuk mask per-kalimat agar tidak oversize seperti lingkaran
// satu bubble penuh. Pemanggil memetakan ke koordinat halaman (/2 + offset).
export interface BubbleCropResult {
  text: string;
  conf: number;
  lines: OcrBox[];
}

function bubbleCropLines(
  data: TesseractData,
  source: AppLang = "en",
): OcrBox[] {
  const out: OcrBox[] = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const text = cleanText(line.text);
        const bbox = line.bbox;
        if (!validBox(bbox)) continue;
        const w = bbox.x1 - bbox.x0;
        const h = bbox.y1 - bbox.y0;
        if (w < 12 || h < 8) continue;
        if (w > 4000 || h > 2000) continue;
        if (!plausibleText(text, 0.35, source)) continue;
        out.push({ text, conf: line.confidence || 0, bbox: { ...bbox } });
      }
    }
  }
  return out;
}

export async function ocrBubbleCrops(
  crops: Buffer[],
  onProgress?: (done: number, total: number) => void,
  sourceRaw: unknown = "en",
): Promise<Array<BubbleCropResult | null>> {
  if (!crops.length) return [];
  const source = normalizeAppLang(sourceRaw, "en");
  const worker = (await createWorker(tesseractLangsFor(source), 1)) as unknown as RecognizeWorker;
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    const out: Array<BubbleCropResult | null> = [];
    for (const crop of crops) {
      try {
        const { data } = await worker.recognize(crop);
        const text = cropText(data, source);
        const conf = data.confidence || 0;
        if (conf < 50 || !plausibleText(text, 0.35, source)) {
          out.push(null);
          continue;
        }
        out.push({ text, conf, lines: bubbleCropLines(data, source) });
      } catch {
        out.push(null);
      } finally {
        onProgress?.(out.length, crops.length);
      }
    }
    return out;
  } finally {
    await worker.terminate();
  }
}

// Deteksi kotak baris saja (tanpa filter conf/teks global) untuk engine
// non-Tesseract (vision_llm / google_vision): teks terjemahan datang dari
// API, tapi mask per-baris tetap butuh posisi teks lokal yang murah.
// 1 pass Tesseract SINGLE_BLOCK per crop, return sejajar input (array kosong
// = tidak ketemu baris → pemanggil fallback ke mask satu bubble penuh).
export async function detectBubbleLines(
  crops: Buffer[],
  onProgress?: (done: number, total: number) => void,
  sourceRaw: unknown = "en",
): Promise<OcrBox[][]> {
  if (!crops.length) return [];
  const source = normalizeAppLang(sourceRaw, "en");
  const worker = (await createWorker(tesseractLangsFor(source), 1)) as unknown as RecognizeWorker;
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    const out: OcrBox[][] = [];
    for (const crop of crops) {
      try {
        const { data } = await worker.recognize(crop);
        out.push(bubbleCropLines(data, source));
      } catch {
        out.push([]);
      } finally {
        onProgress?.(out.length, crops.length);
      }
    }
    return out;
  } finally {
    await worker.terminate();
  }
}

// PSM AUTO memisahkan panel/kolom. PSM SPARSE_TEXT mencari balon kecil yang luput.
// OCR ulang hanya wilayah tambahan supaya garis ilustrasi tidak ikut jadi paragraf.
export async function ocrEnglish(
  imageBuffer: Buffer,
  onProgress?: (progress: number) => void,
  sourceRaw: unknown = "en",
): Promise<OcrBox[]> {
  const source = normalizeAppLang(sourceRaw, "en");
  const { width = 0, height = 0 } = await sharp(imageBuffer).metadata();
  const worker = (await createWorker(tesseractLangsFor(source), 1, {
    logger: (message: { status: string; progress: number }) => {
      if (message.status === "recognizing text" && onProgress)
        onProgress(message.progress);
    },
  })) as unknown as RecognizeWorker;
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    const { data: page } = await worker.recognize(imageBuffer);
    const primary = mergeParagraphs(paragraphBoxes(page, width, height, source), source);

    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    const { data: sparse } = await worker.recognize(imageBuffer);
    const groups = groupSparseLines(
      sparseLines(sparse, primary, width, height, source),
      source,
    );

    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    const extras: OcrBox[] = [];
    for (const group of groups.slice(0, 30)) {
      const extra = await rereadGroup(worker, imageBuffer, group, width, height, source);
      if (
        extra &&
        !primary.some(
          (item) => intersectionOverSmall(item.bbox, extra.bbox) > 0.4,
        )
      ) {
        extras.push(extra);
      }
    }
    return [...primary, ...extras].sort(
      (a, b) => a.bbox.y0 - b.bbox.y0 || b.bbox.x0 - a.bbox.x0,
    );
  } finally {
    await worker.terminate();
  }
}
