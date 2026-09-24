import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";

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

function plausibleText(text: string, minLetterRatio = 0.48): boolean {
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
): OcrBox[] {
  const out: OcrBox[] = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      const text = cleanText(para.text);
      const bbox = para.bbox;
      const confidence = para.confidence || 0;
      if (!validBox(bbox) || confidence < MIN_CONFIDENCE || !plausibleText(text))
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

function mergeParagraphs(boxes: OcrBox[]): OcrBox[] {
  const sorted = [...boxes].sort(
    (a, b) => a.bbox.y0 - b.bbox.y0 || b.bbox.x0 - a.bbox.x0,
  );
  const out: OcrBox[] = [];
  for (const item of sorted) {
    const existing = out.find((entry) => sameTextRegion(entry.bbox, item.bbox));
    if (existing) {
      existing.text += " " + item.text;
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
): OcrBox[] {
  const lines: OcrBox[] = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const text = cleanText(line.text);
        const bbox = line.bbox;
        if (!validBox(bbox) || !plausibleText(text, 0.35)) continue;
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

function groupSparseLines(lines: OcrBox[]): SparseGroup[] {
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
    if (
      !strong ||
      (single && (group[0].conf < 88 || letters(group[0].text) < 5))
    )
      continue;
    const bbox = group.reduce((b, line) => union(b, line.bbox), group[0].bbox);
    groups.push({ lines: group, bbox });
  }
  return groups;
}

function cleanWord(word: TesseractWord): string {
  let text = String(word.text || "").trim();
  if (!/[A-Za-z0-9]/.test(text)) return "";
  if ((word.confidence || 0) < 45 && letters(text) < 4) return "";
  text = text.replace(/[^A-Za-z0-9.,!?'"()\-]/g, "");
  text = text.replace(/([?!])\d+$/g, "$1");
  text = text.replace(/^[^A-Za-z0-9(']+|[^A-Za-z0-9).,!?'\-]+$/g, "");
  return text;
}

function cropText(data: TesseractData): string {
  const lines: string[] = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const words = (line.words || []).map(cleanWord).filter(Boolean);
        if (words.length) lines.push(words.join(" "));
      }
    }
  }
  return cleanText(lines.join(" ") || data.text);
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
  const text = cropText(data);
  if ((data.confidence || 0) < 50 || !plausibleText(text, 0.35)) return null;
  return { text, conf: data.confidence || 0, bbox: group.bbox };
}

// OCR ringan untuk crop bubble YOLO: 1 pass PSM.SINGLE_BLOCK per crop
// dengan 1 worker bersama (jauh lebih cepat daripada ocrEnglish yang
// 3 pass + OCR ulang per grup). Crop sudah di-upscale + normalize oleh
// pemanggil (cropBubble). Return null untuk crop yang tidak terbaca.
export async function ocrBubbleCrops(
  crops: Buffer[],
): Promise<Array<{ text: string; conf: number } | null>> {
  if (!crops.length) return [];
  const worker = (await createWorker("eng", 1)) as unknown as RecognizeWorker;
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    const out: Array<{ text: string; conf: number } | null> = [];
    for (const crop of crops) {
      try {
        const { data } = await worker.recognize(crop);
        const text = cropText(data);
        const conf = data.confidence || 0;
        if (conf < 50 || !plausibleText(text, 0.35)) {
          out.push(null);
          continue;
        }
        out.push({ text, conf });
      } catch {
        out.push(null);
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
): Promise<OcrBox[]> {
  const { width = 0, height = 0 } = await sharp(imageBuffer).metadata();
  const worker = (await createWorker("eng", 1, {
    logger: (message: { status: string; progress: number }) => {
      if (message.status === "recognizing text" && onProgress)
        onProgress(message.progress);
    },
  })) as unknown as RecognizeWorker;
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    const { data: page } = await worker.recognize(imageBuffer);
    const primary = mergeParagraphs(paragraphBoxes(page, width, height));

    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    const { data: sparse } = await worker.recognize(imageBuffer);
    const groups = groupSparseLines(
      sparseLines(sparse, primary, width, height),
    );

    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    const extras: OcrBox[] = [];
    for (const group of groups.slice(0, 30)) {
      const extra = await rereadGroup(worker, imageBuffer, group, width, height);
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
