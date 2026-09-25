import fs from "node:fs";
import path from "node:path";
import type { JobProgress, JobStage, PageProgress, ProcessResult } from "@/components/types";

export const OUTPUT_TTL_MS = 10 * 60 * 1000;
export const OUTPUT_DIR = path.resolve(process.cwd(), "outputs");
const METADATA_FILE = ".job.json";
const jobGlobal = globalThis as typeof globalThis & {
  __ocrJobs?: {
    jobs: Map<string, JobProgress>;
    timers: Map<string, ReturnType<typeof setTimeout>>;
    interval?: ReturnType<typeof setInterval>;
  };
};
const store = jobGlobal.__ocrJobs ??= {
  jobs: new Map<string, JobProgress>(),
  timers: new Map<string, ReturnType<typeof setTimeout>>(),
};
const jobs = store.jobs;

function jobDirectory(jobId: string): string {
  if (!/^[a-z0-9]+$/i.test(jobId)) throw new Error("jobId tidak valid");
  const directory = path.resolve(OUTPUT_DIR, jobId);
  if (path.dirname(directory) !== OUTPUT_DIR) throw new Error("Lokasi output tidak valid");
  if (fs.existsSync(OUTPUT_DIR) && fs.lstatSync(OUTPUT_DIR).isSymbolicLink()) {
    throw new Error("Folder output tidak boleh berupa symlink");
  }
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error("Folder job tidak boleh berupa symlink");
  }
  return directory;
}

function persistJob(job: JobProgress) {
  const directory = jobDirectory(job.jobId);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, METADATA_FILE + ".tmp");
  fs.writeFileSync(temporary, JSON.stringify(job));
  fs.renameSync(temporary, path.join(directory, METADATA_FILE));
}

function deleteOutput(jobId: string) {
  const job = jobs.get(jobId);
  if (job && (!job.done || !job.expiresAt || job.expiresAt > Date.now())) return;
  try {
    fs.rmSync(jobDirectory(jobId), { recursive: true, force: true });
    jobs.delete(jobId);
    clearTimeout(store.timers.get(jobId));
    store.timers.delete(jobId);
  } catch {
    console.error(`[outputs] Gagal menghapus job ${jobId}; akan dicoba ulang.`);
  }
}

function scheduleCleanup(jobId: string, expiresAt: number) {
  clearTimeout(store.timers.get(jobId));
  if (expiresAt <= Date.now()) {
    deleteOutput(jobId);
    return;
  }
  const timer = setTimeout(() => deleteOutput(jobId), expiresAt - Date.now());
  timer.unref();
  store.timers.set(jobId, timer);
}

export function sweepOutputs() {
  try {
    if (!fs.existsSync(OUTPUT_DIR) || fs.lstatSync(OUTPUT_DIR).isSymbolicLink()) return;
    for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-z0-9]+$/i.test(entry.name)) continue;
      const current = jobs.get(entry.name);
      if (current) {
        if (current.done && current.expiresAt) scheduleCleanup(entry.name, current.expiresAt);
        continue;
      }
      const directory = jobDirectory(entry.name);
      const metadata = path.join(directory, METADATA_FILE);
      try {
        if (fs.lstatSync(metadata).isSymbolicLink()) continue;
        const saved = JSON.parse(fs.readFileSync(metadata, "utf8")) as JobProgress;
        if (saved.jobId !== entry.name || !Array.isArray(saved.pages) || typeof saved.done !== "boolean") {
          throw new Error("Metadata tidak valid");
        }
        if (saved.done && Number.isFinite(saved.expiresAt)) {
          jobs.set(entry.name, saved);
          scheduleCleanup(entry.name, saved.expiresAt!);
          continue;
        }
        if (!saved.done) {
          jobs.set(entry.name, saved);
          failJob(entry.name, "Proses terhenti karena server dimulai ulang. Silakan unggah kembali.");
          continue;
        }
      } catch {}
      scheduleCleanup(entry.name, fs.statSync(directory).mtimeMs + OUTPUT_TTL_MS);
    }
  } catch {
    console.error("[outputs] Pemeriksaan cleanup gagal; akan dicoba ulang.");
  }
}

export function startOutputCleanup() {
  if (store.interval) return;
  sweepOutputs();
  store.interval = setInterval(sweepOutputs, 60_000);
  store.interval.unref();
}

export function createJob(jobId: string, totalPages = 0): JobProgress {
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
  persistJob(state);
  jobs.set(jobId, state);
  return state;
}

export function getJob(jobId: string): JobProgress | undefined {
  return jobs.get(jobId);
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
  const expiresAt = Date.now() + OUTPUT_TTL_MS;
  const job = patchJob(jobId, {
    percent: 100,
    stage: "done",
    message: `Selesai: ${result.pages.length} halaman`,
    currentPage: result.pages.length,
    totalPages: result.pages.length,
    done: true,
    expiresAt,
    result: { ...result, expiresAt },
  });
  if (job) {
    scheduleCleanup(jobId, expiresAt);
    persistJob(job);
  }
  return job;
}

export function failJob(jobId: string, error: string): JobProgress | undefined {
  const expiresAt = Date.now() + OUTPUT_TTL_MS;
  const job = patchJob(jobId, { stage: "error", message: "Gagal: " + error, done: true, error, expiresAt });
  if (job) {
    scheduleCleanup(jobId, expiresAt);
    try {
      persistJob(job);
    } catch {
      console.error(`[outputs] Gagal menyimpan status job ${jobId}.`);
    }
  }
  return job;
}

export function destroyJob(jobId: string): boolean {
  try {
    const directory = jobDirectory(jobId);
    const hasMemory = jobs.has(jobId);
    const hasFolder = fs.existsSync(directory);
    if (!hasMemory && !hasFolder) return false;
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      console.error(`[outputs] Gagal menghapus folder job ${jobId}.`);
    }
    jobs.delete(jobId);
    clearTimeout(store.timers.get(jobId));
    store.timers.delete(jobId);
    return true;
  } catch {
    return false;
  }
}
