"use client";

import { useState } from "react";
import { CircleAlert } from "lucide-react";
import UploadForm from "@/components/UploadForm";
import Downloads from "@/components/Downloads";
import PageCard from "@/components/PageCard";
import JobProgressCard from "@/components/JobProgressCard";
import type { JobProgress, ProcessResult } from "@/components/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function Home() {
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const isError = status.startsWith("Gagal");
  const showForm = !busy && !result;
  const showResult = !busy && result !== null;

  function startNew() {
    setResult(null);
    setStatus("");
    setProgress(null);
    setFormVersion((version) => version + 1);
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 pt-8 pb-16 sm:px-6 sm:pt-12">
      {showForm && (
        <section className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Terjemahkan komik
          </h1>
          <p className="text-muted-foreground max-w-xl text-sm leading-relaxed sm:text-base">
            Unggah gambar atau arsip komik berbahasa Inggris. Baca hasil
            terjemahannya di sini, lalu unduh sebagai ZIP atau PDF.
          </p>
        </section>
      )}

      <div hidden={!showForm}>
        <UploadForm
          key={formVersion}
          onResult={setResult}
          onStatus={setStatus}
          onProgress={setProgress}
          disabled={busy}
          setDisabled={setBusy}
        />
      </div>

      {busy && <JobProgressCard progress={progress} status={status} />}

      {showForm && isError && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Proses gagal</AlertTitle>
          <AlertDescription>{status}</AlertDescription>
        </Alert>
      )}

      {showResult && <Downloads result={result} onReset={startNew} />}

      {showResult && result.pages.length > 0 && (
        <section aria-labelledby="preview-title" className="space-y-5">
          <h2 id="preview-title" className="text-base font-semibold tracking-tight">
            Preview hasil
          </h2>
          <div>
            {result.pages.map((p, i) => (
              <PageCard key={`${p.file}-${i}`} page={p} index={i} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
