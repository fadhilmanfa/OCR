import type { ProcessResult } from "./types";

export default function Downloads({ result }: { result: ProcessResult }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-center gap-3">
        <a href={result.zipUrl} download>
          <button className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
            Download ZIP
          </button>
        </a>
        <a href={result.pdfUrl} download>
          <button className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
            Download PDF
          </button>
        </a>
        <span className="text-xs text-zinc-500">
          Job {result.jobId} · provider {result.provider} ·{" "}
          {result.pages.length} halaman
        </span>
      </div>
    </div>
  );
}
