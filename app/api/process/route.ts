import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { resolveOcrEngine } from "@/lib/ocrComicsPlus";
import { collectImages, processCollectedImages } from "@/lib/processJob";

export const runtime = "nodejs";
export const maxDuration = 300;

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "outputs");

// Jalur sinkron lama (tanpa progress) — dipertahankan agar kompatibel.
// Jalur baru dengan progress bar memakai POST /api/jobs + GET /api/jobs/[jobId].
// Keduanya memakai pipeline yang sama di lib/processJob.ts.
export async function POST(req: Request) {
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
    const files = form.getAll("files").filter(
      (v): v is File => v instanceof File && v.size > 0,
    );
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

    const { pages } = await processCollectedImages(images, {
      jobId,
      jobDir,
      provider,
      bubbleParam,
      ocrEngine,
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
