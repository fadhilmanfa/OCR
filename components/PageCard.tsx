"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import type { ProcessPage } from "./types";
import MaskEditor from "./MaskEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { LANG_SHORT, normalizeAppLang } from "@/lib/languages";

export default function PageCard({
  page,
  index,
  jobId,
  sourceLang,
  targetLang,
}: {
  page: ProcessPage;
  index: number;
  jobId: string;
  sourceLang?: unknown;
  targetLang?: unknown;
}) {
  const src = LANG_SHORT[normalizeAppLang(sourceLang, "en")];
  const tgt = LANG_SHORT[normalizeAppLang(targetLang, "id")];
  const isClean = page.via?.startsWith("clean");
  const viaLabel = isClean
    ? `${page.bubbleCount ?? 0} bubble ditimpa (mode bersih)`
    : page.via?.startsWith("yolo")
      ? `${page.bubbleCount ?? 0} bubble via ${page.via}`
      : (page.via ?? "ocr-full");
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState("");
  const undetected = page.undetected ?? 0;

  return (
    <article className="space-y-4 border-t py-6 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Halaman {index + 1}</h3>
          <p className="text-muted-foreground mt-0.5 truncate text-xs" title={page.file}>
            {page.file}
          </p>
        </div>
        {undetected > 0 && (
          <Badge variant="secondary" title="Bubble tanpa teks OCR dibiarkan utuh">
            {undetected} bubble tak terdeteksi
          </Badge>
        )}
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={version ? `${page.url}?v=${version}` : page.url}
        alt={isClean ? `Hasil pembersihan halaman ${index + 1}` : `Hasil terjemahan halaman ${index + 1}`}
        className="bg-muted w-full rounded-md border object-contain"
        loading="lazy"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
          <Pencil /> Koreksi mask
        </Button>
        {notice && <span className="text-muted-foreground text-xs">{notice}</span>}
      </div>
      {isClean ? (
        <p className="text-muted-foreground text-xs">
          Mode bersih: {page.bubbleCount ?? 0} bubble ditimpa, tanpa terjemahan.
        </p>
      ) : page.boxes.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          Tidak ada teks terdeteksi. Bubble dibiarkan utuh — pakai Koreksi mask bila ada teks yang terlewat.
        </p>
      ) : (
        <Accordion type="single" collapsible className="border-y">
          <AccordionItem value="texts" className="border-none">
            <AccordionTrigger className="py-3 text-sm hover:no-underline">
              Lihat teks terjemahan
            </AccordionTrigger>
            <AccordionContent>
              <p className="text-muted-foreground pb-2 text-xs">Diproses dengan {viaLabel}</p>
              <ol className="divide-y">
                {page.boxes.map((b, i) => (
                  <li key={i} className="grid gap-1 py-3 text-sm leading-relaxed">
                    <p><span className="text-muted-foreground mr-2 text-xs">{src}</span>{b.en}</p>
                    <p><span className="text-muted-foreground mr-2 text-xs">{tgt}</span>{b.id}</p>
                  </li>
                ))}
              </ol>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
      {editing && (
        <MaskEditor
          jobId={jobId}
          file={page.file}
          onClose={() => setEditing(false)}
          onSaved={(v, archivesUpdated) => {
            setVersion(v);
            setNotice(
              archivesUpdated
                ? "Mask diterapkan. ZIP/PDF ikut diperbarui."
                : "Mask diterapkan. ZIP/PDF gagal diperbarui — unduh ulang nanti.",
            );
          }}
        />
      )}
    </article>
  );
}
