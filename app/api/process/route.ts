import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { resolveOcrEngine } from "@/lib/ocrComicsPlus";
import { googleVisionConfig } from "@/lib/ocrGoogleVision";
import { openRouterConfig } from "@/lib/translate";
import { collectImages, processCollectedImages } from "@/lib/processJob";
import { completeJob, createJob, failJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const maxDuration = 300;

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "outputs");

// Jalur sinkron lama (tanpa progress) — dipertahankan agar kompatibel.
// Jalur baru dengan progress bar memakai POST /api/jobs + GET /api/jobs/[jobId].
// Keduanya memakai pipeline yang sama di lib/processJob.ts.
export async function POST(req: Request) {
  let activeJobId: string | undefined;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let provider = "auto";
  let bubbleParam = "1";
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
    const apiKeyField = form.get("apiKey");
    const { apiKey } = openRouterConfig(typeof apiKeyField === "string" ? apiKeyField : undefined);
    const providerField = form.get("provider");
    if (typeof providerField === "string" && providerField) {
      provider = providerField;
    }
    const bubbleField = form.get("bubble");
    if (typeof bubbleField === "string" && bubbleField) {
      bubbleParam = bubbleField;
    }
    const ocrField = form.get("ocrEngine");
    if (typeof ocrField === "string" && ocrField) {
      ocrEngine = resolveOcrEngine(ocrField);
    }
    if ((provider === "openrouter" || ocrEngine === "vision_llm") && !apiKey) {
      return NextResponse.json(
        { error: "Masukkan API key OpenRouter di UI atau atur OPENROUTER_API_KEY di .env." },
        { status: 400 },
      );
    }
    // Key Google TERPISAH dari key OpenRouter agar kombinasi
    // translate-openrouter + OCR-google_vision bisa dipakai bersamaan.
    const googleKeyField = form.get("googleApiKey");
    const { apiKey: googleApiKey } = googleVisionConfig(
      typeof googleKeyField === "string" ? googleKeyField : undefined,
    );
    if (ocrEngine === "google_vision" && !googleApiKey) {
      return NextResponse.json(
        { error: "Masukkan API key Google Vision di UI atau atur GOOGLE_VISION_API_KEY di .env." },
        { status: 400 },
      );
    }
    // Region bubble "google" hanya sah dengan OCR google_vision (teks dan
    // region harus dari response API yang sama). Gagal eksplisit di sini
    // agar tak ada perilaku diam-diam.
    if (bubbleParam === "google" && ocrEngine !== "google_vision") {
      return NextResponse.json(
        { error: "Deteksi bubble 'Google' butuh OCR engine 'Google Vision'. Pilih keduanya, atau kembalikan bubble ke Ogkalu/Psimera." },
        { status: 400 },
      );
    }
    const files = form.getAll("files").filter(
      (v): v is File => v instanceof File && v.size > 0,
    );
    const limited = files.slice(0, 50);

    const images = await collectImages(limited);
    if (!images.length) {
      return NextResponse.json(
        { error: "Upload JPG/PNG/WEBP atau ZIP/RAR berisi gambar." },
        { status: 400 },
      );
    }

    const jobId =
      Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
    const jobDir = path.join(OUT_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    activeJobId = jobId;
    createJob(jobId, images.length);

    const { pages } = await processCollectedImages(images, {
      jobId,
      jobDir,
      provider,
      bubbleParam,
      ocrEngine,
      apiKey,
      googleApiKey,
    });

    const job = completeJob(jobId, {
      jobId,
      provider,
      pages,
      zipUrl: `/api/outputs/${jobId}/hasil.zip`,
      pdfUrl: `/api/outputs/${jobId}/hasil.pdf`,
    });
    return NextResponse.json({ ...job?.result, ocrEngine });
  } catch (e) {
    if (activeJobId) failJob(activeJobId, String((e as Error).message || e));
    console.error(e);
    return NextResponse.json(
      { error: String((e as Error).message || e) },
      { status: 500 },
    );
  }
}
