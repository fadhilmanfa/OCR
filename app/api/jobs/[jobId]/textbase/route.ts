import { NextResponse } from "next/server";
import path from "path";
import { getJob } from "@/lib/jobs";
import { renderStoredPage } from "@/lib/renderPage";
import { readRenderStore } from "@/lib/renderStore";

export const runtime = "nodejs";
export const maxDuration = 120;

const OUT_DIR = path.join(process.cwd(), "outputs");

// GET /api/jobs/<jobId>/textbase?file=<nama.png>
// Gambar dasar workspace teks: halaman ASLI + mask + goresan, TANPA teks
// terjemahan. Editor menggambar ulang teks di atasnya sesuai font & kotak
// yang sedang dipilih (live preview).
export async function GET(
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
  const file = new URL(req.url).searchParams.get("file") || "";
  const jobDir = path.join(OUT_DIR, jobId);
  const store = readRenderStore(jobDir);
  const page = store?.pages[file];
  if (!store || !page) {
    return NextResponse.json({ error: "Halaman tidak ditemukan" }, { status: 404 });
  }

  try {
    const buf = await renderStoredPage(jobDir, page, store, { withText: false, write: false });
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error(`[textbase] gagal render job ${jobId} file ${file}:`, e);
    return NextResponse.json({ error: "Gagal membuat pratinjau teks" }, { status: 500 });
  }
}
