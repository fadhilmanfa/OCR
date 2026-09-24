"use client";

import { Hourglass } from "lucide-react";
import type { JobProgress, JobStage, PageStage } from "./types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

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

function pageDot(stage: PageStage): string {
  switch (stage) {
    case "done":
      return "bg-emerald-500";
    case "ocr":
    case "translate":
    case "overlay":
      return "bg-amber-500 animate-pulse";
    case "error":
      return "bg-red-500";
    default:
      return "bg-muted-foreground/30";
  }
}

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
  const bubbleTotal = progress?.bubbleTotal;
  const stageLabel = progress ? (STAGE_LABEL[progress.stage] ?? progress.stage) : "Menyiapkan...";
  const translatedSum = (progress?.pages ?? []).reduce((s, p) => s + (p.translated || 0), 0);
  const textsSum = (progress?.pages ?? []).reduce((s, p) => s + (p.totalTexts || 0), 0);

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Hourglass className="size-4 animate-spin" />
          <span className="font-medium">Memproses… {Math.round(percent)}%</span>
          <Badge variant="secondary">{stageLabel}</Badge>
          {total > 0 && (
            <Badge variant="outline">
              Halaman {Math.min(current + 1, total)}/{total}
            </Badge>
          )}
          {bubbleTotal !== null && bubbleTotal !== undefined && (
            <Badge variant="outline">{bubbleTotal} bubble</Badge>
          )}
          {textsSum > 0 && (
            <Badge variant="outline">
              {translatedSum}/{textsSum} teks diterjemahkan
            </Badge>
          )}
          <span className="text-muted-foreground text-xs">
            OCR bisa 10–60 detik per halaman
          </span>
        </div>

        <Progress value={percent} className="h-1.5" />
        {status && (
          <p role="status" className="text-muted-foreground text-xs">
            {status}
          </p>
        )}

        {progress && progress.pages.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              Detail per halaman
            </p>
            <ul className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {progress.pages.map((p) => (
                <li
                  key={p.index}
                  className="bg-muted/40 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs"
                >
                  <span className={cn("size-2 shrink-0 rounded-full", pageDot(p.stage))} />
                  <span className="font-mono font-medium shrink-0">#{p.index + 1}</span>
                  <span className="min-w-0 flex-1 truncate" title={p.file}>
                    {p.file}
                  </span>
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {PAGE_STAGE_LABEL[p.stage] ?? p.stage}
                  </Badge>
                  {p.bubbleCount !== null && p.bubbleCount !== undefined && (
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {p.bubbleCount} bubble
                    </span>
                  )}
                  {p.totalTexts > 0 && (
                    <span className="shrink-0 tabular-nums">
                      {p.translated}/{p.totalTexts} teks
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
