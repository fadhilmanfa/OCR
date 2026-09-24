import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import AdmZip from "adm-zip";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { ocrBubbleCrops, ocrEnglish } from "@/lib/ocr";
import { ocrComicsPlus, resolveOcrEngine } from "@/lib/ocrComicsPlus";
import { ocrVisionBubbleCrops } from "@/lib/ocrVisionLLM";
import { bubbleEnabled, cropBubble, detectBubbles, drawBubbleBoxes } from "@/lib/bubble";
import { translateBatch } from "@/lib/translate";
import { overlayTranslations } from "@/lib/overlay";

export const runtime = "nodejs";
export const maxDuration = 300;

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "outputs");

const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const isImg = (n: string) => IMG_EXT.has(path.extname(n).toLowerCase());

interface CollectedImage {
  name: string;
  buffer: Buffer;
}

async function collectImages(files: File[]): Promise<CollectedImage[]> {
  const out: CollectedImage[] = [];
  for (const f of files) {
    const name = f.name || "upload";
    const ext = path.extname(name).toLowerCase();
    const buffer = Buffer.from(await f.arrayBuffer());
    if (ext === ".zip") {
      const zip = new AdmZip(buffer);
      for (const e of zip.getEntries()) {
        if (e.isDirectory || !isImg(e.entryName)) continue;
        out.push({
          name: path.basename(e.entryName),
          buffer: e.getData(),
        });
      }
    } else if (isImg(name)) {
      out.push({ name, buffer });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function POST(req: Request) {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let provider = "auto";
  let bubbleParam = "1";
  // Engine OCR: "tesseract" (default, perilaku lama), "comics_text_plus"
  // (FCENet+MASTER), atau "vision_llm" (Vision LLM via OpenRouter).
  // Nilai asing -> resolveOcrEngine() mengembalikan default.
  let ocrEngine = resolveOcrEngine();
  try {
    const url = new URL(req.url);
    const qp = url.searchParams.get("provider");
    if (qp) provider = qp;
    const qb = url.searchParams.get("bubble");
    if (qb) bubbleParam = qb;
    const qo = url.searchParams.get("ocrEngine");
    if (qo) ocrEngine = resolveOcrEngine(qo);
  } catch {
    // abaikan, pakai default
  }

  try {
    const form = await req.formData();
    const providerField = form.get("provider");
    if (typeof providerField === "string" && providerField) {
      provider = providerField;
    }
    const bubbleField = form.get("bubble");
    if (typeof bubbleField === "string" && bubbleField) {
      bubbleParam = bubbleField;
    }
    // FormData menang atas query param (sama seperti provider & bubble).
    const ocrField = form.get("ocrEngine");
    if (typeof ocrField === "string" && ocrField) {
      ocrEngine = resolveOcrEngine(ocrField);
    }
    const files = form.getAll("files").filter(
      (v): v is File => v instanceof File && v.size > 0,
    );
    // Batasi 50 file seperti perilaku multer lama (upload.array("files", 50)).
    const limited = files.slice(0, 50);

    const images = await collectImages(limited);
    if (!images.length) {
      return NextResponse.json(
        { error: "Upload JPG/PNG atau ZIP berisi gambar." },
        { status: 400 },
      );
    }

    const jobId =
      Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
    const jobDir = path.join(OUT_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const pages: Array<{
      file: string;
      original: string;
      url: string;
      originalUrl: string;
      via: string;
      bubbleCount: number;
      boxes: Array<{ en: string; id: string; bbox: unknown }>;
    }> = [];

    // Normalisasi dulu semua, lalu deteksi bubble SEKALI per job
    // (load model YOLO hanya 1x). Gagal = [] -> fallback OCR full-page.
    const normalizedList = await Promise.all(
      images.map((img) => sharp(img.buffer).png().toBuffer()),
    );
    // Engine comics_text_plus: FCENet sudah melokalisasi teks sendiri
    // (end-to-end full-page), jadi YOLO bubble DILEWATI dan model
    // FCENet+MASTER dipanggil SEKALI per job (load hanya 1x).
    // Gagal (list kosong) -> fallback ke Tesseract di dalam loop.
    const useComics = ocrEngine === "comics_text_plus";
    const comicsLists = useComics ? await ocrComicsPlus(normalizedList) : null;
    const useBubble = !useComics && bubbleEnabled(bubbleParam !== "0");
    const det = useBubble
      ? await detectBubbles(normalizedList, bubbleParam)
      : null;
    const bubbleLists = det?.lists ?? normalizedList.map(() => []);
    const bubbleModel = det?.model ?? "ogkalu";

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      // Normalisasi ke PNG agar OCR + overlay konsisten.
      const normalized = normalizedList[i];
      const { width = 0, height = 0 } = await sharp(normalized).metadata();
      const bubbles = bubbleLists[i] || [];

      let boxes;
      let via = "ocr-full";
      if (useComics) {
        // Jalur comics_text_plus: PENGGANTI ocrEnglish()/ocrBubbleCrops().
        // Bentuk boxes SAMA (OcrBox {text, conf, bbox}) sehingga
        // translateBatch() + overlayTranslations() di bawah tidak berubah.
        boxes = comicsLists?.[i] ?? [];
        via = "comics-text-plus";
        if (!boxes.length) {
          // Comics tidak membaca apa-apa -> fallback halaman penuh
          // Tesseract (sama seperti fallback bubble-tak-terbaca).
          boxes = await ocrEnglish(normalized);
          via = "ocr-full-fallback";
        }
      } else if (bubbles.length > 0) {
        // Jalur YOLO: OCR per bubble (cepat, 1 pass) lalu petakan balik.
        // bbox = area bubble -> overlay membersihkan & menulis di bubble.
        const crops = await Promise.all(
          bubbles.map((b) => cropBubble(normalized, b, width, height)),
        );
        const valid = crops.filter(
          (c): c is NonNullable<typeof c> => c !== null,
        );
        // Titik tukar engine per-bubble: Tesseract (default, kode lama)
        // atau Vision LLM. Keduanya return bentuk SAMA
        // (Array<{text, conf} | null>) sehingga kode di bawah tidak berubah.
        // ocrVisionBubbleCrops() menembak OpenRouter maks 5 request bareng
        // (lihat MAX_CONCURRENCY di lib/ocrVisionLLM.ts).
        const useVision = ocrEngine === "vision_llm";
        const texts = useVision
          ? await ocrVisionBubbleCrops(valid.map((c) => c.buffer))
          : await ocrBubbleCrops(valid.map((c) => c.buffer));
        boxes = texts.flatMap((t, k) =>
          t ? [{ text: t.text, conf: t.conf, bbox: valid[k].bbox }] : [],
        );
        // Urutan baca sama seperti ocrEnglish (atas->bawah, kanan->kiri).
        boxes.sort(
          (a, b) => a.bbox.y0 - b.bbox.y0 || b.bbox.x0 - a.bbox.x0,
        );
        via = useVision ? `yolo-${bubbleModel}+vision-llm` : `yolo-${bubbleModel}`;
        if (!boxes.length) {
          // Bubble ketemu tapi tidak terbaca -> fallback halaman penuh.
          boxes = await ocrEnglish(normalized);
          via = "ocr-full";
        }
      } else {
        boxes = await ocrEnglish(normalized);
      }
      const enTexts = boxes.map((b) => b.text);
      const idTexts = await translateBatch(enTexts, provider);
      const items = boxes.map((b, k) => ({
        text: idTexts[k],
        bbox: b.bbox,
      }));
      const outBuf = items.length
        ? await overlayTranslations(normalized, items)
        : normalized;
      const outName = `p${String(i + 1).padStart(3, "0")}_${path.parse(img.name).name}.png`;
      fs.writeFileSync(path.join(jobDir, outName), outBuf);
      // Simpan juga aslinya untuk preview before/after.
      // Kalau bubble terdeteksi, gambar kotak di versi Asli saja
      // (hasil ID tetap bersih).
      const origName = `orig_${outName}`;
      const origBuf =
        bubbles.length > 0 ? await drawBubbleBoxes(normalized, bubbles) : normalized;
      fs.writeFileSync(path.join(jobDir, origName), origBuf);
      pages.push({
        file: outName,
        original: origName,
        url: `/api/outputs/${jobId}/${outName}`,
        originalUrl: `/api/outputs/${jobId}/${origName}`,
        via,
        bubbleCount: bubbles.length,
        boxes: boxes.map((b, k) => ({
          en: b.text,
          id: idTexts[k],
          bbox: b.bbox,
        })),
      });
    }

    // ZIP hasil.
    const zip = new AdmZip();
    for (const p of pages) {
      zip.addLocalFile(path.join(jobDir, p.file));
    }
    zip.writeZip(path.join(jobDir, "hasil.zip"));

    // PDF hasil.
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
          doc.image(buf, 0, 0, {
            width: meta.width,
            height: meta.height,
          });
        }
        doc.end();
      })().catch(reject);
      stream.on("finish", () => resolve());
      stream.on("error", reject);
    });

    return NextResponse.json({
      jobId,
      provider,
      ocrEngine,
      pages,
      zipUrl: `/api/outputs/${jobId}/hasil.zip`,
      pdfUrl: `/api/outputs/${jobId}/hasil.pdf`,
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: String((e as Error).message || e) },
      { status: 500 },
    );
  }
}
