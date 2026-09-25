import { NextResponse } from "next/server";
import { destroyJob, getJob } from "@/lib/jobs";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  if (!/^[a-z0-9]+$/i.test(jobId)) {
    return NextResponse.json({ error: "jobId tidak valid" }, { status: 400 });
  }
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "job tidak ditemukan / sudah kedaluwarsa" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (job.expiresAt && job.expiresAt <= Date.now()) {
    return NextResponse.json({ error: "Hasil sudah kedaluwarsa" }, { status: 410, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(job, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  if (!/^[a-z0-9]+$/i.test(jobId)) {
    return NextResponse.json({ error: "jobId tidak valid" }, { status: 400 });
  }
  const deleted = destroyJob(jobId);
  if (!deleted) {
    return NextResponse.json({ error: "job tidak ditemukan / sudah kedaluwarsa" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
