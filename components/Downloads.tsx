import { Download, FileArchive, FileText } from "lucide-react";
import type { ProcessResult } from "./types";
import { Button } from "@/components/ui/button";

export default function Downloads({
  result,
}: {
  result: ProcessResult;
}) {
  return (
    <section aria-labelledby="download-title" className="space-y-5">
      <div>
        <h1 id="download-title" className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Download aria-hidden="true" className="size-5" />
          Hasil siap
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {result.pages.length} halaman · {result.provider}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button asChild className="h-11 sm:min-w-36">
          <a href={result.zipUrl} download>
            <FileArchive />
            Unduh ZIP
          </a>
        </Button>
        <Button asChild variant="outline" className="h-11 sm:min-w-36">
          <a href={result.pdfUrl} download>
            <FileText />
            Unduh PDF
          </a>
        </Button>
      </div>
    </section>
  );
}
