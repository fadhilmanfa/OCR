import { Languages, ScanEye } from "lucide-react";
import type { ProcessPage } from "./types";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";

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
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm">
            Halaman {index + 1} —{" "}
            <span className="font-mono font-medium">{page.file}</span>
          </CardTitle>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Badge variant="secondary">
              <ScanEye />
              {viaLabel}
            </Badge>
            <Badge variant="outline">
              <Languages />
              {page.boxes.length} teks
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <figure className="space-y-1.5">
            <figcaption className="text-muted-foreground text-xs font-medium">
              Asli
            </figcaption>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={page.originalUrl}
              alt={`Asli halaman ${index + 1}`}
              className="w-full rounded-lg border object-contain"
              loading="lazy"
            />
          </figure>
          <figure className="space-y-1.5">
            <figcaption className="text-xs font-medium">
              Hasil ID{" "}
              <span className="text-muted-foreground font-normal">
                — teks asli dibersihkan & ditimpa
              </span>
            </figcaption>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={page.url}
              alt={`Hasil halaman ${index + 1}`}
              className="w-full rounded-lg border object-contain"
              loading="lazy"
            />
          </figure>
        </div>

        {page.boxes.length === 0 ? (
          <Alert>
            <AlertDescription>Tidak ada teks terdeteksi.</AlertDescription>
          </Alert>
        ) : (
          <Accordion type="single" collapsible className="rounded-lg border px-3">
            {page.boxes.map((b, i) => (
              <AccordionItem key={i} value={`box-${i}`}>
                <AccordionTrigger>
                  <span className="line-clamp-1 text-left text-[13px]">
                    <span className="text-muted-foreground mr-2 font-mono">
                      #{i + 1}
                    </span>
                    {b.en}
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="grid gap-2 text-[13px] leading-relaxed">
                    <p className="bg-muted/60 rounded-md px-2.5 py-2">
                      <span className="font-semibold">EN:</span> {b.en}
                    </p>
                    <p className="rounded-md border px-2.5 py-2">
                      <span className="font-semibold">ID:</span> {b.id}
                    </p>
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
}
