import { NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";
import {
  createRescanCandidate,
  deleteRescanCandidate,
  type RescanAction,
} from "@/lib/rescan";

export const runtime = "nodejs";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };

// POST /api/jobs/<jobId>/rescan
// Body: { file, action, settings, apiKey?, googleApiKey? }
// Menghitung kandidat + preview TANPA menyentuh hasil. Client menampilkan
// pembanding lalu memanggil endpoint apply dengan pilihan per item.
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
    file?: unknown;
    action?: unknown;
    settings?: unknown;
    region?: unknown;
    apiKey?: unknown;
    googleApiKey?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body JSON tidak valid" }, { status: 400, headers: NO_STORE });
  }
  const file = typeof body.file === "string" ? body.file : "";
  const action = body.action;
  if (!file || (action !== "mask" && action !== "translate" && action !== "ocr_translate")) {
    return NextResponse.json(
      { error: "file dan action (mask/translate/ocr_translate) wajib diisi" },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const candidate = await createRescanCandidate({
      jobId,
      file,
      action: action as RescanAction,
      settings: body.settings,
      region: body.region,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
      googleApiKey: typeof body.googleApiKey === "string" ? body.googleApiKey : undefined,
    });
    return NextResponse.json(
      {
        ok: true,
        token: candidate.token,
        file: candidate.file,
        action: candidate.action,
        settings: candidate.settings,
        region: candidate.region,
        previewUrl: `/api/jobs/${jobId}/rescan/preview?token=${candidate.token}`,
        via: candidate.via,
        bubbleCount: candidate.bubbleCount,
        undetected: candidate.undetected,
        diff: candidate.diff,
      },
      { headers: NO_STORE },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: NO_STORE },
    );
  }
}

// DELETE /api/jobs/<jobId>/rescan?token=...
// Buang kandidat yang tidak jadi diterapkan.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  if (!/^[a-z0-9]+$/i.test(jobId)) {
    return NextResponse.json({ error: "jobId tidak valid" }, { status: 400, headers: NO_STORE });
  }
  const token = new URL(req.url).searchParams.get("token") || "";
  deleteRescanCandidate(jobId, token);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
