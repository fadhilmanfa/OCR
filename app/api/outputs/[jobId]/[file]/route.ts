import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";

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

  // Anti path-traversal: hanya nama file sederhana yang diizinkan.
  if (
    !/^[a-z0-9]+$/i.test(jobId) ||
    !/^[a-zA-Z0-9_.\-]+$/.test(file) ||
    file.includes("..")
  ) {
    return NextResponse.json({ error: "file tidak valid" }, { status: 400 });
  }

  const abs = path.join(OUT_DIR, jobId, file);
  if (!abs.startsWith(OUT_DIR + path.sep)) {
    return NextResponse.json({ error: "file tidak valid" }, { status: 400 });
  }

  if (!fs.existsSync(abs)) {
    return NextResponse.json({ error: "file tidak ditemukan" }, { status: 404 });
  }

  const buf = fs.readFileSync(abs);
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const isDownload = ext === ".zip" || ext === ".pdf";

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(buf.length),
      ...(isDownload
        ? { "Content-Disposition": `attachment; filename="${file}"` }
        : {}),
      "Cache-Control": "public, max-age=86400",
    },
  });
}
