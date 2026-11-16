"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Rect = { x0: number; y0: number; x1: number; y1: number };
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

interface EditorData {
  file: string;
  width: number;
  height: number;
  cleanMode: string;
  undetected: number;
  resultUrl: string;
  originalUrl: string;
  autoMasks: Rect[];
  manualMasks: Rect[];
}

interface DragState {
  mode: "create" | "move" | "resize";
  startX: number;
  startY: number;
  origin?: Rect;
  index?: number;
  handle?: Handle;
  moved: boolean;
  current?: Rect;
}

const HANDLE_SIZE = 10;

function normalize(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

function clampRect(r: Rect, W: number, H: number): Rect {
  const x0 = Math.max(0, Math.min(W, r.x0));
  const y0 = Math.max(0, Math.min(H, r.y0));
  const x1 = Math.max(0, Math.min(W, r.x1));
  const y1 = Math.max(0, Math.min(H, r.y1));
  return { x0, y0, x1, y1 };
}

export default function MaskEditor({  jobId,
  file,
  onClose,
  onSaved,
}: {
  jobId: string;
  file: string;
  onClose: () => void;
  onSaved: (version: number, archivesUpdated: boolean) => void;
}) {
  const [data, setData] = useState<EditorData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [bg, setBg] = useState<"result" | "original">("result");
  const [rects, setRects] = useState<Rect[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/jobs/${encodeURIComponent(jobId)}/editor?file=${encodeURIComponent(file)}`,
          { cache: "no-store" },
        );
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Gagal memuat data halaman");
        if (cancelled) return;
        setData(body as EditorData);
        setRects(Array.isArray(body.manualMasks) ? body.manualMasks : []);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, file]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const point = useCallback((e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const box = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) / Math.max(1, box.width)) * (data?.width || 1),
      y: ((e.clientY - box.top) / Math.max(1, box.height)) * (data?.height || 1),
    };
  }, [data]);

  const deleteSelected = useCallback(() => {
    if (selected === null) return;
    setRects((prev) => prev.filter((_, i) => i !== selected));
    setSelected(null);
  }, [selected]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (saving) return;
        onClose();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected !== null) {
        const target = e.target as HTMLElement | null;
        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
        e.preventDefault();
        deleteSelected();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, onClose, saving, selected]);

  function startCreate(e: React.PointerEvent<SVGElement>) {
    if (!data) return;
    svgRef.current?.setPointerCapture(e.pointerId);
    const p = point(e);
    dragRef.current = { mode: "create", startX: p.x, startY: p.y, moved: false };
    setSelected(null);
    setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  }

  function startMove(e: React.PointerEvent, index: number) {
    if (!data) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    const p = point(e);
    dragRef.current = {
      mode: "move",
      startX: p.x,
      startY: p.y,
      origin: rects[index],
      index,
      moved: false,
    };
    setSelected(index);
  }

  function startResize(e: React.PointerEvent, index: number, handle: Handle) {
    if (!data) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    const p = point(e);
    dragRef.current = {
      mode: "resize",
      startX: p.x,
      startY: p.y,
      origin: rects[index],
      index,
      handle,
      moved: false,
    };
    setSelected(index);
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || !data) return;
    const p = point(e);
    const dx = p.x - drag.startX;
    const dy = p.y - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;

    if (drag.mode === "create") {
      const [x0, x1] = normalize(drag.startX, p.x);
      const [y0, y1] = normalize(drag.startY, p.y);
      const next = clampRect({ x0, y0, x1, y1 }, data.width, data.height);
      drag.current = next;
      setDraft(next);
      return;
    }
    if (drag.origin === undefined || drag.index === undefined) return;
    let next: Rect = { ...drag.origin };
    if (drag.mode === "move") {
      const w = drag.origin.x1 - drag.origin.x0;
      const h = drag.origin.y1 - drag.origin.y0;
      const x0 = Math.max(0, Math.min(data.width - w, drag.origin.x0 + dx));
      const y0 = Math.max(0, Math.min(data.height - h, drag.origin.y0 + dy));
      next = { x0, y0, x1: x0 + w, y1: y0 + h };
    } else {
      const h = drag.handle!;
      if (h.includes("w")) next.x0 = drag.origin.x0 + dx;
      if (h.includes("e")) next.x1 = drag.origin.x1 + dx;
      if (h.includes("n")) next.y0 = drag.origin.y0 + dy;
      if (h.includes("s")) next.y1 = drag.origin.y1 + dy;
      if (next.x1 - next.x0 < 4) {
        if (h.includes("w")) next.x0 = next.x1 - 4;
        else next.x1 = next.x0 + 4;
      }
      if (next.y1 - next.y0 < 4) {
        if (h.includes("n")) next.y0 = next.y1 - 4;
        else next.y1 = next.y0 + 4;
      }
      next = clampRect(next, data.width, data.height);
    }
    const index = drag.index;
    setRects((prev) => prev.map((r, i) => (i === index ? next : r)));
  }

  function onPointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !data) return;
    if (drag.mode !== "create") return;
    const current = drag.current ?? draft;
    setDraft(null);
    if (!current) return;
    const w = current.x1 - current.x0;
    const h = current.y1 - current.y0;
    if (w >= 4 && h >= 4 && drag.moved) {
      setRects((prev) => [...prev.slice(0, 99), current]);
      setSelected(Math.min(rects.length, 99));
      return;
    }
    // Klik tanpa drag = kotak default yang bisa langsung digeser/di-resize.
    const bw = Math.min(data.width, Math.max(24, data.width * 0.22));
    const bh = Math.min(data.height, Math.max(16, data.height * 0.07));
    const x0 = Math.max(0, Math.min(data.width - bw, drag.startX - bw / 2));
    const y0 = Math.max(0, Math.min(data.height - bh, drag.startY - bh / 2));
    const box = { x0, y0, x1: x0 + bw, y1: y0 + bh };
    setRects((prev) => [...prev.slice(0, 99), box]);
    setSelected(Math.min(rects.length, 99));
  }

  function addBox() {
    if (!data) return;
    const bw = Math.min(data.width, Math.max(24, data.width * 0.22));
    const bh = Math.min(data.height, Math.max(16, data.height * 0.07));
    const box = {
      x0: Math.max(0, (data.width - bw) / 2),
      y0: Math.max(0, (data.height - bh) / 2),
      x1: Math.min(data.width, (data.width + bw) / 2),
      y1: Math.min(data.height, (data.height + bh) / 2),
    };
    setRects((prev) => [...prev.slice(0, 99), box]);
    setSelected(rects.length);
  }

  async function apply() {
    if (!data || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/mask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: data.file, rects }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Gagal menyimpan mask");
      onSaved(Number(body.version) || Date.now(), body.archivesUpdated !== false);
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mask-editor-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4"
    >
      <button
        type="button"
        aria-label="Tutup editor"
        onClick={() => !saving && onClose()}
        className="absolute inset-0 cursor-default bg-black/60"
      />
      <div className="bg-background relative flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border shadow-xl">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="mask-editor-title" className="truncate text-sm font-semibold">
              Koreksi mask — {data?.file || file}
            </h2>
            <p className="text-muted-foreground text-xs">
              Tarik untuk membuat kotak, geser untuk memindah, tarik handle untuk mengubah ukuran.
            </p>
          </div>
          {data && data.undetected > 0 && (
            <Badge variant="secondary" className="shrink-0">
              {data.undetected} bubble tak terdeteksi
            </Badge>
          )}
          <Button type="button" variant="ghost" size="icon" aria-label="Tutup" onClick={onClose} disabled={saving}>
            <X />
          </Button>
        </header>

        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <div className="bg-muted flex rounded-md p-0.5" role="group" aria-label="Latar editor">
            {(["result", "original"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setBg(mode)}
                className={`rounded px-2.5 py-1 text-xs font-medium ${bg === mode ? "bg-background shadow-sm" : "text-muted-foreground"}`}
              >
                {mode === "result" ? "Hasil" : "Asli"}
              </button>
            ))}
          </div>
          <span className="text-muted-foreground text-xs">
            Kotak biru = mask manual · garis kuning = mask otomatis
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={addBox} disabled={!data || saving}>
              <Plus /> Kotak
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setRects([]);
                setSelected(null);
              }}
              disabled={!rects.length || saving}
            >
              <RotateCcw /> Reset
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={deleteSelected} disabled={selected === null || saving}>
              <Trash2 /> Hapus
            </Button>
          </div>
        </div>

        <div className="bg-muted/40 flex min-h-0 flex-1 justify-center overflow-auto p-2 sm:p-3">
          {loadError ? (
            <p className="text-destructive self-center p-6 text-sm">{loadError}</p>
          ) : !data ? (
            <div className="text-muted-foreground flex items-center gap-2 self-center p-6 text-sm">
              <Loader2 className="animate-spin" /> Memuat halaman...
            </div>
          ) : (
            <div className="relative inline-block max-w-full self-start">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={bg === "result" ? `${data.resultUrl}?v=${data.width}-${data.height}` : data.originalUrl}
                alt={`Halaman ${data.file}`}
                className="block h-auto max-h-[64vh] w-auto max-w-full select-none rounded border"
                draggable={false}
              />
              <svg
                ref={svgRef}
                viewBox={`0 0 ${data.width} ${data.height}`}
                className="absolute inset-0 h-full w-full touch-none"
                onPointerDown={startCreate}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <rect
                  x={0}
                  y={0}
                  width={data.width}
                  height={data.height}
                  fill="transparent"
                  onPointerDown={startCreate}
                />
                {data.autoMasks.map((r, i) => (
                  <rect
                    key={`auto-${i}`}
                    x={r.x0}
                    y={r.y0}
                    width={Math.max(0, r.x1 - r.x0)}
                    height={Math.max(0, r.y1 - r.y0)}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth={Math.max(1, data.width / 900)}
                    strokeDasharray={`${Math.max(3, data.width / 300)} ${Math.max(3, data.width / 300)}`}
                    pointerEvents="none"
                  />
                ))}
                {rects.map((r, i) => (
                  <MaskRectView
                    key={`manual-${i}`}
                    rect={r}
                    index={i}
                    selected={i === selected}
                    pageWidth={data.width}
                    onMove={startMove}
                    onResize={startResize}
                  />
                ))}
                {draft && (
                  <rect
                    x={draft.x0}
                    y={draft.y0}
                    width={Math.max(0, draft.x1 - draft.x0)}
                    height={Math.max(0, draft.y1 - draft.y0)}
                    fill="rgba(37, 99, 235, 0.2)"
                    stroke="#2563eb"
                    strokeDasharray={`${Math.max(4, data.width / 220)} ${Math.max(3, data.width / 300)}`}
                    strokeWidth={Math.max(1.5, data.width / 700)}
                    pointerEvents="none"
                  />
                )}
              </svg>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
          {saveError && <p className="text-destructive w-full text-xs">{saveError}</p>}
          <p className="text-muted-foreground text-xs">
            {rects.length}/100 kotak · warna isi mengikuti mode bersih halaman.
          </p>
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Batal
            </Button>
            <Button type="button" onClick={() => void apply()} disabled={!data || saving}>
              {saving && <Loader2 className="animate-spin" />}
              {saving ? "Merender..." : "Terapkan"}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function MaskRectView({
  rect,
  index,
  selected,
  pageWidth,
  onMove,
  onResize,
}: {
  rect: Rect;
  index: number;
  selected: boolean;
  pageWidth: number;
  onMove: (e: React.PointerEvent, index: number) => void;
  onResize: (e: React.PointerEvent, index: number, handle: Handle) => void;
}) {
  return (
    <g>
      <rect
        x={rect.x0}
        y={rect.y0}
        width={Math.max(0, rect.x1 - rect.x0)}
        height={Math.max(0, rect.y1 - rect.y0)}
        fill={selected ? "rgba(37, 99, 235, 0.28)" : "rgba(37, 99, 235, 0.16)"}
        stroke={selected ? "#2563eb" : "#3b82f6"}
        strokeWidth={Math.max(1.5, pageWidth / 700)}
        style={{ cursor: "move" }}
        onPointerDown={(e) => onMove(e, index)}
      />
      {selected &&
        HANDLES.map((h) => {
          const cx = h.includes("w") ? rect.x0 : h.includes("e") ? rect.x1 : (rect.x0 + rect.x1) / 2;
          const cy = h.includes("n") ? rect.y0 : h.includes("s") ? rect.y1 : (rect.y0 + rect.y1) / 2;
          const cursor =
            h === "n" || h === "s" ? "ns-resize"
              : h === "e" || h === "w" ? "ew-resize"
                : h === "nw" || h === "se" ? "nwse-resize"
                  : "nesw-resize";
          const size = HANDLE_SIZE * (pageWidth / 900);
          return (
            <rect
              key={h}
              x={cx - size / 2}
              y={cy - size / 2}
              width={size}
              height={size}
              fill="#ffffff"
              stroke="#2563eb"
              strokeWidth={Math.max(1, pageWidth / 900)}
              style={{ cursor }}
              onPointerDown={(e) => onResize(e, index, h)}
            />
          );
        })}
    </g>
  );
}
