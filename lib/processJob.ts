import path from "path";
import fs from "fs";
import AdmZip from "adm-zip";
import { createExtractorFromData } from "node-unrar-js";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { ocrBubbleCrops, ocrEnglish, type BBox } from "@/lib/ocr";
import { ocrComicsPlus, type OcrEngine } from "@/lib/ocrComicsPlus";
import { ocrVisionBubbleCrops } from "@/lib/ocrVisionLLM";
import { ocrGoogleBubbleCrops, ocrGoogleFullPage, ocrGooglePageDetail, mergeVisionBlocks, findRegionForBox } from "@/lib/ocrGoogleVision";
import { bubbleEnabled, cropBubble, detectBubbles } from "@/lib/bubble";
import { extractBubbleShapes } from "@/lib/bubbleShape";
import { translateBatch } from "@/lib/translate";
import { overlayTranslations } from "@/lib/overlay";
import type { JobStage, PageProgress } from "@/components/types";

const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export const isImgName = (n: string) => IMG_EXT.has(path.extname(n).toLowerCase());

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
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export interface PageResult {
  file: string;
  url: string;
  via: string;
  bubbleCount: number;
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
    onProgress?: ProgressCallback;
  },
): Promise<{ pages: PageResult[]; provider: string; ocrEngine: OcrEngine }> {
  const { jobId, jobDir, provider, bubbleParam, ocrEngine } = opts;
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
  onEvent({
    percent: 10,
    stage: "normalize",
    message: `Normalisasi selesai (${N} halaman)`,
    currentPage: 0,
    totalPages: N,
  });

  const useComics = ocrEngine === "comics_text_plus";
  onEvent({
    percent: 12,
    stage: "bubble",
    message: useComics
      ? "OCR comics_text_plus (FCENet+MASTER)..."
      : useGoogleRegions
        ? "Region bubble Google Vision..."
        : "Deteksi bubble YOLO...",
    currentPage: 0,
    totalPages: N,
  });
  const comicsLists = useComics ? await ocrComicsPlus(normalizedList) : null;
  // useGoogleRegions melewati YOLO total (tanpa Python/model): region
  // datang dari blok teks Google per halaman di dalam loop di bawah.
  const useBubble = !useComics && !useGoogleRegions && bubbleEnabled(bubbleParam !== "0");
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
      message: useComics
        ? `OCR awal selesai`
        : useGoogleRegions
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
    const base = baseFor(N, i);
    const span = pageSpan(N);

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
    // True hanya bila boxes berasal dari crop bubble YOLO (bukan OCR
    // full-page / comics) — syarat ekstraksi kontur masuk akal.
    let fromBubbles = false;
    // Jalur google-regions membawa polygon-nya sendiri (dari region blok,
    // bukan dari bbox teks) — blok overlay di bawah memakainya langsung.
    let regionPolys: Array<{ points: Array<{ x: number; y: number }>; kind: string } | null> | null = null;
    if (useGoogleRegions) {
      // ocrEngine === "google_vision" dijamin validasi di atas. Satu
      // request DOCUMENT_TEXT_DETECTION memberi teks (paragraf) + region
      // (blok merge): YOLO, crop, dan OCR kedua tidak diperlukan.
      // Throw bila API error (kontrak no-fallback).
      const detail = await ocrGooglePageDetail(normalized, opts.googleApiKey);
      const regions = mergeVisionBlocks(detail.blocks, width, height);
      const rshapes = await extractBubbleShapes(normalized, regions);
      boxes = detail.paras.map((p) => ({ text: p.text, conf: p.conf, bbox: p.bbox }));
      boxes.sort((a, b) => a.bbox.y0 - b.bbox.y0 || b.bbox.x0 - a.bbox.x0);
      // regionPolys SEJAJAR dengan boxes terurut (dipetakan setelah sort).
      regionPolys = boxes.map((b) => {
        const ri = findRegionForBox(b.bbox, regions);
        if (ri < 0 || !rshapes[ri]) return null;
        return { points: rshapes[ri]!.points, kind: rshapes[ri]!.kind };
      });
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
    } else if (useComics) {
      boxes = comicsLists?.[i] ?? [];
      via = "comics-text-plus";
      onEvent({
        percent: base + span * 0.3,
        stage: "ocr",
        message: `Halaman ${i + 1}/${N}: OCR comics ${boxes.length} teks`,
        currentPage: i,
        totalPages: N,
        pageIndex: i,
        pagePatch: { stage: "ocr", ocrTexts: boxes.length, totalTexts: boxes.length },
      });
      if (!boxes.length) {
        boxes = await ocrEnglish(normalized, (p) => {
          onEvent({
            percent: base + span * (0.02 + p * 0.3),
            stage: "ocr",
            message: `Halaman ${i + 1}/${N}: OCR fallback ${Math.round(p * 100)}%`,
            currentPage: i,
            totalPages: N,
            pageIndex: i,
          });
        });
        via = "ocr-full-fallback";
        onEvent({
          percent: base + span * 0.35,
          stage: "ocr",
          message: `Halaman ${i + 1}/${N}: fallback ${boxes.length} teks`,
          currentPage: i,
          totalPages: N,
          pageIndex: i,
          pagePatch: { ocrTexts: boxes.length, totalTexts: boxes.length },
        });
      }
    } else if (bubbles.length > 0) {
      const crops = await Promise.all(bubbles.map((b) => cropBubble(normalized, b, width, height)));
      const valid = crops.filter((c): c is NonNullable<typeof c> => c !== null);
      const useVision = ocrEngine === "vision_llm";
      const useGoogle = ocrEngine === "google_vision";
      // google_vision SENGAJA tanpa try/catch peredam: API error harus
      // throw (job gagal eksplisit, bukan fallback diam-diam ke Tesseract).
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
          );
      boxes = texts.flatMap((t, k) =>
        t ? [{ text: t.text, conf: t.conf, bbox: valid[k].bbox }] : [],
      );
      boxes.sort((a, b) => a.bbox.y0 - b.bbox.y0 || b.bbox.x0 - a.bbox.x0);
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
        });
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
          });
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

    const enTexts = boxes.map((b) => b.text);
    onEvent({
      percent: base + span * 0.42,
      stage: "translate",
      message: `Halaman ${i + 1}/${N}: terjemahkan ${enTexts.length} teks...`,
      currentPage: i,
      totalPages: N,
      pageIndex: i,
      pagePatch: { stage: "translate", ocrTexts: boxes.length, totalTexts: enTexts.length, translated: 0, via },
    });
    const idTexts = await translateBatch(enTexts, provider, (done, total) => {
      onEvent({
        percent: base + span * (0.42 + (done / Math.max(total, 1)) * 0.38),
        stage: "translate",
        message: `Halaman ${i + 1}/${N}: terjemahan ${done}/${total}`,
        currentPage: i,
        totalPages: N,
        pageIndex: i,
        pagePatch: { translated: done, totalTexts: total },
      });
    }, opts.apiKey);

    onEvent({
      percent: base + span * 0.85,
      stage: "overlay",
      message: `Halaman ${i + 1}/${N}: overlay ${idTexts.length} teks...`,
      currentPage: i,
      totalPages: N,
      pageIndex: i,
      pagePatch: { stage: "overlay", translated: idTexts.length },
    });
    // Langkah baru: ekstraksi kontur bubble dari tiap crop (OpenCV) di
    // antara cropBubble() dan overlayTranslations(). Hanya untuk box dari
    // YOLO; box full-page/comics tidak punya bentuk bubble -> elips.
    // Jalur google-regions sudah membawa polygon sendiri (regionPolys).
    // extractBubbleShapes tidak pernah throw (gagal = array null -> elips).
    let shapes: Array<{ points: Array<{ x: number; y: number }>; kind: string } | null> = regionPolys ?? [];
    if (!regionPolys && fromBubbles && boxes.length) {
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
    const items = boxes.map((b, k) => ({
      text: idTexts[k],
      bbox: b.bbox,
      polygon: shapes[k]?.points,
      kind: shapes[k]?.kind,
    }));
    // overlayTranslations tidak pernah throw (gagal -> gambar asli), tapi
    // bungkus sekali lagi agar 1 halaman gagal tidak menggugurkan 1 job.
    let outBuf: Buffer;
    try {
      outBuf = items.length ? await overlayTranslations(normalized, items) : normalized;
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
    pages.push({
      file: outName,
      url: `/api/outputs/${jobId}/${encodeURIComponent(outName)}`,
      via,
      bubbleCount: bubbles.length,
      boxes: boxes.map((b, k) => ({ en: b.text, id: idTexts[k], bbox: b.bbox })),
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
  const zip = new AdmZip();
  for (const p of pages) {
    zip.addLocalFile(path.join(jobDir, p.file));
  }
  zip.writeZip(path.join(jobDir, "hasil.zip"));

  onEvent({ percent: 93, stage: "finalize", message: "Membuat PDF...", currentPage: N, totalPages: N });
  const pdfPath = path.join(jobDir, "hasil.pdf");
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);
    (async () => {
      for (const p of pages) {
        const buf = fs.readFileSync(path.join(jobDir, p.file));
        const meta = await sharp(buf).metadata();
        doc.addPage({ size: [meta.width || 800, meta.height || 1200] });
        doc.image(buf, 0, 0, { width: meta.width, height: meta.height });
      }
      doc.end();
    })().catch(reject);
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });

  return { pages, provider, ocrEngine };
}
