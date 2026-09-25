"use client";

import { useEffect, useState } from "react";
import { CircleAlert, Loader2, X } from "lucide-react";
import UploadForm from "@/components/UploadForm";
import Downloads from "@/components/Downloads";
import PageCard from "@/components/PageCard";
import JobProgressCard from "@/components/JobProgressCard";
import { useJobSession } from "@/components/useJobSession";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const RESULT_TTL_SECONDS = 10 * 60; // samakan dengan OUTPUT_TTL_MS di lib/jobs.ts
const WARNING_THRESHOLDS = [60, 180, 300]; // 1 mnt, 3 mnt, 5 mnt

// Menutup modal sekaligus menandai ambang tersebut DAN semua ambang di
// atasnya sebagai sudah tampil — momennya sudah lewat, jangan dimunculkan lagi.
function dismissThresholdAndAbove(prev: number[], w: number) {
  const next = new Set(prev);
  for (const t of WARNING_THRESHOLDS) {
    if (t >= w) next.add(t);
  }
  return [...next];
}

export default function Home() {
  const {
    ready, storageUnavailable, result, status, busy, progress, settings, jobId,
    updateSettings, onJobStarted, startNew: resetSession, remainingSeconds,
  } = useJobSession();
  const [formVersion, setFormVersion] = useState(0);
  const [resetting, setResetting] = useState(false);
  const [warning, setWarning] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<number[]>([]);
  const [closing, setClosing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmClosing, setConfirmClosing] = useState(false);
  const [prevJobId, setPrevJobId] = useState<string | null>(null);
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
      setFormVersion((version) => version + 1);
      setResetting(false);
    }
  }

  if (!ready) {
    return <p className="text-muted-foreground mx-auto max-w-3xl px-4 py-12 text-sm" role="status">Memulihkan sesi...</p>;
  }

  return (
    <>
      <div className="mx-auto w-full max-w-3xl space-y-8 px-4 pt-8 pb-16 sm:px-6 sm:pt-12">
        {storageUnavailable && (
          <Alert>
            <CircleAlert />
            <AlertTitle>Penyimpanan sesi tidak tersedia</AlertTitle>
            <AlertDescription>Halaman tetap dapat digunakan, tetapi sesi tidak dapat dipulihkan setelah refresh.</AlertDescription>
          </Alert>
        )}
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
            settings={settings}
            onSettingsChange={updateSettings}
            onJobStarted={onJobStarted}
            disabled={busy}
          />
        </div>

        {busy && <JobProgressCard progress={progress} status={status} />}

        {showForm && status && (
          <Alert variant={isError ? "destructive" : "default"}>
            <CircleAlert />
            <AlertTitle>{isError ? "Proses gagal" : "Status hasil"}</AlertTitle>
            <AlertDescription>{status}</AlertDescription>
          </Alert>
        )}

        {showResult && <Downloads result={result} />}

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
        {showResult && <div aria-hidden="true" className="h-16" />}
      </div>
      {showResult && (
        <footer className="bg-background/95 supports-[backdrop-filter]:bg-background/80 fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur">
          <div className="mx-auto flex h-16 w-full max-w-3xl items-center justify-end gap-3 px-4 sm:px-6">
            {(() => {
              const total = RESULT_TTL_SECONDS;
              const fraction = Math.min(1, Math.max(0, remainingSeconds / total));
              const radius = 16;
              const circumference = 2 * Math.PI * radius;
              const mins = Math.floor(Math.max(0, remainingSeconds) / 60);
              const secs = Math.max(0, remainingSeconds) % 60;
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      role="timer"
                      aria-label={`Sisa ${mins} menit ${secs} detik sebelum dihapus`}
                      tabIndex={0}
                      className="relative flex size-10 cursor-help items-center justify-center rounded-full outline-none"
                    >
                      <svg viewBox="0 0 40 40" aria-hidden="true" className="absolute inset-0 size-10 -rotate-90">
                        <circle
                          cx="20"
                          cy="20"
                          r={radius}
                          fill="none"
                          strokeWidth="4"
                          className="text-muted stroke-current opacity-40"
                        />
                        <circle
                          cx="20"
                          cy="20"
                          r={radius}
                          fill="none"
                          strokeWidth="4"
                          strokeLinecap="round"
                          strokeDasharray={circumference}
                          strokeDashoffset={circumference * (1 - fraction)}
                          className="text-primary stroke-current transition-[stroke-dashoffset] duration-1000"
                        />
                      </svg>
                      <span className="text-[8px] font-semibold tabular-nums">
                        {mins}:{String(secs).padStart(2, "0")}
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
            className={`bg-background relative w-full max-w-sm rounded-xl border p-6 shadow-lg ${closing ? "animate-out fade-out-0 zoom-out-95 duration-180" : "animate-in fade-in-0 zoom-in-95 duration-200"}`}
          >
            <button
              type="button"
              onClick={closeWarning}
              aria-label="Tutup"
              className="text-muted-foreground hover:text-foreground absolute top-3 right-3 rounded-full p-1"
            >
              <X className="size-4" />
            </button>
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
            className={`bg-background relative w-full max-w-sm rounded-xl border p-6 shadow-lg ${confirmClosing ? "animate-out fade-out-0 zoom-out-95 duration-180" : "animate-in fade-in-0 zoom-in-95 duration-200"}`}
          >
            <button
              type="button"
              onClick={closeConfirm}
              aria-label="Tutup"
              className="text-muted-foreground hover:text-foreground absolute top-3 right-3 rounded-full p-1"
            >
              <X className="size-4" />
            </button>
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
