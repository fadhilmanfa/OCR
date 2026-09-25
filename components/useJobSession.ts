"use client";

import { useCallback, useEffect, useState } from "react";
import type { JobProgress, ProcessResult } from "./types";

export interface ProcessingSettings {
  provider: string;
  bubble: string;
  ocrEngine: string;
  apiKey: string;
  googleApiKey: string;
}

interface Session {
  jobId: string | null;
  settings: ProcessingSettings;
}

const STORAGE_KEY = "komik-ocr-session-v1";
const EMPTY_SESSION: Session = {
  jobId: null,
  settings: { provider: "auto", bubble: "ogkalu", ocrEngine: "tesseract", apiKey: "", googleApiKey: "" },
};

function readSession(): Session {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return EMPTY_SESSION;
  try {
    const saved = JSON.parse(raw);
    const settings = saved?.settings;
    return {
      jobId: typeof saved?.jobId === "string" && /^[a-z0-9]+$/i.test(saved.jobId) ? saved.jobId : null,
      settings: {
        provider: ["auto", "openrouter", "opencode"].includes(settings?.provider) ? settings.provider : "auto",
        bubble: ["ogkalu", "psimera", "google", "0"].includes(settings?.bubble) ? settings.bubble : "ogkalu",
        ocrEngine: ["tesseract", "comics_text_plus", "vision_llm", "google_vision"].includes(settings?.ocrEngine) ? settings.ocrEngine : "tesseract",
        apiKey: typeof settings?.apiKey === "string" ? settings.apiKey : "",
        googleApiKey: typeof settings?.googleApiKey === "string" ? settings.googleApiKey : "",
      },
    };
  } catch {
    return EMPTY_SESSION;
  }
}

export function useJobSession() {
  const [session, setSession] = useState<Session>(EMPTY_SESSION);
  const [ready, setReady] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const saved = readSession();
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        setSession(saved);
        setBusy(Boolean(saved.jobId));
        if (saved.jobId) setStatus("Memulihkan sesi...");
      } catch {
        setStorageUnavailable(true);
      }
      setReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  const saveSession = useCallback((next: Session) => {
    setSession(next);
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      setStorageUnavailable(true);
    }
  }, []);

  const clearJob = useCallback((message = "") => {
    saveSession({ ...session, jobId: null });
    setResult(null);
    setProgress(null);
    setBusy(false);
    setStatus(message);
  }, [saveSession, session]);

  useEffect(() => {
    if (!ready || !session.jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(session.jobId!)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (cancelled) return;
        if (response.status === 404 || response.status === 410) {
          clearJob("Hasil sudah kedaluwarsa atau tidak ditemukan. Silakan proses kembali.");
          return;
        }
        if (!response.ok) throw new Error("Status job belum dapat diambil");
        const job = await response.json() as JobProgress;
        if (cancelled) return;
        if (job.expiresAt && job.expiresAt <= Date.now()) {
          clearJob("Hasil sudah kedaluwarsa. Silakan proses kembali.");
          return;
        }
        setProgress(job);
        setStatus(job.message);
        if (job.done) {
          setBusy(false);
          if (job.error || !job.result) {
            clearJob("Gagal: " + (job.error || "Job selesai tanpa hasil"));
          } else {
            setResult(job.result);
            setRemainingSeconds(Math.max(0, Math.ceil(((job.result.expiresAt ?? Date.now()) - Date.now()) / 1000)));
          }
          return;
        }
        setBusy(true);
      } catch {
        if (cancelled) return;
        setStatus("Koneksi terputus. Mencoba mengambil status job kembali...");
      }
      if (!cancelled) timer = setTimeout(poll, 800);
    };
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [ready, session.jobId, clearJob]);

  useEffect(() => {
    if (!result?.expiresAt) return;
    const expiresAt = result.expiresAt;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setRemainingSeconds(remaining);
      if (remaining === 0) clearJob("Hasil sudah kedaluwarsa. Silakan proses kembali.");
    };
    const interval = setInterval(update, 1000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [result, clearJob]);

  return {
    ready, storageUnavailable, result, progress, status, busy, remainingSeconds,
    jobId: session.jobId,
    settings: session.settings,
    updateSettings: (settings: ProcessingSettings) => saveSession({ ...session, settings }),
    startNew: () => clearJob(),
    onJobStarted: (jobId: string) => {
      saveSession({ ...session, jobId });
      setBusy(true);
      setResult(null);
      setProgress(null);
      setStatus("Memproses komik...");
    },
  };
}
