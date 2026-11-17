"use client";

import type { MouseEvent } from "react";
import { toast } from "sonner";
import { Download, FileArchive, FileText } from "lucide-react";
import type { ProcessResult } from "./types";
import { Button } from "@/components/ui/button";
import { LANG_SHORT, normalizeAppLang } from "@/lib/languages";

function downloadName(url: string, fallback: string) {
  const name = url.split("?")[0].split("/").pop();
  return name && name.includes(".") ? decodeURIComponent(name) : fallback;
}

async function downloadArchive(
  event: MouseEvent<HTMLAnchorElement>,
  url: string,
  label: string
) {
  event.preventDefault();
  const id = toast.loading(`Menyiapkan ${label}…`);
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Server menolak (${response.status})`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = downloadName(url, label.toLowerCase());
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Beri waktu browser memulai unduhan sebelum URL dibersihkan.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    toast.success(`${label} diunduh`, { id });
  } catch (error) {
    toast.error(`Gagal mengunduh ${label}`, {
      id,
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

export default function Downloads({
  result,
}: {
  result: ProcessResult;
}) {
  const src = LANG_SHORT[normalizeAppLang(result.sourceLang, "en")];
  const tgt = LANG_SHORT[normalizeAppLang(result.targetLang, "id")];
  return (
    <section aria-labelledby="download-title" className="space-y-5">
      <div>
        <h2 id="download-title" className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Download aria-hidden="true" className="size-5" />
          Hasil siap
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {result.pages.length} halaman · {src} → {tgt} · {result.provider}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button asChild className="h-11 sm:min-w-36">
          <a
            href={result.zipUrl}
            download
            onClick={(event) =>
              void downloadArchive(event, result.zipUrl, "ZIP")
            }
          >
            <FileArchive />
            Unduh ZIP
          </a>
        </Button>
        <Button asChild variant="outline" className="h-11 sm:min-w-36">
          <a
            href={result.pdfUrl}
            download
            onClick={(event) =>
              void downloadArchive(event, result.pdfUrl, "PDF")
            }
          >
            <FileText />
            Unduh PDF
          </a>
        </Button>
      </div>
    </section>
  );
}
