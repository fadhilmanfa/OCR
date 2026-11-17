"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import AppHeader, { type HeaderStatus } from "@/components/AppHeader";
import ControlPanel from "@/components/ControlPanel";
import Downloads from "@/components/Downloads";
import JobProgressCard from "@/components/JobProgressCard";
import PageCard from "@/components/PageCard";
import UploadDropzone from "@/components/UploadDropzone";
import { useFileQueue } from "@/components/useFileQueue";
import { useJobSession } from "@/components/useJobSession";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LANG_SHORT } from "@/lib/languages";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const RESULT_TTL_SECONDS = 10 * 60; // samakan dengan OUTPUT_TTL_MS di lib/jobs.ts
const WARNING_THRESHOLDS = [60, 180, 300]; // 1 mnt, 3 mnt, 5 mnt

const OCR_SHORT: Record<string, string> = {
  tesseract: "Tesseract",
  comics_text_plus: "Comics Text Plus",
  vision_llm: "Vision LLM",
  google_vision: "Google Vision",
};

// Menutup modal sekaligus menandai ambang tersebut DAN semua ambang di
// atasnya sebagai sudah tampil — momennya sudah lewat, jangan dimunculkan lagi.
function dismissThresholdAndAbove(prev: number[], w: number) {
  const next = new Set(prev);
  for (const t of WARNING_THRESHOLDS) {
    if (t >= w) next.add(t);
  }
  return [...next];
}

function PageHero() {
  return (
    <section className="relative isolate max-w-2xl">
      <div
        aria-hidden="true"
        className="halftone pointer-events-none absolute inset-x-0 -top-8 -bottom-4 -z-10"
      />
      <p className="eyebrow">OCR · Terjemahan · Overlay</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        Terjemahkan komik.
      </h1>
      <p className="text-muted-foreground mt-3 max-w-xl text-sm leading-relaxed sm:text-base">
        Unggah gambar atau arsip komik, pilih bahasa, lalu unduh hasilnya sebagai
        ZIP atau PDF.
      </p>
    </section>
  );
}

export default function Home() {
  const {
    ready, storageUnavailable, result, status, busy, progress, settings, jobId,
    updateSettings, onJobStarted, startNew: resetSession, remainingSeconds,
  } = useJobSession();
  const [uploading, setUploading] = useState(false);
  const queue = useFileQueue(busy || uploading);
  const submitting = useRef(false);
  const [resetting, setResetting] = useState(false);
  const [warning, setWarning] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<number[]>([]);
  const [closing, setClosing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmClosing, setConfirmClosing] = useState(false);
  const [prevJobId, setPrevJobId] = useState<string | null>(null);
  const [jobVersion, setJobVersion] = useState(0);
  const isError = status.startsWith("Gagal");
  const showForm = !busy && !result;
  const showResult = !busy && result !== null;
  const activeJobId = result?.jobId ?? null;

  // Reset modal per job baru + munculkan sekali per ambang 5/3/1 mnt.
  // Penyesuaian state saat render (bukan di effect) agar lolos aturan hooks.
  if (activeJobId !== prevJobId) {
    setPrevJobId(activeJobId);
    setWarning(null);
    setDismissed([]);
    setClosing(false);
    setJobVersion(0);
  } else if (showResult && warning === null && remainingSeconds > 0) {
    const hit = WARNING_THRESHOLDS.find((t) => remainingSeconds <= t && !dismissed.includes(t));
    if (hit !== undefined) setWarning(hit);
  }

  function closeWarning() {
    if (warning === null || closing) return;
    const w = warning;
    setClosing(true);
    window.setTimeout(() => {
      setDismissed((prev) => dismissThresholdAndAbove(prev, w));
      setWarning(null);
      setClosing(false);
    }, 180);
  }

  function closeConfirm() {
    if (!confirming || confirmClosing) return;
    setConfirmClosing(true);
    window.setTimeout(() => {
      setConfirming(false);
      setConfirmClosing(false);
    }, 180);
  }

  useEffect(() => {
    if ((warning === null || closing) && (!confirming || confirmClosing)) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (confirming && !confirmClosing) {
        setConfirmClosing(true);
        window.setTimeout(() => {
          setConfirming(false);
          setConfirmClosing(false);
        }, 180);
        return;
      }
      if (warning === null || closing) return;
      const w = warning;
      setClosing(true);
      window.setTimeout(() => {
        setDismissed((prev) => dismissThresholdAndAbove(prev, w));
        setWarning(null);
        setClosing(false);
      }, 180);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [warning, closing, confirming, confirmClosing]);

  async function handleProcess() {
    if (submitting.current || busy || uploading) return;
    if (!queue.files.length) {
      toast.error("Pilih file dulu", {
        description: "Upload JPG/PNG (boleh banyak) atau ZIP/RAR berisi gambar.",
      });
      return;
    }
    const cleanOnly = settings.mode === "clean";
    if (cleanOnly && (settings.bubble === "0" || settings.bubble === "google")) {
      toast.error("Mode bersih butuh deteksi bubble", {
        description: "Pilih Ogkalu atau Psimera — bukan Matikan/Google.",
      });
      return;
    }
    if (!cleanOnly && settings.sourceLang === settings.targetLang) {
      toast.error("Bahasa sumber dan target sama", {
        description: "Pilih pasangan bahasa yang berbeda.",
      });
      return;
    }

    const form = new FormData();
    for (const file of queue.files) form.append("files", file);
    form.append("provider", settings.provider);
    form.append("bubble", settings.bubble);
    form.append("ocrEngine", settings.ocrEngine);
    form.append("sourceLang", settings.sourceLang);
    form.append("targetLang", settings.targetLang);
    form.append("cleanMode", settings.cleanMode);
    form.append("mode", settings.mode);
    if (
      (settings.provider === "openrouter" || settings.ocrEngine === "vision_llm") &&
      settings.apiKey.trim()
    ) {
      form.append("apiKey", settings.apiKey.trim());
    }
    if (settings.ocrEngine === "google_vision" && (settings.googleApiKey ?? "").trim()) {
      form.append("googleApiKey", (settings.googleApiKey ?? "").trim());
    }

    submitting.current = true;
    setUploading(true);
    try {
      const response = await fetch("/api/jobs", { method: "POST", body: form });
      const started = await response.json();
      if (!response.ok) throw new Error(started.error || String(response.status));
      if (typeof started.jobId !== "string" || !/^[a-z0-9]+$/i.test(started.jobId)) {
        throw new Error("Server tidak mengembalikan jobId yang valid");
      }
      onJobStarted(started.jobId);
      queue.clear();
    } catch (error) {
      toast.error("Gagal memproses", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      submitting.current = false;
      setUploading(false);
    }
  }

  async function startNew() {
    if (resetting) return;
    setResetting(true);
    setConfirming(false);
    setConfirmClosing(false);
    try {
      if (jobId) {
        await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      }
    } catch {
      // abaikan, tetap reset sesi lokal agar user bisa mulai baru
    } finally {
      resetSession();
      queue.clear();
      setResetting(false);
    }
  }

  const headerStatus: HeaderStatus = busy ? "busy" : result ? "result" : "idle";
  const headerSummary =
    settings.mode === "clean"
      ? `Bersih · ${OCR_SHORT[settings.ocrEngine] ?? settings.ocrEngine}`
      : `${LANG_SHORT[settings.sourceLang]} → ${LANG_SHORT[settings.targetLang]} · ${OCR_SHORT[settings.ocrEngine] ?? settings.ocrEngine}`;

  if (!ready) {
    return (
      <>
        <AppHeader status="idle" summary="Memulihkan sesi…" />
        <main id="konten" className="flex-1">
          <div className="mx-auto w-full max-w-6xl px-4 pt-10 pb-28 sm:px-6 sm:pt-14">
            <PageHero />
            <div className="mt-8 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-x-8 lg:gap-y-6">
              <div className="min-w-0 space-y-4">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-3 w-16" />
                </div>
                <Skeleton className="h-64 w-full" />
              </div>
              <Skeleton className="h-[26rem] w-full lg:col-start-2" />
            </div>
            <p className="sr-only" role="status">
              Memulihkan sesi…
            </p>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader status={headerStatus} summary={headerSummary} />
      <main id="konten" className="flex-1">
        <div className="mx-auto w-full max-w-6xl px-4 pt-10 pb-28 sm:px-6 sm:pt-14">
          {storageUnavailable && (
            <Alert className="mb-8">
              <CircleAlert />
              <AlertTitle>Penyimpanan sesi tidak tersedia</AlertTitle>
              <AlertDescription>
                Halaman tetap dapat digunakan, tetapi sesi tidak dapat dipulihkan
                setelah refresh.
              </AlertDescription>
            </Alert>
          )}

          {showForm && <PageHero />}

          <div
            className={cn(
              "grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-x-8 lg:gap-y-6",
              showForm ? "mt-8" : "mt-6"
            )}
          >
            <div className="order-1 min-w-0 lg:order-none lg:col-start-1 lg:row-start-1">
              {showForm && (
                <div className="space-y-4">
                  <UploadDropzone
                    files={queue.files}
                    leaving={queue.leaving}
                    totalBytes={queue.totalBytes}
                    disabled={busy || uploading}
                    onAdd={queue.add}
                    onRemove={queue.remove}
                    onClear={queue.clear}
                  />
                  {status && (
                    <Alert variant={isError ? "destructive" : "default"}>
                      <CircleAlert />
                      <AlertTitle>{isError ? "Proses gagal" : "Status hasil"}</AlertTitle>
                      <AlertDescription>{status}</AlertDescription>
                    </Alert>
                  )}
                </div>
              )}
              {busy && <JobProgressCard progress={progress} status={status} />}
            </div>

            <div
              className={cn(
                "min-w-0 lg:order-none lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-stretch",
                result !== null ? "order-3" : "order-2"
              )}
            >
              <ControlPanel
                settings={settings}
                onSettingsChange={updateSettings}
                fileCount={queue.files.length}
                busy={busy}
                uploading={uploading}
                hasResult={result !== null}
                progressPercent={progress?.percent ?? 0}
                onProcess={() => void handleProcess()}
              />
            </div>

            <div
              id="hasil"
              className={cn(
                "order-1 min-w-0 scroll-mt-24 lg:order-none lg:col-start-1",
                result !== null ? "lg:row-start-1" : "lg:row-start-2"
              )}
            >
              {showResult && result !== null && (
                <div className="space-y-8">
                  <Downloads result={result} />
                  {result.pages.length > 0 && (
                    <section aria-labelledby="preview-title" className="space-y-5">
                      <div className="flex items-center justify-between gap-3 border-b pb-3">
                        <h2
                          id="preview-title"
                          className="text-sm font-semibold tracking-tight"
                        >
                          Preview hasil
                        </h2>
                        <span className="text-muted-foreground font-mono text-[10px] uppercase tracking-[0.14em]">
                          {result.pages.length} halaman
                        </span>
                      </div>
                      <div>
                        {result.pages.map((page, index) => (
                          <PageCard
                            key={`${page.file}-${index}`}
                            page={page}
                            index={index}
                            jobId={result.jobId}
                            sourceLang={result.sourceLang}
                            targetLang={result.targetLang}
                            viewVersion={jobVersion}
                            onJobSaved={setJobVersion}
                          />
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {showResult && (
        <footer className="bg-background/95 supports-[backdrop-filter]:bg-background/80 fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur">
          <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-end gap-3 px-4 sm:px-6">
            {(() => {
              const total = RESULT_TTL_SECONDS;
              const fraction = Math.min(1, Math.max(0, remainingSeconds / total));
              const mins = Math.floor(Math.max(0, remainingSeconds) / 60);
              const secs = Math.max(0, remainingSeconds) % 60;
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      role="timer"
                      aria-label={`Sisa ${mins} menit ${secs} detik sebelum dihapus`}
                      tabIndex={0}
                      className="relative flex h-10 w-28 cursor-help items-center justify-between gap-3 border px-2.5 font-mono text-[11px] outline-none"
                    >
                      <span className="text-muted-foreground text-[9px] uppercase tracking-[0.14em]">
                        Sisa
                      </span>
                      <span className="font-semibold tabular-nums">
                        {mins}:{String(secs).padStart(2, "0")}
                      </span>
                      <span
                        aria-hidden="true"
                        className="bg-muted absolute inset-x-0 bottom-0 h-0.5"
                      >
                        <span
                          className="bg-foreground block h-full transition-[width] duration-1000"
                          style={{ width: `${fraction * 100}%` }}
                        />
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-60">
                    Sisa {mins} menit {secs} detik lagi sebelum hasil dihapus otomatis.
                  </TooltipContent>
                </Tooltip>
              );
            })()}
            <Button type="button" onClick={() => setConfirming(true)} disabled={resetting} className="h-10 shrink-0">
              {resetting && <Loader2 className="animate-spin" />}
              {resetting ? "Menghapus..." : "Mulai Baru"}
            </Button>
          </div>
        </footer>
      )}

      {showResult && warning !== null && (
        <div role="dialog" aria-modal="true" aria-labelledby="expiry-title" className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Tutup peringatan"
            onClick={closeWarning}
            className={`absolute inset-0 cursor-default bg-black/50 ${closing ? "animate-out fade-out-0 duration-180" : "animate-in fade-in-0 duration-200"}`}
          />
          <div
            className={`bg-background relative w-full max-w-sm border-2 p-6 ${closing ? "animate-out fade-out-0 zoom-out-95 duration-180" : "animate-in fade-in-0 zoom-in-95 duration-200"}`}
          >
            <button
              type="button"
              onClick={closeWarning}
              aria-label="Tutup"
              className="text-muted-foreground hover:text-foreground hover:bg-accent absolute top-3 right-3 flex size-7 items-center justify-center border"
            >
              <X className="size-4" />
            </button>
            <p className="eyebrow mb-2">Batas waktu</p>
            <h2 id="expiry-title" className="text-base font-semibold tracking-tight">
              Sisa {Math.round(warning / 60)} menit
            </h2>
            <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
              Hasil akan segera dihapus otomatis. Unduh ZIP / PDF sekarang bila diperlukan.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={closeWarning} className="h-10">
                Mengerti
              </Button>
              <Button type="button" onClick={() => void startNew()} disabled={resetting} className="h-10">
                Mulai Baru
              </Button>
            </div>
          </div>
        </div>
      )}

      {showResult && confirming && (
        <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Batalkan"
            onClick={closeConfirm}
            className={`absolute inset-0 cursor-default bg-black/50 ${confirmClosing ? "animate-out fade-out-0 duration-180" : "animate-in fade-in-0 duration-200"}`}
          />
          <div
            className={`bg-background relative w-full max-w-sm border-2 p-6 ${confirmClosing ? "animate-out fade-out-0 zoom-out-95 duration-180" : "animate-in fade-in-0 zoom-in-95 duration-200"}`}
          >
            <button
              type="button"
              onClick={closeConfirm}
              aria-label="Tutup"
              className="text-muted-foreground hover:text-foreground hover:bg-accent absolute top-3 right-3 flex size-7 items-center justify-center border"
            >
              <X className="size-4" />
            </button>
            <p className="eyebrow mb-2">Konfirmasi</p>
            <h2 id="confirm-title" className="text-base font-semibold tracking-tight">
              Hapus hasil dan mulai baru?
            </h2>
            <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
              Hasil di server akan dihapus permanen dan tidak bisa dikembalikan. Lanjutkan?
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={closeConfirm} className="h-10">
                Batal
              </Button>
              <Button type="button" variant="destructive" onClick={() => void startNew()} disabled={resetting} className="h-10">
                {resetting ? "Menghapus..." : "Ya, hapus"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
