"use client";

import { useState } from "react";
import { BookOpenText, Hourglass, ScanText, Sparkles } from "lucide-react";
import UploadForm from "@/components/UploadForm";
import Downloads from "@/components/Downloads";
import PageCard from "@/components/PageCard";
import type { ProcessResult } from "@/components/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";

export default function Home() {
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const isError = status.startsWith("Gagal");

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 md:py-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            <ScanText />
            OCR + Translate
          </Badge>
          <Badge variant="outline">
            <Sparkles />
            Bubble YOLO · Tesseract · LLM opsional
          </Badge>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-balance md:text-3xl">
          Komik OCR: Inggris → Indonesia
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed md:text-[15px]">
          Upload <span className="font-medium text-foreground">JPG/PNG</span>{" "}
          (banyak file bisa) atau{" "}
          <span className="font-medium text-foreground">ZIP</span> berisi
          gambar. Teks asli dihapus (putih) lalu ditimpa Bahasa Indonesia.
        </p>
      </section>

      <UploadForm
        onResult={setResult}
        onStatus={setStatus}
        disabled={busy}
        setDisabled={setBusy}
      />

      {busy && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center gap-2 text-sm">
              <Hourglass className="size-4 animate-spin" />
              <span className="font-medium">Memproses…</span>
              <span className="text-muted-foreground">
                OCR bisa 10–60 detik per halaman
              </span>
            </div>
            <Progress value={66} className="h-1.5" />
            {status && (
              <p role="status" className="text-muted-foreground text-xs">
                {status}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {!busy && status && (
        <Alert variant={isError ? "destructive" : "default"}>
          <BookOpenText />
          <AlertTitle>{isError ? "Terjadi kesalahan" : "Status"}</AlertTitle>
          <AlertDescription>{status}</AlertDescription>
        </Alert>
      )}

      {result && <Downloads result={result} />}

      {!busy && !result && !status && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="bg-muted flex size-11 items-center justify-center rounded-full">
              <BookOpenText className="size-5" />
            </span>
            <p className="text-sm font-medium">Belum ada hasil</p>
            <p className="text-muted-foreground max-w-sm text-xs leading-relaxed">
              Pilih gambar komik di atas lalu klik Proses. Preview before/after
              dan tombol download ZIP/PDF akan muncul di sini.
            </p>
          </CardContent>
        </Card>
      )}

      {result && result.pages.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold tracking-tight">
              Preview {result.pages.length} halaman
            </h2>
            <Separator className="flex-1" />
            <Badge variant="outline">{result.provider}</Badge>
          </div>
          <div className="grid gap-4">
            {result.pages.map((p, i) => (
              <PageCard key={`${p.file}-${i}`} page={p} index={i} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
