import type { ProcessPage } from "./types";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

export default function PageCard({
  page,
  index,
}: {
  page: ProcessPage;
  index: number;
}) {
  const viaLabel = page.via?.startsWith("yolo")
    ? `${page.bubbleCount ?? 0} bubble via ${page.via}`
    : (page.via ?? "ocr-full");

  return (
    <article className="space-y-4 border-t py-6 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Halaman {index + 1}</h3>
          <p className="text-muted-foreground mt-0.5 truncate text-xs" title={page.file}>
            {page.file}
          </p>
        </div>
        <span className="text-muted-foreground shrink-0 text-xs">
          {page.boxes.length} teks
        </span>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={page.url}
        alt={`Hasil terjemahan halaman ${index + 1}`}
        className="bg-muted w-full rounded-md border object-contain"
        loading="lazy"
      />
      {page.boxes.length === 0 ? (
        <p className="text-muted-foreground text-xs">Tidak ada teks terdeteksi.</p>
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
                    <p><span className="text-muted-foreground mr-2 text-xs">EN</span>{b.en}</p>
                    <p><span className="text-muted-foreground mr-2 text-xs">ID</span>{b.id}</p>
                  </li>
                ))}
              </ol>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
    </article>
  );
}
