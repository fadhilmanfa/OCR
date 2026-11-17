"use client";

import Link from "next/link";
import { BookOpenText } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

export type HeaderStatus = "idle" | "busy" | "result";

const STATUS_LABEL: Record<HeaderStatus, string> = {
  idle: "Siap",
  busy: "Memproses",
  result: "Hasil siap",
};

export default function AppHeader({
  status,
  summary,
}: {
  status: HeaderStatus;
  summary?: string;
}) {
  return (
    <header className="bg-background/85 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-40 border-b backdrop-blur">
      <a
        href="#konten"
        className="sr-only focus:not-sr-only focus:border-border focus:bg-background focus:fixed focus:top-3 focus:left-4 focus:z-50 focus:border focus:px-3 focus:py-2 focus:text-sm"
      >
        Lewati ke konten
      </a>
      <div className="relative mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div
          aria-hidden="true"
          className="halftone pointer-events-none absolute inset-y-0 right-0 w-64"
        />
        <Link
          href="/"
          className="group relative flex items-center gap-2.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="bg-foreground text-background flex size-8 shrink-0 items-center justify-center border">
            <BookOpenText aria-hidden="true" className="size-4" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="text-sm font-semibold tracking-tight">
              Komik OCR
            </span>
            <span className="text-muted-foreground mt-1 hidden font-mono text-[9px] uppercase tracking-[0.18em] sm:block">
              OCR / terjemahan / overlay
            </span>
          </span>
        </Link>

        <div className="relative flex items-center gap-2 sm:gap-3">
          {summary && (
            <span className="text-muted-foreground hidden font-mono text-[11px] tracking-tight lg:inline">
              {summary}
            </span>
          )}
          <span aria-hidden="true" className="bg-border hidden h-4 w-px sm:block" />
          <span
            aria-live="polite"
            className="border-border text-muted-foreground inline-flex items-center gap-1.5 border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em]"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 border border-current",
                status === "busy" && "bg-foreground animate-pulse",
                status === "result" && "bg-foreground"
              )}
            />
            <span className="hidden sm:inline">{STATUS_LABEL[status]}</span>
            <span className="sm:hidden">{STATUS_LABEL[status]}</span>
          </span>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
