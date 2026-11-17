import { NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";
import { applyRescan } from "@/lib/rescan";

export const runtime = "nodejs";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };

// POST /api/jobs/<jobId>/rescan/apply
// Body: { token, selectedText?: string[], selectedMask?: string[] }
// Gabungkan pilihan per item dari pembanding lalu render ulang halaman.
export async function POST(
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

  let body: {
    token?: unknown;
    selectedText?: unknown;
    selectedMask?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body JSON tidak valid" }, { status: 400, headers: NO_STORE });
  }
  const token = typeof body.token === "string" ? body.token : "";
  if (!/^[a-f0-9]{32}$/.test(token)) {
    return NextResponse.json({ error: "Token pembanding tidak valid" }, { status: 400, headers: NO_STORE });
  }
  const selectedText = Array.isArray(body.selectedText)
    ? body.selectedText.filter((v): v is string => typeof v === "string")
    : undefined;
  const selectedMask = Array.isArray(body.selectedMask)
    ? body.selectedMask.filter((v): v is string => typeof v === "string")
    : undefined;

  try {
    const result = await applyRescan({ jobId, token, selectedText, selectedMask });
    return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: NO_STORE },
    );
  }
}
