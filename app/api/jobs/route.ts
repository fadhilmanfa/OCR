import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { resolveOcrEngine } from "@/lib/ocrComicsPlus";
import { openRouterConfig } from "@/lib/translate";
import { collectImages, processCollectedImages } from "@/lib/processJob";
import { completeJob, createJob, failJob, initPages, patchJob, patchPage } from "@/lib/jobs";

export const runtime = "nodejs";
export const maxDuration = 300;

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "outputs");

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
    const apiKeyField = form.get("apiKey");
    const { apiKey } = openRouterConfig(typeof apiKeyField === "string" ? apiKeyField : undefined);
    const providerField = form.get("provider");
    if (typeof providerField === "string" && providerField) provider = providerField;
    const bubbleField = form.get("bubble");
    if (typeof bubbleField === "string" && bubbleField) bubbleParam = bubbleField;
    const ocrField = form.get("ocrEngine");
    if (typeof ocrField === "string" && ocrField) ocrEngine = resolveOcrEngine(ocrField);
    if ((provider === "openrouter" || ocrEngine === "vision_llm") && !apiKey) {
      return NextResponse.json(
        { error: "Masukkan API key OpenRouter di UI atau atur OPENROUTER_API_KEY di .env." },
        { status: 400 },
      );
    }

    const files = form.getAll("files").filter((v): v is File => v instanceof File && v.size > 0);
    const limited = files.slice(0, 50);

    // collect cepat (unzip + baca buffer) agar total halaman langsung diketahui.
    const images = await collectImages(limited);
    if (!images.length) {
      return NextResponse.json(
        { error: "Upload JPG/PNG/WEBP atau ZIP/RAR berisi gambar." },
        { status: 400 },
      );
    }

    const jobId = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
    const jobDir = path.join(OUT_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    createJob(jobId, images.length);
    initPages(
      jobId,
      images.map((img) => img.name),
    );
    patchJob(jobId, {
      percent: 3,
      stage: "upload",
      message: `Menyiapkan ${images.length} halaman...`,
      currentPage: 0,
    });

    // Jalan di background — response langsung kembali agar client bisa polling.
    // Next.js tidak menunggu promise ini karena kita tidak await.
    void (async () => {
      try {
        const { pages } = await processCollectedImages(images, {
          jobId,
          jobDir,
          provider,
          bubbleParam,
          ocrEngine,
          apiKey,
          onProgress: (e) => {
            patchJob(jobId, {
              percent: e.percent,
              stage: e.stage,
              message: e.message,
              currentPage: e.currentPage,
              totalPages: e.totalPages,
              ...(e.bubbleTotal !== undefined && e.bubbleTotal !== null
                ? { bubbleTotal: e.bubbleTotal }
                : {}),
            });
            if (e.pageIndex !== undefined && e.pagePatch) {
              patchPage(jobId, e.pageIndex, e.pagePatch);
            }
          },
        });
        completeJob(jobId, {
          jobId,
          provider,
          pages,
          zipUrl: `/api/outputs/${jobId}/hasil.zip`,
          pdfUrl: `/api/outputs/${jobId}/hasil.pdf`,
        });
      } catch (e) {
        console.error(`[job ${jobId}]`, e);
        failJob(jobId, String((e as Error).message || e));
      }
    })();

    return NextResponse.json({ jobId, totalPages: images.length });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 500 });
  }
}
