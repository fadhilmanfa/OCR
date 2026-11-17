"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import type { ProcessPage } from "./types";
import MaskEditor from "./MaskEditor";

export default function PageThumb({
  page,
  index,
  jobId,
  viewVersion = 0,
  width,
  pageFiles,
  onJobSaved,
  onPageUpdated,
  apiKey,
  googleApiKey,
}: {
  page: ProcessPage;
  index: number;
  jobId: string;
  viewVersion?: number;
  width: number;
  pageFiles?: string[];
  onJobSaved?: (version: number) => void;
  onPageUpdated?: (page: ProcessPage) => void;
  apiKey?: string;
  googleApiKey?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0);
  const shownVersion = Math.max(version, viewVersion);
  const undetected = page.undetected ?? 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setEditing(true)}
        style={{ width: `min(100%, ${width}px)` }}
        aria-label={`Koreksi mask halaman ${index + 1}: ${page.file}`}
        className="group bg-muted relative aspect-[3/4] shrink-0 grow-0 cursor-pointer overflow-hidden border text-left transition-[width] duration-200 ease-out outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={shownVersion ? `${page.url}?v=${shownVersion}` : page.url}
          alt={`Hasil halaman ${index + 1}`}
          loading="lazy"
          className="size-full object-cover"
        />
        <span className="bg-background/90 absolute top-1.5 left-1.5 border px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
          {index + 1}
        </span>
        {undetected > 0 && (
          <span
            className="bg-background/90 absolute top-1.5 right-1.5 border px-1.5 py-0.5 font-mono text-[10px]"
            title="Bubble tanpa teks OCR dibiarkan utuh"
          >
            {undetected}
          </span>
        )}
        <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
          <span className="min-w-0 truncate text-[10px] text-white">
            {page.file}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-white">
            <Pencil aria-hidden="true" className="size-3" />
            Koreksi
          </span>
        </span>
      </button>

      {editing && (
        <MaskEditor
          jobId={jobId}
          file={page.file}
          pageFiles={pageFiles}
          onClose={() => setEditing(false)}
          onPageUpdated={onPageUpdated}
          apiKey={apiKey}
          googleApiKey={googleApiKey}
          onSaved={(nextVersion, archivesUpdated, pagesUpdated) => {
            setVersion(nextVersion);
            // Halaman yang disimpan bisa berbeda dari kartu yang membuka editor.
            onJobSaved?.(nextVersion);
            toast.success("Koreksi diterapkan", {
              description:
                pagesUpdated > 1
                  ? `Font diterapkan ke ${pagesUpdated} halaman. ${
                      archivesUpdated
                        ? "ZIP/PDF ikut diperbarui."
                        : "ZIP/PDF gagal diperbarui — unduh ulang nanti."
                    }`
                  : archivesUpdated
                    ? "Koreksi diterapkan. ZIP/PDF ikut diperbarui."
                    : "Koreksi diterapkan. ZIP/PDF gagal diperbarui — unduh ulang nanti.",
            });
          }}
        />
      )}
    </>
  );
}
