import path from "path";
import fs from "fs";
import AdmZip from "adm-zip";
import { createExtractorFromData } from "node-unrar-js";
import sharp from "sharp";
import { ocrBubbleCrops, detectBubbleLines, ocrEnglish, type BBox } from "@/lib/ocr";
import type { OcrEngine } from "@/lib/ocrEngine";
import { ocrVisionBubbleCrops } from "@/lib/ocrVisionLLM";
import { ocrGoogleBubbleCrops, ocrGoogleFullPage, ocrGooglePageDetail, mergeVisionBlocks, findRegionForBox } from "@/lib/ocrGoogleVision";
import { bubbleEnabled, cropBubble, detectBubbles } from "@/lib/bubble";
import { extractBubbleShapes } from "@/lib/bubbleShape";
import { normalizeAppLang, type AppLang } from "@/lib/languages";
import { translateBatch } from "@/lib/translate";
import { overlayTranslations, type CleanArea } from "@/lib/overlay";
import { buildJobArchives } from "@/lib/jobFiles";
import {
  SOURCE_DIR,
  safeSourceName,
  sourceFilePath,
  writeRenderStore,
  type RenderStore,
} from "@/lib/renderStore";
import {
  normalizeCleanMode,
  normalizeProcessMode,
  type CleanMode,
  type ProcessMode,
} from "@/lib/cleanMode";
import type { JobStage, PageProgress } from "@/components/types";

const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export const isImgName = (n: string) => IMG_EXT.has(path.extname(n).toLowerCase());

// Polygon pengaman saat kontur OpenCV gagal: kotak deteksi diinset beberapa
// piksel. Box YOLO memeluk outline, jadi inset ini mencegah mask baris
// meluber keluar bubble walau tanpa kontur asli.
function insetBoxPolygon(b: BBox, inset = 4): Array<{ x: number; y: number }> {
  const x0 = b.x0 + inset;
  const y0 = b.y0 + inset;
  const x1 = Math.max(x0 + 1, b.x1 - inset);
  const y1 = Math.max(y0 + 1, b.y1 - inset);
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

export interface CollectedImage {
  name: string;
  buffer: Buffer;
}

// Ekstrak gambar dari buffer .rar (RAR4/RAR5, termasuk solid archive —
// filter dipasang di level extractor tapi pemrosesan internal tetap
// berurutan). RAR berpassword / multi-volume / rusak -> throw dengan
// pesan ramah (ditangkap route menjadi 400, bukan 500).
async function collectFromRar(archiveName: string, buffer: Buffer): Promise<CollectedImage[]> {
  // Salin ke ArrayBuffer murni: Buffer punya byteOffset yang membingungkan WASM.
  const copy = new Uint8Array(buffer.length);
  copy.set(buffer);
  const found: CollectedImage[] = [];
  try {
    const extractor = await createExtractorFromData({ data: copy.buffer as ArrayBuffer });
    const arc = extractor.extract({
      files: (h) => !h.flags.directory && isImgName(h.name),
    });
    for (const f of arc.files) {
      if (!f.extraction || f.extraction.length === 0) continue;
      // RAR bisa menyimpan path ala Windows (\) maupun Unix (/) — ambil basename manual.
      const base = f.fileHeader.name.split(/[\\/]/).pop() || f.fileHeader.name;
      found.push({ name: base, buffer: Buffer.from(f.extraction) });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password/i.test(msg)) {
      throw new Error(`RAR "${archiveName}" terproteksi password (belum didukung).`);
    }
    throw new Error(`Gagal membaca RAR "${archiveName}" (${msg.slice(0, 120)}).`);
  }
  return found;
}

export async function collectImages(files: File[]): Promise<CollectedImage[]> {
  const out: CollectedImage[] = [];
  for (const f of files) {
    const name = f.name || "upload";
    const ext = path.extname(name).toLowerCase();
    const buffer = Buffer.from(await f.arrayBuffer());
    if (ext === ".zip") {
      const zip = new AdmZip(buffer);
      for (const e of zip.getEntries()) {
        if (e.isDirectory || !isImgName(e.entryName)) continue;
        out.push({ name: path.basename(e.entryName), buffer: e.getData() });
      }
    } else if (ext === ".rar") {
      out.push(...(await collectFromRar(name, buffer)));
    } else if (isImgName(name)) {
      out.push({ name, buffer });
    }
  }
  out.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
  return out;
}

export interface PageResult {
  file: string;
  url: string;
  via: string;
  bubbleCount: number;
  /** Bubble tanpa teks OCR; dibiarkan utuh agar bisa dikoreksi manual. */
  undetected: number;
  // Kompat: `en` = teks sumber, `id` = teks terjemahan (apa pun pasangan bahasanya).
  boxes: Array<{ en: string; id: string; bbox: BBox }>;
}

export interface ProgressEvent {
  percent: number;
  stage: JobStage;
  message: string;
  currentPage: number;
  totalPages: number;
  pageIndex?: number;
  pagePatch?: Partial<Omit<PageProgress, "index">>;
  bubbleTotal?: number | null;
}

export type ProgressCallback = (e: ProgressEvent) => void;

const noop: ProgressCallback = () => {};

function baseFor(totalPages: number, pageIndex: number): number {
  // Jatah per halaman: 60% (25% -> 85%) dibagi rata.
  if (totalPages <= 0) return 25;
  return 25 + (pageIndex / totalPages) * 60;
}

function pageSpan(totalPages: number): number {
  return totalPages > 0 ? 60 / totalPages : 60;
}

/** Inti pipeline: normalisasi -> deteksi bubble -> loop OCR/translate/overlay -> zip/pdf. */
export async function processCollectedImages(
  images: CollectedImage[],
  opts: {
    jobId: string;
    jobDir: string;
    provider: string;
    bubbleParam: string;
    ocrEngine: OcrEngine;
    apiKey?: string;
    // Key KHUSUS Google Vision (terpisah dari apiKey OpenRouter agar
    // kombinasi translate-openrouter + OCR-google_vision bisa dipakai
    // bersamaan). Dibaca oleh jalur google_vision saja.
    googleApiKey?: string;
    sourceLangRaw?: unknown;
    targetLangRaw?: unknown;
    // Mode pembersih teks asli: "white" (putih), "bubble" (warna kertas), "none".
    cleanMode?: CleanMode;
    // "translate" = OCR/terjemah/lettering; "clean" = hanya timpa bubble.
    mode?: ProcessMode;
    onProgress?: ProgressCallback;
  },
): Promise<{ pages: PageResult[]; provider: string; ocrEngine: OcrEngine; sourceLang: AppLang; targetLang: AppLang }> {
  const { jobId, jobDir, provider, bubbleParam, ocrEngine } = opts;
  const processMode = normalizeProcessMode(opts.mode);
  const cleanOnly = processMode === "clean";
  const cleanMode = opts.cleanMode ? normalizeCleanMode(opts.cleanMode) : "white";
  const sourceLang = normalizeAppLang(opts.sourceLangRaw ?? "en", "en");
  const targetLang = normalizeAppLang(opts.targetLangRaw ?? "id", "id");
  if (!cleanOnly && sourceLang === targetLang) {
    throw new Error("Bahasa sumber dan target sama — pilih pasangan berbeda.");
  }
  if (cleanOnly && bubbleParam === "0") {
    throw new Error(
      "Mode 'Bersihkan saja' butuh deteksi bubble (Ogkalu/Psimera). Pilih salah satunya, atau matikan mode bersih.",
    );
  }
  const onEvent = opts.onProgress ?? noop;
  const N = images.length;

  // Sumber region bubble "google" (pengganti YOLO) HANYA sah dipasangkan
  // dengan OCR google_vision: teks paragraf dan region blok harus dari
  // response API yang sama agar berkorespondensi 1:1. Throw di awal
  // (job gagal eksplisit, bukan perilaku diam-diam).
  const useGoogleRegions = bubbleParam === "google";
  if (useGoogleRegions && ocrEngine !== "google_vision") {
    throw new Error(
      "Deteksi bubble 'Google' butuh OCR engine 'Google Vision'. Pilih keduanya, atau kembalikan bubble ke Ogkalu/Psimera.",
    );
  }

  onEvent({
    percent: 6,
    stage: "normalize",
    message: `Normalisasi ${N} halaman...`,
    currentPage: 0,
    totalPages: N,
  });
  const normalizedList = await Promise.all(images.map((img) => sharp(img.buffer).png().toBuffer()));
  // Simpan halaman asli + metadata render agar editor mask manual bisa
  // merender ulang halaman tanpa OCR/translate ulang. Folder ikut terhapus
  // otomatis bersama TTL job.
  const renderStore: RenderStore = { version: 1, pages: {} };
  renderStore.settings = {
    bubble: bubbleParam,
    ocrEngine,
    provider,
    sourceLang,
    targetLang,
    mode: processMode,
  };
  fs.mkdirSync(path.join(jobDir, SOURCE_DIR), { recursive: true });
  onEvent({
    percent: 10,
    stage: "normalize",
    message: `Normalisasi selesai (${N} halaman)`,
    currentPage: 0,
    totalPages: N,
  });

  // Mode bersih tidak memakai OCR: region Google dilewati, dan deteksi
  // bubble YOLO wajib supaya ada area yang bisa ditimpa.
  onEvent({
    percent: 12,
    stage: "bubble",
    message: cleanOnly
      ? "Deteksi bubble YOLO (mode bersih)..."
      : useGoogleRegions
        ? "Region bubble Google Vision..."
        : "Deteksi bubble YOLO...",
    currentPage: 0,
    totalPages: N,
  });
  // useGoogleRegions melewati YOLO total (tanpa Python/model): region
  // datang dari blok teks Google per halaman di dalam loop di bawah.
  // Mode bersih selalu butuh YOLO: tanpa bubble tidak ada yang bisa ditimpa.
  const useBubble = cleanOnly
    ? bubbleEnabled(true)
    : !useGoogleRegions && bubbleEnabled(bubbleParam !== "0");
  if (cleanOnly && !useBubble) {
    throw new Error(
      "Mode 'Bersihkan saja' butuh deteksi bubble YOLO. Pastikan BUBBLE_ENABLED=1 dan model bubble tersedia.",
    );
  }
  const det = useBubble ? await detectBubbles(normalizedList, bubbleParam) : null;
  const bubbleLists = det?.lists ?? normalizedList.map(() => []);
  const bubbleModel = det?.model ?? "ogkalu";
  const bubbleTotal = bubbleLists.reduce((s, l) => s + (l?.length ?? 0), 0);

  // Umumkan jumlah bubble per halaman agar frontend bisa tampilkan langsung.
  // (Google-regions belum tahu jumlahnya di titik ini — diumumkan per
  // halaman di dalam loop.)
  for (let i = 0; i < N; i++) {
    onEvent({
      percent: 25,
      stage: "bubble",
      message: useGoogleRegions
        ? `Region bubble dari Google (per halaman)`
        : `Terdeteksi ${bubbleTotal} bubble di ${N} halaman`,
      currentPage: 0,
      totalPages: N,
      pageIndex: i,
      pagePatch: { bubbleCount: bubbleLists[i]?.length ?? 0, stage: "queue" },
      bubbleTotal,
    });
  }
  onEvent({
    percent: 25,
    stage: N > 0 ? "ocr" : "bubble",
    message:
      N > 0
        ? `Mulai proses halaman 1/${N}...`
        : "Tidak ada halaman untuk diproses",
    currentPage: 0,
    totalPages: N,
    bubbleTotal,
  });

  const pages: PageResult[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const normalized = normalizedList[i];
    const { width = 0, height = 0 } = await sharp(normalized).metadata();
    const bubbles = bubbleLists[i] || [];
    let pageBubbleCount = bubbles.length;
    let undetected = 0;
    const base = baseFor(N, i);
    const span = pageSpan(N);

    // ---- Mode "Bersihkan saja": timpa SELURUH bubble, tanpa OCR/translate.
    // Dipakai untuk mengecek dulu apakah semua bubble tertutup rapi.
    if (cleanOnly) {
      onEvent({
        percent: base + span * 0.3,
        stage: "overlay",
        message: `Halaman ${i + 1}/${N}: membersihkan ${bubbles.length} bubble...`,
        currentPage: i,
        totalPages: N,
        pageIndex: i,
        pagePatch: { stage: "overlay", bubbleCount: bubbles.length, ocrTexts: 0, totalTexts: 0 },
      });
      let cleanAreas: CleanArea[] = [];
      if (bubbles.length) {
        const shapes = await extractBubbleShapes(normalized, bubbles, "yolo");
        cleanAreas = bubbles.map((b, k) => ({
          bbox: b,
          polygon: shapes[k]?.points,
          kind: shapes[k]?.kind,
          // Tanpa kontur: timpa seluruh kotak YOLO dengan sudut membulat.
          // Persegi tajam terlalu merusak art; elips menyisakan sudut teks.
          fallbackShape: "round" as const,
        }));
      }
      const outBuf = cleanAreas.length
        ? await overlayTranslations(normalized, [], { cleanMode, cleanAreas })
        : normalized;
      const rawBase = path.parse(img.name).name || `page-${i + 1}`;
      let outName = `${rawBase}.png`;
      let dup = 2;
      while (usedNames.has(outName) || fs.existsSync(path.join(jobDir, outName))) {
        outName = `${rawBase}_${dup}.png`;
        dup++;
      }
      usedNames.add(outName);
      fs.writeFileSync(path.join(jobDir, outName), outBuf);
      const sourceFile = safeSourceName(outName, i);
      fs.writeFileSync(sourceFilePath(jobDir, sourceFile), normalized);
      renderStore.pages[outName] = {
        file: outName,
        sourceFile,
        width,
        height,
        cleanMode,
        items: [],
        cleanAreas,
        autoMaskEdits: [],
        manualStrokes: [],
        undetected: 0,
      };
      pages.push({
        file: outName,
        url: `/api/outputs/${jobId}/${encodeURIComponent(outName)}`,
        via: `clean-${bubbleModel}`,
        bubbleCount: bubbles.length,
        undetected: 0,
        boxes: [],
      });
      onEvent({
        percent: base + span * 0.98,
        stage: "overlay",
        message: `Halaman ${i + 1}/${N} bersih (${bubbles.length} bubble ditimpa)`,
        currentPage: i + 1,
        totalPages: N,
        pageIndex: i,
        pagePatch: { stage: "done", via: `clean-${bubbleModel}` },
      });
      continue;
    }

    onEvent({
      percent: base + span * 0.02,
      stage: "ocr",
      message: `Halaman ${i + 1}/${N}: OCR (${bubbles.length} bubble)...`,
      currentPage: i,
      totalPages: N,
      pageIndex: i,
      pagePatch: { stage: "ocr", bubbleCount: bubbles.length },
    });

    let boxes;
    let via = "ocr-full";
    // Area yang ditimpa lebih dulu: seluruh bubble (YOLO/Google regions).
    // Kalau kosong, overlay memakai perilaku lama (mask per text box).
    let cleanAreas: CleanArea[] | undefined;
    // True hanya bila boxes berasal dari crop bubble YOLO (bukan OCR
    // full-page / comics) — syarat ekstraksi kontur masuk akal.
    let fromBubbles = false;
    // Jalur google-regions membawa polygon-nya sendiri (dari region blok,
    // bukan dari bbox teks) — blok overlay di bawah memakainya langsung.
    let regionPolys: Array<{ points: Array<{ x: number; y: number }>; kind: string } | null> | null = null;
    // Garis teks per bubble (koordinat halaman) untuk mask per-baris.
    // Diisi di cabang YOLO di bawah; dipakai saat membangun cleanAreas agar
    // timpaan tight per kalimat, bukan lingkaran satu bubble penuh.
    const pageLineMap = new Map<number, BBox[]>();
    if (useGoogleRegions) {
      // ocrEngine === "google_vision" dijamin validasi di atas. Satu
      // request DOCUMENT_TEXT_DETECTION memberi teks (paragraf) + region
      // (blok merge): YOLO, crop, dan OCR kedua tidak diperlukan.
      // Throw bila API error (kontrak no-fallback).
      const detail = await ocrGooglePageDetail(normalized, opts.googleApiKey);
      const regions = mergeVisionBlocks(detail.blocks, width, height);
      pageBubbleCount = regions.length;
      const rshapes = await extractBubbleShapes(normalized, regions, "google");
      // Timpa seluruh region, termasuk region yang paragrafnya tidak terbaca.
      cleanAreas = regions.map((b, k) => ({
        bbox: b,
        polygon: rshapes[k]?.points,
        kind: rshapes[k]?.kind,
        fallbackShape: "rect" as const,
      }));
      // Beberapa paragraf dalam satu bubble harus menjadi SATU overlay.
      // Sebelumnya tiap paragraf menulis di tengah polygon yang sama dan
      // hasil terjemahan saling menimpa.
      const grouped = new Map<number, typeof detail.paras>();
      const ungrouped: typeof detail.paras = [];
      for (const para of detail.paras) {
        const ri = findRegionForBox(para.bbox, regions);
        if (ri < 0) ungrouped.push(para);
        else grouped.set(ri, [...(grouped.get(ri) || []), para]);
      }
      const entries = [...grouped.entries()].map(([ri, paras]) => {
        paras.sort((a, b) => a.bbox.y0 - b.bbox.y0 || b.bbox.x0 - a.bbox.x0);
        const bbox = paras.reduce((acc, p) => ({
          x0: Math.min(acc.x0, p.bbox.x0), y0: Math.min(acc.y0, p.bbox.y0),
          x1: Math.max(acc.x1, p.bbox.x1), y1: Math.max(acc.y1, p.bbox.y1),
        }), { ...paras[0].bbox });
        return {
          box: { text: paras.map((p) => p.text).join(" "), conf: Math.min(...paras.map((p) => p.conf)), bbox },
          shape: rshapes[ri] ? { points: rshapes[ri]!.points, kind: rshapes[ri]!.kind } : null,
        };
      });
      entries.push(...ungrouped.map((p) => ({ box: p, shape: null })));
      entries.sort((a, b) => a.box.bbox.y0 - b.box.bbox.y0 || b.box.bbox.x0 - a.box.bbox.x0);
      boxes = entries.map((e) => e.box);
      regionPolys = entries.map((e) => e.shape);
      undetected = Math.max(0, regions.length - grouped.size);
      // Mode "text": mask per paragraf/kalimat Google, bukan polygon region
      // penuh. Region tanpa paragraf terbaca DIBIARKAN UTUH (sesuai
      // kesepakatan: user mengecek dulu, lalu menandai manual).
      if (cleanMode === "text") {
        cleanAreas = detail.paras.map((p) => {
          const ri = findRegionForBox(p.bbox, regions);
          return {
            bbox: p.bbox,
            fallbackShape: "line" as const,
            clipPolygon: ri >= 0
              ? (rshapes[ri]?.points?.length ? rshapes[ri]!.points : insetBoxPolygon(regions[ri]))
              : undefined,
          };
        });
      }
      via = "google-vision-regions";
      onEvent({
        percent: base + span * 0.38,
        stage: "ocr",
        message: `Halaman ${i + 1}/${N}: ${boxes.length} teks di ${regions.length} region Google`,
        currentPage: i,
        totalPages: N,
        pageIndex: i,
        pagePatch: { stage: "ocr", bubbleCount: regions.length, ocrTexts: boxes.length, totalTexts: boxes.length, via },
      });
      // Hasil kosong = lanjut 0 box (BUKAN fallback ke YOLO/Tesseract —
      // saklarnya ya dropdown bubble itu sendiri).
    } else if (bubbles.length > 0) {
      const crops = await Promise.all(bubbles.map((b) => cropBubble(normalized, b, width, height)));
      // Pertahankan index bubble asli: valid[k] sebelumnya adalah crop
      // ber-pad (+8px) sehingga bbox-nya 16px lebih besar dari YOLO.
      // Memakai bbox pad untuk overlay membuat elips putih meluber/offside
      // dan font kebesaran. Karena itu overlay selalu memakai bbox YOLO
      // asli (bubbles[idx]), crop hanya untuk input OCR.
      const validWithIdx = bubbles
        .map((b, idx) => ({ crop: crops[idx], idx }))
        .filter((v): v is { crop: NonNullable<typeof crops[number]>; idx: number } => v.crop !== null);
      const valid = validWithIdx.map((v) => v.crop);
      const useVision = ocrEngine === "vision_llm";
      const useGoogle = ocrEngine === "google_vision";
      // google_vision SENGAJA tanpa try/catch peredam: API error harus
      // throw (job gagal eksplisit, bukan fallback diam-diam ke Tesseract).
      // lineMap: bubbleIdx -> kotak BARIS teks dalam koordinat halaman.
      // Dipakai untuk mask per-kalimat (rapi, tidak oversize). Crop buffer
      // adalah 2x dari bbox crop (cropBubble resize w*2), jadi koordinat
      // crop /2 + offset crop = koordinat halaman.
      const mapCropLines = (cropLines: BBox[], cropPageBox: BBox): BBox[] => {
        const out: BBox[] = [];
        for (const l of cropLines) {
          const x0 = cropPageBox.x0 + l.x0 / 2;
          const y0 = cropPageBox.y0 + l.y0 / 2;
          const x1 = cropPageBox.x0 + l.x1 / 2;
          const y1 = cropPageBox.y0 + l.y1 / 2;
          if (x1 - x0 < 8 || y1 - y0 < 6) continue;
          out.push({ x0, y0, x1, y1 });
        }
        return out;
      };
      const texts = useGoogle
        ? await ocrGoogleBubbleCrops(
            valid.map((c) => c.buffer),
            (done, total) => {
              onEvent({
                percent: base + span * (0.02 + (done / Math.max(total, 1)) * 0.33),
                stage: "ocr",
                message: `Halaman ${i + 1}/${N}: OCR google ${done}/${total} bubble`,
                currentPage: i,
                totalPages: N,
                pageIndex: i,
                pagePatch: { ocrTexts: done },
              });
            },
            opts.googleApiKey,
          )
        : useVision
        ? await ocrVisionBubbleCrops(
            valid.map((c) => c.buffer),
            (done, total) => {
              onEvent({
                percent: base + span * (0.02 + (done / Math.max(total, 1)) * 0.33),
                stage: "ocr",
                message: `Halaman ${i + 1}/${N}: OCR vision ${done}/${total} bubble`,
                currentPage: i,
                totalPages: N,
                pageIndex: i,
                pagePatch: { ocrTexts: done },
              });
            },
            opts.apiKey,
          )
        : await ocrBubbleCrops(
            valid.map((c) => c.buffer),
            (done, total) => {
              onEvent({
                percent: base + span * (0.02 + (done / Math.max(total, 1)) * 0.33),
                stage: "ocr",
                message: `Halaman ${i + 1}/${N}: OCR ${done}/${total} bubble`,
                currentPage: i,
                totalPages: N,
                pageIndex: i,
                pagePatch: { ocrTexts: done },
              });
            },
            sourceLang,
          );
      // Kumpulkan garis per bubble untuk mask per-baris (khusus mode "text").
      // Tesseract: lines sudah ada dalam hasil yang sama (tanpa pass ekstra).
      // Vision/Google: teks dari API, garis dari 1 pass Tesseract lokal murah.
      // Mode lain memakai mask bubble penuh; tidak perlu pass garis.
      if (cleanMode === "text") {
        if (!useVision && !useGoogle) {
          (texts as Array<{ text: string; conf: number; lines?: BBox[] } | null>).forEach((t, k) => {
            const lines = (t as { lines?: Array<{ bbox: BBox }> })?.lines;
            if (!t || !lines?.length) return;
            const cropBox = valid[k].bbox;
            const pages = mapCropLines(lines.map((l) => l.bbox), cropBox);
            if (pages.length) pageLineMap.set(validWithIdx[k].idx, pages);
          });
        } else {
          try {
            const detected = await detectBubbleLines(
              valid.map((c) => c.buffer),
              undefined,
              sourceLang,
            );
            detected.forEach((lines, k) => {
              if (!texts[k] || !lines.length) return;
              const pages = mapCropLines(lines.map((l) => l.bbox), valid[k].bbox);
              if (pages.length) pageLineMap.set(validWithIdx[k].idx, pages);
            });
          } catch {
            // garis gagal = fallback ke mask satu bubble penuh (aman)
          }
        }
      }
      boxes = texts.flatMap((t, k) =>
        t ? [{ text: t.text, conf: t.conf, bbox: bubbles[validWithIdx[k].idx], bubbleIdx: validWithIdx[k].idx }] : [],
      );
      boxes.sort((a, b) => a.bbox.y0 - b.bbox.y0 || b.bbox.x0 - a.bbox.x0);
      // Bubble tanpa teks OCR = kandidat koreksi manual (dibiarkan utuh).
      const detectedIdx = new Set(
        boxes.map((b) => (b as unknown as { bubbleIdx?: number }).bubbleIdx).filter((v): v is number => typeof v === "number"),
      );
      undetected = bubbles.filter((_, idx) => !detectedIdx.has(idx)).length;
      via = useGoogle
        ? `yolo-${bubbleModel}+google-vision`
        : useVision
          ? `yolo-${bubbleModel}+vision-llm`
          : `yolo-${bubbleModel}`;
      fromBubbles = boxes.length > 0;
      onEvent({
        percent: base + span * 0.38,
        stage: "ocr",
        message: `Halaman ${i + 1}/${N}: dapat ${boxes.length} teks dari ${bubbles.length} bubble`,
        currentPage: i,
        totalPages: N,
        pageIndex: i,
        pagePatch: { ocrTexts: boxes.length, totalTexts: boxes.length, via },
      });
      // Hasil kosong google_vision = lanjut dengan 0 box (BUKAN fallback
      // ke ocrEnglish — kontrak no-fallback engine ini; API error sendiri
      // sudah throw di atas sehingga sampai sini hanya bila API sehat).
      if (!boxes.length && !useGoogle) {
        boxes = await ocrEnglish(normalized, (p) => {
          onEvent({
            percent: base + span * (0.05 + p * 0.3),
            stage: "ocr",
            message: `Halaman ${i + 1}/${N}: OCR fallback ${Math.round(p * 100)}%`,
            currentPage: i,
            totalPages: N,
            pageIndex: i,
          });
        }, sourceLang);
        via = "ocr-full";
        fromBubbles = false;
      }
    } else {
      // Tanpa bubble YOLO: google_vision memakai DOCUMENT_TEXT_DETECTION
      // full-page (throw bila API error — kontrak no-fallback).
      const useGoogleFull = ocrEngine === "google_vision";
      boxes = useGoogleFull
        ? await ocrGoogleFullPage(normalized, (p) => {
            onEvent({
              percent: base + span * (0.02 + p * 0.33),
              stage: "ocr",
              message: `Halaman ${i + 1}/${N}: OCR google penuh ${Math.round(p * 100)}%`,
              currentPage: i,
              totalPages: N,
              pageIndex: i,
            });
          }, opts.googleApiKey)
        : await ocrEnglish(normalized, (p) => {
            onEvent({
              percent: base + span * (0.02 + p * 0.33),
              stage: "ocr",
              message: `Halaman ${i + 1}/${N}: OCR penuh ${Math.round(p * 100)}%`,
              currentPage: i,
              totalPages: N,
              pageIndex: i,
            });
          }, sourceLang);
      if (useGoogleFull) via = "google-vision";
      onEvent({
        percent: base + span * 0.38,
        stage: "ocr",
        message: `Halaman ${i + 1}/${N}: dapat ${boxes.length} teks (full-page)`,
        currentPage: i,
        totalPages: N,
        pageIndex: i,
        pagePatch: { ocrTexts: boxes.length, totalTexts: boxes.length, via },
      });
    }

    // Timpa seluruh bubble dulu (termasuk yang tidak menghasilkan teks OCR),
    // baru lettering. Ini yang membuat tidak ada sisa huruf asli di bubble.
    // bubbleShapesCache dipakai ulang untuk items agar mask putih dan teks
    // memakai polygon yang SAMA (sebelumnya diekstrak 2x dari crop berbeda:
    // cleanAreas dari bbox YOLO asli, items dari bbox crop +8px → offside).
    let bubbleShapesCache: Awaited<ReturnType<typeof extractBubbleShapes>> | null = null;
    if (!cleanAreas && useBubble && bubbles.length) {
      onEvent({
        percent: base + span * 0.4,
        stage: "overlay",
        message: `Halaman ${i + 1}/${N}: siapkan ${bubbles.length} area bubble...`,
        currentPage: i,
        totalPages: N,
        pageIndex: i,
        pagePatch: { stage: "overlay", bubbleCount: bubbles.length },
      });
      const bubbleShapes = await extractBubbleShapes(normalized, bubbles, "yolo");
      bubbleShapesCache = bubbleShapes;
      // Mask per BARIS hanya untuk mode "text" (rapi, tidak oversize).
      // Mode "bubble"/"white" tetap menimpa satu bubble penuh seperti biasa.
      // Bubble TANPA teks OCR sengaja DIBIARKAN UTUH agar user bisa cek
      // error deteksi lalu menandai mask manual. Bubble yang punya teks tapi
      // garisnya gagal diekstrak tetap ditimpa penuh (hindari sisa huruf).
      const perLine = cleanMode === "text";
      const detectedIdx = new Set(
        boxes
          .map((b) => (b as unknown as { bubbleIdx?: number }).bubbleIdx)
          .filter((v): v is number => typeof v === "number"),
      );
      const areas: CleanArea[] = [];
      bubbles.forEach((b, k) => {
        const lines = perLine ? pageLineMap.get(k) : undefined;
        if (lines?.length) {
          for (const lb of lines) {
            areas.push({
              bbox: lb,
              fallbackShape: "line" as const,
              // Potong mask ke kontur bubble: baris yang mepet outline/tail
              // tidak lagi meluber menutupi garis atau ilustrasi di luar.
              // Tanpa kontur, pakai kotak deteksi yang diinset.
              clipPolygon: bubbleShapes[k]?.points?.length
                ? bubbleShapes[k]!.points
                : insetBoxPolygon(b),
            });
          }
        } else if (!perLine || detectedIdx.has(k)) {
          areas.push({
            bbox: b,
            polygon: bubbleShapes[k]?.points,
            kind: bubbleShapes[k]?.kind,
            fallbackShape: "round" as const,
          });
        }
      });
      cleanAreas = areas;
    }

    const srcTexts = boxes.map((b) => b.text);
    onEvent({
      percent: base + span * 0.42,
      stage: "translate",
      message: `Halaman ${i + 1}/${N}: terjemahkan ${srcTexts.length} teks (${sourceLang}→${targetLang})...`,
      currentPage: i,
      totalPages: N,
      pageIndex: i,
      pagePatch: { stage: "translate", ocrTexts: boxes.length, totalTexts: srcTexts.length, translated: 0, via },
    });
    const dstTexts = await translateBatch(srcTexts, provider, (done, total) => {
      onEvent({
        percent: base + span * (0.42 + (done / Math.max(total, 1)) * 0.38),
        stage: "translate",
        message: `Halaman ${i + 1}/${N}: terjemahan ${done}/${total}`,
        currentPage: i,
        totalPages: N,
        pageIndex: i,
        pagePatch: { translated: done, totalTexts: total },
      });
    }, opts.apiKey, sourceLang, targetLang);

    onEvent({
      percent: base + span * 0.85,
      stage: "overlay",
      message: `Halaman ${i + 1}/${N}: overlay ${dstTexts.length} teks...`,
      currentPage: i,
      totalPages: N,
      pageIndex: i,
      pagePatch: { stage: "overlay", translated: dstTexts.length },
    });
    // Langkah baru: ekstraksi kontur bubble dari tiap crop (OpenCV) di
    // antara cropBubble() dan overlayTranslations(). Hanya untuk box dari
    // YOLO; box full-page/comics tidak punya bentuk bubble -> elips.
    // Jalur google-regions sudah membawa polygon sendiri (regionPolys).
    // extractBubbleShapes tidak pernah throw (gagal = array null).
    // Untuk YOLO, pakai ulang bubbleShapesCache (hasil dari bbox YOLO asli)
    // lewat bubbleIdx — JANGAN ekstrak ulang dari boxes (dulu boxes = bbox
    // crop +8px sehingga poligon/mask bergeser 8px = lingkaran putih offside).
    let shapes: Array<{ points: Array<{ x: number; y: number }>; kind: string } | null> = regionPolys ?? [];
    if (!regionPolys && fromBubbles && boxes.length) {
      const allHaveIdx = boxes.every((b) => (b as unknown as { bubbleIdx?: unknown }).bubbleIdx != null);
      if (bubbleShapesCache && allHaveIdx) {
        shapes = boxes.map((b) => {
          const s = bubbleShapesCache![(b as unknown as { bubbleIdx: number }).bubbleIdx];
          return s ? { points: s.points, kind: s.kind } : null;
        });
      } else {
        onEvent({
          percent: base + span * 0.82,
          stage: "overlay",
          message: `Halaman ${i + 1}/${N}: ekstraksi bentuk ${boxes.length} bubble...`,
          currentPage: i,
          totalPages: N,
          pageIndex: i,
          pagePatch: { stage: "overlay", translated: 0 },
        });
        shapes = await extractBubbleShapes(
          normalized,
          boxes.map((b) => b.bbox),
        );
      }
    }
    const items = boxes.map((b, k) => ({
      text: dstTexts[k],
      sourceText: b.text,
      bbox: b.bbox,
      polygon: shapes[k]?.points,
      kind: shapes[k]?.kind,
      // YOLO fallback HARUS "round" (kapsul inset 4%) sama seperti cleanAreas.
      // Dulu undefined → elips dari bbox +8px yang lebih besar & beda pusat
      // sehingga lingkaran putih terlihat offside dari garis bubble.
      // Tanpa bubble (full-page/comics): mode "text" memakai mask per baris
      // (expand 2-6px), bukan elips per kotak teks.
      fallbackShape: regionPolys && !shapes[k]
        ? "rect" as const
        : (b as unknown as { bubbleIdx?: unknown }).bubbleIdx != null && !shapes[k]
          ? "round" as const
          : cleanMode === "text" && !shapes[k]
            ? "line" as const
            : undefined,
    }));
    // overlayTranslations tidak pernah throw (gagal -> gambar asli), tapi
    // bungkus sekali lagi agar 1 halaman gagal tidak menggugurkan 1 job.
    // Tandai via dengan jumlah mask baris vs penuh agar terlihat di UI
    // ("yolo-ogkalu+baris-5" = 5 mask per-baris; tanpa suffix = fallback
    // satu bubble penuh, biasanya garis OCR tak ketemu atau mode bersih).
    if (cleanAreas?.length && !regionPolys) {
      const baris = cleanAreas.filter((a) => a.fallbackShape === "line").length;
      if (baris > 0) via = `${via}+baris-${baris}`;
      console.log(`[halaman ${i + 1}] mask baris=${baris} penuh=${cleanAreas.length - baris} via=${via}`);
    }
    let outBuf: Buffer;
    try {
      outBuf = items.length || cleanAreas?.length
        ? await overlayTranslations(normalized, items, { cleanMode, cleanAreas })
        : normalized;
    } catch {
      outBuf = normalized;
    }
    // Nama output = nama file asli (ekstensi dipaksa .png). Anti tabrakan
    // kalau ada basename kembar dari folder berbeda di ZIP/RAR.
    const rawBase = path.parse(img.name).name || `page-${i + 1}`;
    let outName = `${rawBase}.png`;
    let dup = 2;
    while (usedNames.has(outName) || fs.existsSync(path.join(jobDir, outName))) {
      outName = `${rawBase}_${dup}.png`;
      dup++;
    }
    usedNames.add(outName);
    fs.writeFileSync(path.join(jobDir, outName), outBuf);
    const sourceFile = safeSourceName(outName, i);
    fs.writeFileSync(sourceFilePath(jobDir, sourceFile), normalized);
    renderStore.pages[outName] = {
      file: outName,
      sourceFile,
      width,
      height,
      cleanMode,
      items,
      cleanAreas: cleanAreas ?? [],
      autoMaskEdits: [],
      manualStrokes: [],
      undetected,
    };
    pages.push({
      file: outName,
      url: `/api/outputs/${jobId}/${encodeURIComponent(outName)}`,
      via,
      bubbleCount: pageBubbleCount,
      undetected,
      boxes: boxes.map((b, k) => ({ en: b.text, id: dstTexts[k], bbox: b.bbox })),
    });
    onEvent({
      percent: base + span * 0.98,
      stage: "overlay",
      message: `Halaman ${i + 1}/${N} selesai (${boxes.length} teks)`,
      currentPage: i + 1,
      totalPages: N,
      pageIndex: i,
      pagePatch: { stage: "done", via },
    });
  }

  onEvent({
    percent: 88,
    stage: "finalize",
    message: "Membuat ZIP...",
    currentPage: N,
    totalPages: N,
  });
  writeRenderStore(jobDir, renderStore);
  await buildJobArchives(
    jobDir,
    pages.map((p) => p.file),
  );

  onEvent({ percent: 93, stage: "finalize", message: "Membuat PDF...", currentPage: N, totalPages: N });

  return { pages, provider, ocrEngine, sourceLang, targetLang };
}
