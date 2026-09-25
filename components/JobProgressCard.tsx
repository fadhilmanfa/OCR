"use client";

import type { JobProgress, JobStage, PageStage } from "./types";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Progress } from "@/components/ui/progress";

const STAGE_LABEL: Record<JobStage, string> = {
  upload: "Upload",
  normalize: "Normalisasi",
  bubble: "Deteksi bubble YOLO",
  ocr: "OCR",
  translate: "Terjemahan",
  overlay: "Overlay",
  finalize: "Finalisasi",
  done: "Selesai",
  error: "Gagal",
};

const PAGE_STAGE_LABEL: Record<PageStage, string> = {
  queue: "Antre",
  ocr: "OCR",
  translate: "Translate",
  overlay: "Overlay",
  done: "Selesai",
  error: "Gagal",
};

export default function JobProgressCard({
  progress,
  status,
}: {
  progress: JobProgress | null;
  status: string;
}) {
  const percent = Math.min(100, Math.max(0, progress?.percent ?? 3));
  const total = progress?.totalPages ?? 0;
  const current = progress?.currentPage ?? 0;
  const stageLabel = progress ? (STAGE_LABEL[progress.stage] ?? progress.stage) : "Menyiapkan...";

  return (
    <section aria-label="Progres pemrosesan" className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Memproses komik</h1>
          <p className="text-muted-foreground mt-1 text-xs">
            {stageLabel}{total > 0 && ` · Halaman ${Math.min(current + 1, total)}/${total}`}
          </p>
        </div>
        <span className="shrink-0 text-sm font-medium tabular-nums">
          {Math.round(percent)}%
        </span>
      </div>
      <Progress value={percent} aria-label="Progres pemrosesan" className="h-2" />
      {status && (
        <p role="status" className="text-muted-foreground text-xs leading-relaxed">
          {status}
        </p>
      )}
      <p className="text-muted-foreground text-xs">OCR dapat memakan 10–60 detik per halaman.</p>

      {progress && progress.pages.length > 0 && (
        <Accordion type="single" collapsible className="border-t">
          <AccordionItem value="pages" className="border-none">
            <AccordionTrigger className="py-3 text-xs hover:no-underline">
              Detail {progress.pages.length} halaman
            </AccordionTrigger>
            <AccordionContent>
              <ul className="max-h-64 divide-y overflow-y-auto">
                {progress.pages.map((p) => (
                  <li key={p.index} className="flex min-w-0 items-center gap-3 py-2 text-xs">
                    <span className="text-muted-foreground w-5 shrink-0 tabular-nums">{p.index + 1}</span>
                    <span className="min-w-0 flex-1 truncate" title={p.file}>{p.file}</span>
                    <span className="text-muted-foreground shrink-0">
                      {PAGE_STAGE_LABEL[p.stage] ?? p.stage}
                      {p.totalTexts > 0 && ` · ${p.translated}/${p.totalTexts}`}
                    </span>
                  </li>
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
    </section>
  );
}
