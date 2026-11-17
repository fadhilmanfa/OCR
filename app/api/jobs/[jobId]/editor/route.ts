import { NextResponse } from "next/server";
import path from "path";
import { getJob } from "@/lib/jobs";
import { normalizeFont } from "@/lib/fonts";
import { textAreaFor, type TextBoxOverride } from "@/lib/overlay";
import { readRenderStore } from "@/lib/renderStore";

export const runtime = "nodejs";

const OUT_DIR = path.join(process.cwd(), "outputs");

// GET /api/jobs/<jobId>/editor?file=<nama.png>
// Data untuk editor: ukuran, mask, goresan, font, kotak teks, dan URL gambar.
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
  if (!store || !page) {
    return NextResponse.json({ error: "Halaman tidak ditemukan atau tidak mendukung koreksi mask" }, { status: 404 });
  }

  const overrideMap = new Map<number, TextBoxOverride>();
  for (const override of page.textOverrides ?? []) overrideMap.set(override.index, override);

  return NextResponse.json(
    {
      file: page.file,
      width: page.width,
      height: page.height,
      cleanMode: page.cleanMode,
      undetected: page.undetected,
      resultUrl: `/api/outputs/${jobId}/${encodeURIComponent(page.file)}`,
      originalUrl: `/api/jobs/${jobId}/source?file=${encodeURIComponent(page.file)}`,
      textBaseUrl: `/api/jobs/${jobId}/textbase?file=${encodeURIComponent(page.file)}`,
      autoMasks: page.cleanAreas.map((a) => a.bbox),
      autoMaskEdits: page.autoMaskEdits ?? [],
      manualStrokes: page.manualStrokes ?? [],
      font: normalizeFont(page.font ?? store.font),
      fontScope: page.font ? "page" : "all",
      textItems: page.items.map((item, index) => {
        const override = overrideMap.get(index);
        return {
          index,
          text: override?.text ?? item.text,
          originalText: item.text,
          box: textAreaFor(item, override, page.width, page.height),
          defaultBox: textAreaFor(item, undefined, page.width, page.height),
          deleted: override?.deleted === true,
        };
      }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
