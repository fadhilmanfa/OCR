import { NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";

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
    return NextResponse.json({ error: "job tidak ditemukan / sudah kedaluwarsa" }, { status: 404 });
  }
  return NextResponse.json(job);
}
