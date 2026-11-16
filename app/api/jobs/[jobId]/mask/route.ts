import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getJob } from "@/lib/jobs";
import { buildJobArchives } from "@/lib/jobFiles";
import { overlayTranslations, type CleanArea } from "@/lib/overlay";
import { readRenderStore, sourceFilePath, writeRenderStore } from "@/lib/renderStore";

export const runtime = "nodejs";
export const maxDuration = 300;

const OUT_DIR = path.join(process.cwd(), "outputs");
const MAX_RECTS = 100;
const MIN_SIDE = 2;

interface RawRect {
  x0?: unknown;
  y0?: unknown;
  x1?: unknown;
  y1?: unknown;
}

function number(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// POST /api/jobs/<jobId>/mask
// Body: { file: string, rects: [{x0,y0,x1,y1}] } — koordinat piksel halaman.
// Render ulang halaman dari sumber ASLI + mask otomatis + mask manual.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  if (!/^[a-z0-9]+$/i.test(jobId)) {
    return NextResponse.json({ error: "jobId tidak valid" }, { status: 400 });
  }
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Hasil tidak ditemukan / sudah kedaluwarsa" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (job.expiresAt && job.expiresAt <= Date.now()) {
    return NextResponse.json({ error: "Hasil sudah kedaluwarsa" }, { status: 410, headers: { "Cache-Control": "no-store" } });
  }

  let body: { file?: unknown; rects?: unknown };
  try {
    body = (await req.json()) as { file?: unknown; rects?: unknown };
  } catch {
    return NextResponse.json({ error: "Body JSON tidak valid" }, { status: 400 });
  }
  const file = typeof body.file === "string" ? body.file : "";
  if (!file || !Array.isArray(body.rects)) {
    return NextResponse.json({ error: "file dan rects wajib diisi" }, { status: 400 });
  }
  if (body.rects.length > MAX_RECTS) {
    return NextResponse.json({ error: `Maksimal ${MAX_RECTS} kotak per halaman` }, { status: 400 });
  }

  const jobDir = path.join(OUT_DIR, jobId);
  const store = readRenderStore(jobDir);
  const page = store?.pages[file];
  if (!store || !page) {
    return NextResponse.json({ error: "Halaman tidak ditemukan" }, { status: 404 });
  }
  const sourceAbs = sourceFilePath(jobDir, page.sourceFile);
  if (!fs.existsSync(sourceAbs)) {
    return NextResponse.json({ error: "Sumber halaman sudah tidak tersedia" }, { status: 404 });
  }

  // Validasi + clamp kotak ke batas gambar. Kotak terlalu kecil dibuang
  // (bukan error) agar klik tak sengaja tidak menggagalkan seluruh simpan.
  const manualMasks: CleanArea[] = [];
  for (const raw of body.rects as RawRect[]) {
    const x0 = number(raw?.x0);
    const y0 = number(raw?.y0);
    const x1 = number(raw?.x1);
    const y1 = number(raw?.y1);
    if (x0 === null || y0 === null || x1 === null || y1 === null) continue;
    const left = Math.max(0, Math.min(x0, x1));
    const top = Math.max(0, Math.min(y0, y1));
    const right = Math.min(page.width, Math.max(x0, x1));
    const bottom = Math.min(page.height, Math.max(y0, y1));
    if (right - left < MIN_SIDE || bottom - top < MIN_SIDE) continue;
    manualMasks.push({
      bbox: { x0: left, y0: top, x1: right, y1: bottom },
      fallbackShape: "manual",
    });
  }

  const source = fs.readFileSync(sourceAbs);
  // Mask manual harus tetap terlihat walau halaman aslinya mode "none".
  const cleanMode = page.cleanMode === "none" ? "text" : page.cleanMode;
  const out = await overlayTranslations(source, page.items, {
    cleanMode,
    cleanAreas: [...page.cleanAreas, ...manualMasks],
  });
  fs.writeFileSync(path.join(jobDir, page.file), out);

  page.manualMasks = manualMasks;
  page.cleanMode = cleanMode;
  writeRenderStore(jobDir, store);

  // ZIP/PDF ikut diperbarui agar unduhan berikutnya memakai hasil koreksi.
  // Kalau pembuatan arsip gagal, PNG tetap tersimpan; laporkan agar user
  // tidak mengira ZIP/PDF sudah baru.
  let archivesUpdated = true;
  try {
    const files = (job.result?.pages?.length ? job.result.pages.map((p) => p.file) : Object.values(store.pages).map((p) => p.file));
    await buildJobArchives(jobDir, files);
  } catch (e) {
    archivesUpdated = false;
    console.error(`[mask] gagal memperbarui ZIP/PDF job ${jobId}:`, e);
  }

  return NextResponse.json(
    {
      ok: true,
      file: page.file,
      url: `/api/outputs/${jobId}/${encodeURIComponent(page.file)}`,
      version: Date.now(),
      manualMasks: manualMasks.length,
      archivesUpdated,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
