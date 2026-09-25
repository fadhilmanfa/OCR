import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { getJob } from "@/lib/jobs";

export const runtime = "nodejs";

const OUT_DIR = path.join(process.cwd(), "outputs");

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".zip": "application/zip",
  ".pdf": "application/pdf",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string; file: string }> },
) {
  const { jobId, file } = await params;

  // Anti path-traversal: hanya nama file sederhana yang diizinkan
  // (mendukung nama asli seperti "One Piece 001.png").
  if (
    !/^[a-z0-9]+$/i.test(jobId) ||
    !file ||
    file.includes("/") ||
    file.includes("\\") ||
    file.includes("..")
  ) {
    return NextResponse.json({ error: "file tidak valid" }, { status: 400 });
  }

  const abs = path.join(OUT_DIR, jobId, file);
  if (!abs.startsWith(OUT_DIR + path.sep)) {
    return NextResponse.json({ error: "file tidak valid" }, { status: 400 });
  }

  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Hasil tidak ditemukan / sudah kedaluwarsa" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (job.expiresAt && job.expiresAt <= Date.now()) {
    return NextResponse.json({ error: "Hasil sudah kedaluwarsa" }, { status: 410, headers: { "Cache-Control": "no-store" } });
  }
  const ext = path.extname(file).toLowerCase();
  if (!MIME[ext]) {
    return NextResponse.json({ error: "file tidak valid" }, { status: 400 });
  }

  if (!fs.existsSync(abs)) {
    return NextResponse.json({ error: "file tidak ditemukan" }, { status: 404 });
  }
  if (fs.lstatSync(OUT_DIR).isSymbolicLink() || fs.lstatSync(path.dirname(abs)).isSymbolicLink() || fs.lstatSync(abs).isSymbolicLink()) {
    return NextResponse.json({ error: "file tidak valid" }, { status: 400 });
  }

  const buf = fs.readFileSync(abs);
  const type = MIME[ext] || "application/octet-stream";
  const isDownload = ext === ".zip" || ext === ".pdf";

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(buf.length),
      ...(isDownload
        ? { "Content-Disposition": `attachment; filename="${file}"` }
        : {}),
      "Cache-Control": "no-store",
    },
  });
}
