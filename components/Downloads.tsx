import { Download, FileArchive, FileText } from "lucide-react";
import type { ProcessResult } from "./types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function Downloads({ result }: { result: ProcessResult }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Download className="size-4" />
          Hasil siap diunduh
        </CardTitle>
        <CardDescription>
          ZIP berisi semua gambar hasil + PDF gabungan per job.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <a href={result.zipUrl} download>
                <FileArchive />
                Download ZIP
              </a>
            </Button>
            <Button asChild variant="secondary">
              <a href={result.pdfUrl} download>
                <FileText />
                Download PDF
              </a>
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
            <Badge variant="outline">Job {result.jobId}</Badge>
            <Badge variant="secondary">{result.provider}</Badge>
            <Badge>{result.pages.length} halaman</Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
