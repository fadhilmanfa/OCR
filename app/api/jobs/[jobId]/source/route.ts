import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getJob } from "@/lib/jobs";
import { readRenderStore, sourceFilePath } from "@/lib/renderStore";

export const runtime = "nodejs";

const OUT_DIR = path.join(process.cwd(), "outputs");

// GET /api/jobs/<jobId>/source?file=<nama.png>
// Halaman ASLI (sebelum ditimpa) untuk background editor.
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
  const store = readRenderStore(path.join(OUT_DIR, jobId));
  const page = store?.pages[file];
  if (!page) {
    return NextResponse.json({ error: "Halaman tidak ditemukan" }, { status: 404 });
  }
  const abs = sourceFilePath(path.join(OUT_DIR, jobId), page.sourceFile);
  if (!fs.existsSync(abs)) {
    return NextResponse.json({ error: "Sumber halaman sudah tidak tersedia" }, { status: 404 });
  }
  const buf = fs.readFileSync(abs);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(buf.length),
      "Cache-Control": "no-store",
    },
  });
}
