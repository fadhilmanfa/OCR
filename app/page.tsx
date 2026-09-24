"use client";

import { useState } from "react";
import UploadForm from "@/components/UploadForm";
import Downloads from "@/components/Downloads";
import PageCard from "@/components/PageCard";
import type { ProcessResult } from "@/components/types";

export default function Home() {
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
          Komik OCR: Inggris → Indonesia
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Upload <b>JPG/PNG</b> (banyak file bisa) atau <b>ZIP</b> berisi
          gambar. Hasil: teks asli dihapus (putih) lalu ditimpa Bahasa
          Indonesia.
        </p>
      </header>

      <div className="space-y-4">
        <UploadForm
          onResult={setResult}
          onStatus={setStatus}
          disabled={busy}
          setDisabled={setBusy}
        />

        {status && (
          <p
            role="status"
            className="text-sm text-zinc-600 dark:text-zinc-400"
          >
            {status}
          </p>
        )}

        {result && <Downloads result={result} />}

        {result?.pages.map((p, i) => (
          <PageCard key={p.file + i} page={p} index={i} />
        ))}
      </div>
    </div>
  );
}
