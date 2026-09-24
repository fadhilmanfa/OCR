import type { ProcessPage } from "./types";

export default function PageCard({
  page,
  index,
}: {
  page: ProcessPage;
  index: number;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        Halaman {index + 1} — {page.file}
      </h2>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <p className="mb-1 text-xs text-zinc-500">
            Asli
            {page.via?.startsWith("yolo") &&
              ` (kotak = ${page.bubbleCount ?? 0} bubble via ${page.via})`}
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={page.originalUrl}
            alt={`Asli halaman ${index + 1}`}
            className="w-full rounded-lg border border-zinc-100 dark:border-zinc-800"
          />
        </div>
        <div>
          <p className="mb-1 text-xs text-zinc-500">Hasil ID</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={page.url}
            alt={`Hasil halaman ${index + 1}`}
            className="w-full rounded-lg border border-zinc-100 dark:border-zinc-800"
          />
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {page.boxes.length === 0 && (
          <p className="text-xs text-zinc-500">Tidak ada teks terdeteksi.</p>
        )}
        {page.boxes.map((b, i) => (
          <div
            key={i}
            className="rounded-lg bg-zinc-50 p-2 text-[13px] leading-relaxed dark:bg-zinc-900"
          >
            <p>
              <span className="font-semibold">EN:</span> {b.en}
            </p>
            <p>
              <span className="font-semibold">ID:</span> {b.id}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
