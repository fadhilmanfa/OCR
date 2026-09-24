// Store progress job in-memory (cukup untuk dev lokal / single instance).
// Untuk produksi multi-instance, ganti dengan Redis/DB atau file
// outputs/<jobId>/progress.json — interface di bawah tetap sama.
import type { JobProgress, JobStage, PageProgress, ProcessResult } from "@/components/types";

const jobs = new Map<string, JobProgress>();
const TTL_MS = 30 * 60 * 1000; // 30 menit
const lastTouched = new Map<string, number>();

function touch(jobId: string) {
  lastTouched.set(jobId, Date.now());
}

function sweep() {
  const now = Date.now();
  for (const [id, t] of lastTouched) {
    if (now - t > TTL_MS) {
      jobs.delete(id);
      lastTouched.delete(id);
    }
  }
}

export function createJob(jobId: string, totalPages = 0): JobProgress {
  sweep();
  const state: JobProgress = {
    jobId,
    percent: 0,
    stage: "upload",
    message: "Menyiapkan job...",
    currentPage: 0,
    totalPages,
    bubbleTotal: null,
    pages: [],
    done: false,
  };
  jobs.set(jobId, state);
  touch(jobId);
  return state;
}

export function getJob(jobId: string): JobProgress | undefined {
  const j = jobs.get(jobId);
  if (j) touch(jobId);
  return j;
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}

export function patchJob(
  jobId: string,
  patch: Partial<Omit<JobProgress, "jobId" | "pages">> & { pages?: PageProgress[] },
): JobProgress | undefined {
  const cur = jobs.get(jobId);
  if (!cur) return undefined;
  const next: JobProgress = {
    ...cur,
    ...patch,
    jobId: cur.jobId,
    pages: patch.pages ?? cur.pages,
    percent: patch.percent !== undefined ? clamp(patch.percent) : cur.percent,
  };
  jobs.set(jobId, next);
  touch(jobId);
  return next;
}

export function initPages(jobId: string, files: string[]): JobProgress | undefined {
  const pages: PageProgress[] = files.map((file, index) => ({
    index,
    file,
    stage: "queue",
    bubbleCount: null,
    ocrTexts: 0,
    translated: 0,
    totalTexts: 0,
  }));
  return patchJob(jobId, { totalPages: files.length, pages });
}

export function patchPage(
  jobId: string,
  index: number,
  patch: Partial<Omit<PageProgress, "index">>,
): JobProgress | undefined {
  const cur = jobs.get(jobId);
  if (!cur) return undefined;
  const pages = cur.pages.map((p) => (p.index === index ? { ...p, ...patch } : p));
  jobs.set(jobId, { ...cur, pages });
  touch(jobId);
  return jobs.get(jobId);
}

export function setStage(
  jobId: string,
  stage: JobStage,
  message: string,
  percent?: number,
  extra?: Partial<JobProgress>,
): JobProgress | undefined {
  return patchJob(jobId, { stage, message, ...(percent !== undefined ? { percent } : {}), ...extra });
}

export function completeJob(jobId: string, result: ProcessResult): JobProgress | undefined {
  return patchJob(jobId, {
    percent: 100,
    stage: "done",
    message: `Selesai: ${result.pages.length} halaman`,
    currentPage: result.pages.length,
    totalPages: result.pages.length,
    done: true,
    result,
  });
}

export function failJob(jobId: string, error: string): JobProgress | undefined {
  return patchJob(jobId, { stage: "error", message: "Gagal: " + error, done: true, error });
}
