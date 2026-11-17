import { NextResponse } from "next/server";
import fs from "fs";
import { getJob } from "@/lib/jobs";
import { rescanPreviewPath } from "@/lib/rescan";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/jobs/<jobId>/rescan/preview?token=...
// Gambar kandidat untuk pembanding side-by-side (belum diterapkan).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  if (!/^[a-z0-9]+$/i.test(jobId)) {
    return NextResponse.json({ error: "jobId tidak valid" }, { status: 400, headers: NO_STORE });
  }
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json(
      { error: "Hasil tidak ditemukan / sudah kedaluwarsa" },
      { status: 404, headers: NO_STORE },
    );
  }
  if (job.expiresAt && job.expiresAt <= Date.now()) {
    return NextResponse.json(
      { error: "Hasil sudah kedaluwarsa" },
      { status: 410, headers: NO_STORE },
    );
  }
  const token = new URL(req.url).searchParams.get("token") || "";
  const file = rescanPreviewPath(jobId, token);
  if (!file) {
    return NextResponse.json(
      { error: "Pembanding tidak ditemukan / sudah dibuang" },
      { status: 404, headers: NO_STORE },
    );
  }
  try {
    const buffer = fs.readFileSync(file);
    return new NextResponse(new Uint8Array(buffer), {
      headers: { ...NO_STORE, "Content-Type": "image/png" },
    });
  } catch {
    return NextResponse.json(
      { error: "Gagal membaca gambar pembanding" },
      { status: 500, headers: NO_STORE },
    );
  }
}
