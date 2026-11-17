"use client";

import { type ComponentType, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bold,
  BoxSelect,
  Check,
  Eraser,
  Eye,
  File,
  FileImage,
  Files,
  Loader2,
  Maximize2,
  Minimize2,
  Paintbrush,
  Redo2,
  RotateCcw,
  Scan,
  Trash2,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DEFAULT_FONT, FONT_FAMILIES, fontStack, type FontChoice } from "@/lib/fonts";
import { fitText } from "@/lib/textLayout";

type Point = [number, number];
type Tool = "paint" | "erase" | "auto";
type Tab = "mask" | "text";
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Stroke {
  mode: "paint" | "erase";
  size: number;
  points: Point[];
  /** Warna kertas preview (khusus editor; tidak dikirim ke server). */
  color?: string;
}

interface AutoBox {
  bbox: Rect;
  deleted: boolean;
}

interface AutoMaskEdit {
  index: number;
  bbox?: Rect;
  deleted?: boolean;
}

interface FontSettings extends FontChoice {
  scope: "page" | "all";
}

interface BoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TextBox {
  index: number;
  text: string;
  originalText: string;
  box: BoxRect;
  defaultBox: BoxRect;
  deleted: boolean;
}

interface Snapshot {
  strokes: Stroke[];
  autos: AutoBox[];
  texts: TextBox[];
}

interface EditorData {
  file: string;
  width: number;
  height: number;
  cleanMode: string;
  undetected: number;
  resultUrl: string;
  originalUrl: string;
  textBaseUrl?: string;
  autoMasks: Rect[];
  autoMaskEdits?: AutoMaskEdit[];
  manualStrokes?: Stroke[];
  font?: FontChoice;
  fontScope?: "page" | "all";
  textItems?: TextBox[];
}

const MAX_STROKES = 300;
const MAX_SIZE_PX = 500;
const MAX_HISTORY = 50;
const MIN_TEXT_BOX = 24;
const PREVIEW_MAX = 1600;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const BRUSH_MIN_RATIO = 0.0005;
const BRUSH_MAX_RATIO = 0.12;
const DEFAULT_BRUSH_RATIO = 0.02;
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

// Pilihan font terjemahan (daftar ada di lib/fonts agar sama dengan server).
const FONT_SCALES = [70, 80, 90, 100, 110, 120, 130];
const DEFAULT_FONT_SETTINGS: FontSettings = { ...DEFAULT_FONT, scope: "all" };

const LS = {
  fullscreen: "mask-editor:v1:fullscreen",
  tool: "mask-editor:v1:tool",
  brush: "mask-editor:v1:brush",
  tab: "mask-editor:v1:tab",
  draft: (jobId: string, file: string) => `mask-editor:v1:draft:${jobId}:${file}`,
};

function lsGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // localStorage bisa diblokir (mode privat / kuota penuh).
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampRect(r: Rect, w: number, h: number): Rect {
  return {
    x0: clamp(Math.min(r.x0, r.x1), 0, w),
    y0: clamp(Math.min(r.y0, r.y1), 0, h),
    x1: clamp(Math.max(r.x0, r.x1), 0, w),
    y1: clamp(Math.max(r.y0, r.y1), 0, h),
  };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

function sameBox(a: BoxRect, b: BoxRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function handlePoint(r: Rect, h: Handle): Point {
  const x = h.includes("w") ? r.x0 : h.includes("e") ? r.x1 : (r.x0 + r.x1) / 2;
  const y = h.includes("n") ? r.y0 : h.includes("s") ? r.y1 : (r.y0 + r.y1) / 2;
  return [x, y];
}

function hitHandle(r: Rect, x: number, y: number, tolerance: number): Handle | null {
  for (const h of HANDLES) {
    const [hx, hy] = handlePoint(r, h);
    if (Math.abs(x - hx) <= tolerance && Math.abs(y - hy) <= tolerance) return h;
  }
  return null;
}

function parseStrokes(value: unknown): Stroke[] {
  if (!Array.isArray(value)) return [];
  const strokes: Stroke[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as { mode?: unknown; size?: unknown; points?: unknown; color?: unknown };
    if ((raw.mode !== "paint" && raw.mode !== "erase") || typeof raw.size !== "number" || !Array.isArray(raw.points)) {
      continue;
    }
    const color =
      typeof raw.color === "string" && /^#[0-9a-f]{3,8}$/i.test(raw.color) ? raw.color : undefined;
    const points: Point[] = [];
    for (const point of raw.points) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const x = Number(point[0]);
      const y = Number(point[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
    }
    if (points.length) {
      strokes.push({ mode: raw.mode, size: clamp(raw.size, 1, MAX_SIZE_PX), points, color });
    }
  }
  return strokes;
}

function parseAutos(value: unknown): AutoBox[] | null {
  if (!Array.isArray(value)) return null;
  const autos: AutoBox[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const raw = item as { bbox?: Partial<Record<keyof Rect, unknown>>; deleted?: unknown };
    const b = raw.bbox;
    if (!b) return null;
    const x0 = Number(b.x0);
    const y0 = Number(b.y0);
    const x1 = Number(b.x1);
    const y1 = Number(b.y1);
    if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
    autos.push({ bbox: { x0, y0, x1, y1 }, deleted: raw.deleted === true });
  }
  return autos;
}

function parseBox(value: unknown): BoxRect | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Record<keyof BoxRect, unknown>>;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return { x, y, w, h };
}

function parseTextBoxes(value: unknown): TextBox[] | null {
  if (!Array.isArray(value)) return null;
  const texts: TextBox[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const raw = item as {
      index?: unknown;
      text?: unknown;
      originalText?: unknown;
      box?: unknown;
      defaultBox?: unknown;
      deleted?: unknown;
    };
    const index = Number(raw.index);
    const box = parseBox(raw.box);
    const defaultBox = parseBox(raw.defaultBox);
    if (!Number.isInteger(index) || typeof raw.text !== "string" || !box || !defaultBox) return null;
    texts.push({
      index,
      text: raw.text,
      originalText: typeof raw.originalText === "string" ? raw.originalText : raw.text,
      box,
      defaultBox,
      deleted: raw.deleted === true,
    });
  }
  return texts;
}

function parseDraft(
  raw: string | null,
): { strokes: Stroke[]; autos: AutoBox[] | null; texts: TextBox[] | null } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    // Draf lama (versi 1) hanya berisi array goresan.
    if (Array.isArray(parsed)) return { strokes: parseStrokes(parsed), autos: null, texts: null };
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as { strokes?: unknown; autos?: unknown; texts?: unknown };
    return {
      strokes: parseStrokes(obj.strokes),
      autos: parseAutos(obj.autos),
      texts: parseTextBoxes(obj.texts),
    };
  } catch {
    return null;
  }
}

function applyAutoEdits(boxes: AutoBox[], edits: AutoMaskEdit[] | undefined): AutoBox[] {
  return boxes.map((box, i) => {
    const edit = edits?.find((e) => e.index === i);
    if (!edit) return { bbox: { ...box.bbox }, deleted: false };
    if (edit.deleted) return { bbox: { ...box.bbox }, deleted: true };
    if (edit.bbox) return { bbox: { ...edit.bbox }, deleted: false };
    return { bbox: { ...box.bbox }, deleted: false };
  });
}

// Cache piksel gambar yang sedang tampil, dipakai untuk mengambil warna
// kertas di preview lokal (tanpa perlu render server).
interface PixelCache {
  data: ImageData;
  w: number;
  h: number;
  scale: number;
}

function makePixelCache(
  img: HTMLImageElement,
  w: number,
  h: number,
  pageWidth: number,
): PixelCache | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h), w, h, scale: w / pageWidth };
  } catch {
    return null;
  }
}

// Warna dominan (bukan rata-rata) di sekitar titik: kertas biasanya menutupi
// area terbesar, sedangkan garis/teks hanya minoritas.
function sampleDominant(
  cache: PixelCache | null,
  pageX: number,
  pageY: number,
  sizePage: number,
): string {
  if (!cache) return "#ffffff";
  const cx = Math.round(pageX * cache.scale);
  const cy = Math.round(pageY * cache.scale);
  const radius = Math.max(3, Math.round(sizePage * cache.scale * 1.5));
  const x0 = Math.max(0, cx - radius);
  const y0 = Math.max(0, cy - radius);
  const x1 = Math.min(cache.w, cx + radius);
  const y1 = Math.min(cache.h, cy + radius);
  if (x1 <= x0 || y1 <= y0) return "#ffffff";

  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 400)));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * cache.w + x) * 4;
      const r = cache.data.data[i];
      const g = cache.data.data[i + 1];
      const b = cache.data.data[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const cur = buckets.get(key);
      if (cur) {
        cur.n++;
        cur.r += r;
        cur.g += g;
        cur.b += b;
      } else {
        buckets.set(key, { n: 1, r, g, b });
      }
    }
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.n > best.n) best = bucket;
  }
  const chosen = best;
  if (!chosen) return "#ffffff";
  const toHex = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v / chosen.n))).toString(16).padStart(2, "0");
  return `#${toHex(chosen.r)}${toHex(chosen.g)}${toHex(chosen.b)}`;
}

// Tempel potongan gambar asli (untuk preview hapus/geser mask otomatis).
function drawOriginalCrop(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  bbox: Rect,
  scale: number,
): void {
  const x = Math.max(0, bbox.x0);
  const y = Math.max(0, bbox.y0);
  const w = Math.min(bbox.x1 - x, img.naturalWidth - x);
  const h = Math.min(bbox.y1 - y, img.naturalHeight - y);
  if (w <= 0 || h <= 0) return;
  ctx.drawImage(img, x, y, w, h, x * scale, y * scale, w * scale, h * scale);
}

function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, scale: number, color: string): void {
  if (!stroke.points.length) return;
  ctx.save();
  if (stroke.mode === "erase") ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, stroke.size * scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const [fx, fy] = stroke.points[0];
  if (stroke.points.length === 1) {
    ctx.beginPath();
    ctx.arc(fx * scale, fy * scale, Math.max(0.5, (stroke.size * scale) / 2), 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(fx * scale, fy * scale);
    for (let i = 1; i < stroke.points.length; i++) {
      const [x, y] = stroke.points[i];
      ctx.lineTo(x * scale, y * scale);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// Grup ribbon bergaya Word: kontrol sejajar, judul kecil di bawah, garis
// pemisah vertikal antar grup.
function RibbonGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex shrink-0 flex-col justify-between border-r px-1.5 py-1.5 last:border-r-0"
    >
      <div className="flex flex-1 items-center gap-0.5">{children}</div>
      <p className="text-muted-foreground mt-1 truncate text-center text-[10px] font-medium tracking-wide uppercase">
        {label}
      </p>
    </div>
  );
}

function RibbonButton({
  icon: Icon,
  label,
  title,
  active,
  disabled,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={title ?? label}
      aria-pressed={active}
      className={`flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-md px-1 text-[11px] leading-tight transition-colors disabled:pointer-events-none disabled:opacity-40 ${
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
      }`}
    >
      <Icon className="size-4" />
      <span className="w-full truncate text-center">{label}</span>
    </button>
  );
}

export default function MaskEditor({
  jobId,
  file,
  onClose,
  onSaved,
}: {
  jobId: string;
  file: string;
  onClose: () => void;
  onSaved: (version: number, archivesUpdated: boolean, pagesUpdated: number) => void;
}) {
  const [data, setData] = useState<EditorData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [bg, setBg] = useState<"result" | "original">("result");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [autos, setAutos] = useState<AutoBox[]>([]);
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [tool, setTool] = useState<Tool>(() => {
    const saved = lsGet(LS.tool);
    return saved === "erase" || saved === "auto" ? saved : "paint";
  });
  const [selectedAuto, setSelectedAuto] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(() => lsGet(LS.fullscreen) === "1");
  const [brushPx, setBrushPx] = useState(24);
  const [view, setView] = useState({ scale: 1, pan: { x: 0, y: 0 } });
  const [avail, setAvail] = useState({ w: 0, h: 0 });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [draftNotice, setDraftNotice] = useState(false);
  const [hover, setHover] = useState<Point | null>(null);
  const [originalAutos, setOriginalAutos] = useState<AutoBox[]>([]);
  const [tab, setTab] = useState<Tab>(() => (lsGet(LS.tab) === "text" ? "text" : "mask"));
  const [font, setFont] = useState<FontSettings>(DEFAULT_FONT_SETTINGS);
  const [texts, setTexts] = useState<TextBox[]>([]);
  const [selectedText, setSelectedText] = useState<number | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [baseFailed, setBaseFailed] = useState(false);
  const [initialMask, setInitialMask] = useState<{ strokes: Stroke[]; autos: AutoBox[] }>({
    strokes: [],
    autos: [],
  });

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const patchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const originalImgRef = useRef<HTMLImageElement | null>(null);
  const sampleRef = useRef<PixelCache | null>(null);
  const originalSampleRef = useRef<PixelCache | null>(null);
  const brushRatioRef = useRef(DEFAULT_BRUSH_RATIO);
  const serverStrokesRef = useRef<Stroke[]>([]);
  const serverTextsRef = useRef<TextBox[]>([]);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<"idle" | "draw" | "pan" | "pinch" | "auto">("idle");
  const activeRef = useRef<Stroke | null>(null);
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const pinchRef = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null);
  const autoDragRef = useRef<{
    mode: "move" | "resize";
    index: number;
    handle?: Handle;
    startX: number;
    startY: number;
    origin: Rect;
    moved: boolean;
    previous: Snapshot;
  } | null>(null);
  const spaceRef = useRef(false);
  const textEditSnapshotRef = useRef<Snapshot | null>(null);
  const textDragRef = useRef<{
    index: number;
    handle: Handle | null;
    startX: number;
    startY: number;
    origin: BoxRect;
    moved: boolean;
    previous: Snapshot;
  } | null>(null);

  const pushPast = useCallback((previous: Snapshot) => {
    setPast((p) => [...p.slice(-(MAX_HISTORY - 1)), previous]);
    setFuture([]);
  }, []);

  // Muat halaman + preferensi brush + draf yang belum diterapkan.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/jobs/${encodeURIComponent(jobId)}/editor?file=${encodeURIComponent(file)}`,
          { cache: "no-store" },
        );
        const body = await res.json();
        if (!res.ok) {
          if (res.status === 404 || res.status === 410) lsSet(LS.draft(jobId, file), null);
          throw new Error(body.error || "Gagal memuat data halaman");
        }
        if (cancelled) return;
        const editor = body as EditorData;
        const stored = Number(lsGet(LS.brush));
        const ratio =
          Number.isFinite(stored) && stored > 0
            ? clamp(stored, BRUSH_MIN_RATIO, BRUSH_MAX_RATIO)
            : DEFAULT_BRUSH_RATIO;
        brushRatioRef.current = ratio;
        setData(editor);
        setBrushPx(clamp(Math.round(ratio * editor.width), 2, MAX_SIZE_PX));

        const server = Array.isArray(editor.manualStrokes) ? editor.manualStrokes : [];
        serverStrokesRef.current = server;
        const baseBoxes: AutoBox[] = (Array.isArray(editor.autoMasks) ? editor.autoMasks : []).map((b) => ({
          bbox: clampRect(b, editor.width, editor.height),
          deleted: false,
        }));
        setOriginalAutos(baseBoxes.map((a) => ({ bbox: { ...a.bbox }, deleted: false })));
        const serverAutos = applyAutoEdits(baseBoxes, editor.autoMaskEdits);
        setInitialMask({ strokes: server, autos: serverAutos });

        const serverTexts: TextBox[] = (Array.isArray(editor.textItems) ? editor.textItems : []).map((t) => ({
          index: t.index,
          text: t.text,
          originalText: t.originalText ?? t.text,
          box: { ...t.box },
          defaultBox: { ...t.defaultBox },
          deleted: t.deleted === true,
        }));
        serverTextsRef.current = serverTexts;
        setTexts(serverTexts);
        setFont({
          ...DEFAULT_FONT,
          ...(editor.font ?? {}),
          scope: editor.fontScope === "page" ? "page" : "all",
        });

        const draft = parseDraft(lsGet(LS.draft(jobId, file)));
        const draftAutos = draft?.autos ?? serverAutos;
        const draftTexts = draft?.texts ?? serverTexts;
        const draftState = JSON.stringify({
          strokes: draft?.strokes ?? server,
          autos: draftAutos,
          texts: draftTexts,
        });
        const serverState = JSON.stringify({ strokes: server, autos: serverAutos, texts: serverTexts });
        if (draft && draftState !== serverState) {
          setStrokes(draft.strokes);
          setAutos(draftAutos);
          setTexts(draftTexts);
          setDraftNotice(true);
        } else {
          setStrokes(server);
          setAutos(serverAutos);
          setTexts(serverTexts);
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, file]);

  // Gambar dasar tanpa teks (asli + mask + goresan tersimpan). Dipakai preview
  // tab Mask (teks digambar ulang di atas sapuan brush) dan workspace tab Teks.
  // Di-cache sebagai object URL agar kedua tab tidak memicu render server lagi.
  useEffect(() => {
    const source = data?.textBaseUrl;
    if (!source) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const res = await fetch(source, { cache: "no-store" });
        if (!res.ok) throw new Error(`textbase ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBaseUrl(objectUrl);
        setBaseFailed(false);
      } catch {
        if (!cancelled) setBaseFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [data?.textBaseUrl]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Preferensi editor disimpan di localStorage: buka berikutnya langsung
  // memakai mode layar penuh, alat, dan ukuran brush yang sama.
  useEffect(() => {
    lsSet(LS.fullscreen, fullscreen ? "1" : "0");
  }, [fullscreen]);

  useEffect(() => {
    lsSet(LS.tool, tool);
  }, [tool]);

  useEffect(() => {
    lsSet(LS.tab, tab);
  }, [tab]);

  useEffect(() => {
    if (data) lsSet(LS.brush, String(brushRatioRef.current));
  }, [brushPx, data]);

  // Draf goresan + edit mask + kotak teks per halaman: kalau modal tertutup
  // tanpa "Terapkan", pekerjaan tidak hilang. Di-debounce agar drag kotak teks
  // tidak menulis localStorage di setiap pointermove.
  useEffect(() => {
    if (!data) return;
    const timer = window.setTimeout(() => {
      lsSet(LS.draft(jobId, file), JSON.stringify({ strokes, autos, texts }));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [strokes, autos, texts, data, jobId, file]);

  const previewScale = data ? Math.min(1, PREVIEW_MAX / Math.max(data.width, data.height)) : 1;
  const previewW = data ? Math.max(1, Math.round(data.width * previewScale)) : 1;
  const previewH = data ? Math.max(1, Math.round(data.height * previewScale)) : 1;
  const stageW = data && avail.w && avail.h ? Math.min(avail.w, avail.h * (data.width / data.height)) : 0;
  const stageH = data && stageW ? (stageW * data.height) / data.width : 0;
  const pagePerScreen = data && stageW ? data.width / (stageW * view.scale) : 1;

  // Layout teks untuk preview di tab Mask (di atas sapuan brush). Dihitung
  // sekali per perubahan teks/font, bukan per pointermove.
  const textLayouts = useMemo(
    () =>
      texts.map((text) => {
        if (text.deleted || !text.text.trim()) return null;
        const fitted = fitText(
          text.text,
          Math.max(1, text.box.w - 8),
          Math.max(1, text.box.h - 8),
          font.scale,
        );
        return { index: text.index, box: text.box, fs: fitted.fs, lines: fitted.lines };
      }),
    [texts, font.scale],
  );
  const brushMin = 2;
  const brushMax = data
    ? Math.max(brushMin + 1, Math.min(MAX_SIZE_PX, Math.round(data.width * BRUSH_MAX_RATIO)))
    : MAX_SIZE_PX;
  const autoCount = autos.filter((a) => !a.deleted).length;
  const deletedCount = autos.length - autoCount;
  const selectedBox = selectedAuto !== null ? autos[selectedAuto] : undefined;
  const selectedTextBox = selectedText !== null ? texts[selectedText] : undefined;
  const autosDirty = JSON.stringify(autos) !== JSON.stringify(originalAutos);
  const editedTextCount = texts.filter(
    (t) => t.deleted || t.text !== t.originalText || !sameBox(t.box, t.defaultBox),
  ).length;
  const deletedTextCount = texts.filter((t) => t.deleted).length;
  const textsDirty = editedTextCount > 0;
  const maskDirty =
    JSON.stringify(strokes) !== JSON.stringify(initialMask.strokes) ||
    JSON.stringify(autos) !== JSON.stringify(initialMask.autos);

  const rebuildSample = useCallback(() => {
    const img = imgRef.current;
    if (!data || !img || !img.complete || !img.naturalWidth) {
      sampleRef.current = null;
      return;
    }
    sampleRef.current = makePixelCache(img, previewW, previewH, data.width);
  }, [data, previewW, previewH]);

  const previewColorAt = useCallback(
    (x: number, y: number, size: number): string => {
      if (!data) return "#ffffff";
      if (data.cleanMode === "white") return "#ffffff";
      return sampleDominant(sampleRef.current, x, y, size);
    },
    [data],
  );

  const rebuildOriginalSample = useCallback(() => {
    const img = originalImgRef.current;
    if (!data || !img || !img.complete || !img.naturalWidth) {
      originalSampleRef.current = null;
      return;
    }
    originalSampleRef.current = makePixelCache(img, previewW, previewH, data.width);
  }, [data, previewW, previewH]);

  const patchColorAt = useCallback(
    (x: number, y: number, size: number): string => {
      if (!data) return "#ffffff";
      if (data.cleanMode === "white") return "#ffffff";
      return sampleDominant(originalSampleRef.current, x, y, size);
    },
    [data],
  );

  // Kanvas patch: menampilkan efek edit mask otomatis tanpa render server.
  // Mask dihapus = tempel potongan asli; mask digeser = potongan asli
  // dikembalikan lalu area baru diisi warna kertas.
  const drawPatch = useCallback(() => {
    const canvas = patchCanvasRef.current;
    if (!canvas || !data) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (bg !== "result") return;
    const original = originalImgRef.current;
    if (!original || !original.complete || !original.naturalWidth) return;
    const scale = canvas.width / data.width;
    autos.forEach((box, i) => {
      const orig = originalAutos[i];
      if (!orig) return;
      if (box.deleted) {
        drawOriginalCrop(ctx, original, orig.bbox, scale);
        return;
      }
      if (sameRect(box.bbox, orig.bbox)) return;
      drawOriginalCrop(ctx, original, orig.bbox, scale);
      const w = (box.bbox.x1 - box.bbox.x0) * scale;
      const h = (box.bbox.y1 - box.bbox.y0) * scale;
      if (w <= 0 || h <= 0) return;
      ctx.fillStyle = patchColorAt(
        (box.bbox.x0 + box.bbox.x1) / 2,
        (box.bbox.y0 + box.bbox.y1) / 2,
        Math.max(box.bbox.x1 - box.bbox.x0, box.bbox.y1 - box.bbox.y0) * 0.3,
      );
      ctx.fillRect(box.bbox.x0 * scale, box.bbox.y0 * scale, w, h);
    });
  }, [autos, bg, data, originalAutos, patchColorAt]);

  const drawAll = useCallback(
    (list: Stroke[]) => {
      const canvas = canvasRef.current;
      if (!canvas || !data) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const scale = canvas.width / Math.max(1, data.width);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const stroke of list) {
        const color =
          stroke.mode === "erase"
            ? "#000000"
            : stroke.color ||
              previewColorAt(stroke.points[0][0], stroke.points[0][1], stroke.size);
        paintStroke(ctx, stroke, scale, color);
      }
    },
    [data, previewColorAt],
  );

  useEffect(() => {
    drawAll(strokes);
  }, [drawAll, strokes, tab]);

  useEffect(() => {
    drawPatch();
  }, [drawPatch, previewW, previewH, tab]);

  // Gambar yang tampil berganti (Hasil ↔ Asli) → segarkan cache warna.
  useEffect(() => {
    rebuildSample();
  }, [rebuildSample, bg]);

  // Ukuran panggung mengikuti ruang yang tersedia (termasuk saat fullscreen).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !data) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setAvail({ w: Math.max(80, rect.width - 24), h: Math.max(80, rect.height - 24) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [data]);

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    setView((v) => {
      const next = clamp(v.scale * factor, MIN_ZOOM, MAX_ZOOM);
      if (!rect || next === v.scale) return next === v.scale ? v : { ...v, scale: next };
      const ratio = next / v.scale;
      return {
        scale: next,
        pan: {
          x: v.pan.x + (clientX - rect.left) * (1 - ratio),
          y: v.pan.y + (clientY - rect.top) * (1 - ratio),
        },
      };
    });
    setHover(null);
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
    },
    [zoomAt],
  );

  const resetView = useCallback(() => {
    setView({ scale: 1, pan: { x: 0, y: 0 } });
    setHover(null);
  }, []);

  const updateBrush = useCallback(
    (px: number) => {
      const max = data
        ? Math.max(4, Math.min(MAX_SIZE_PX, Math.round(data.width * BRUSH_MAX_RATIO)))
        : MAX_SIZE_PX;
      const next = clamp(Math.round(px), 2, max);
      setBrushPx(next);
      if (data) brushRatioRef.current = next / data.width;
    },
    [data],
  );

  const undo = useCallback(() => {
    if (!past.length) return;
    const prev = past[past.length - 1];
    setFuture((f) => [{ strokes, autos, texts }, ...f].slice(0, MAX_HISTORY));
    setPast(past.slice(0, -1));
    setStrokes(prev.strokes);
    setAutos(prev.autos);
    setTexts(prev.texts);
    setSelectedAuto(null);
    setSelectedText(null);
  }, [past, strokes, autos, texts]);

  const redoStep = useCallback(() => {
    if (!future.length) return;
    const next = future[0];
    setPast((p) => [...p.slice(-(MAX_HISTORY - 1)), { strokes, autos, texts }]);
    setFuture(future.slice(1));
    setStrokes(next.strokes);
    setAutos(next.autos);
    setTexts(next.texts);
    setSelectedAuto(null);
    setSelectedText(null);
  }, [future, strokes, autos, texts]);

  const resetStrokes = useCallback(() => {
    if (!strokes.length) return;
    pushPast({ strokes, autos, texts });
    setStrokes([]);
  }, [autos, pushPast, strokes, texts]);

  const setSelectedAutoDeleted = useCallback(
    (deleted: boolean) => {
      if (selectedAuto === null) return;
      const box = autos[selectedAuto];
      if (!box || box.deleted === deleted) return;
      pushPast({ strokes, autos, texts });
      setAutos(autos.map((a, i) => (i === selectedAuto ? { ...a, deleted } : a)));
    },
    [autos, pushPast, selectedAuto, strokes, texts],
  );

  const toggleSelectedAuto = useCallback(() => {
    if (selectedAuto === null) return;
    const box = autos[selectedAuto];
    if (!box) return;
    setSelectedAutoDeleted(!box.deleted);
  }, [autos, selectedAuto, setSelectedAutoDeleted]);

  const restoreAutos = useCallback(() => {
    if (JSON.stringify(autos) === JSON.stringify(originalAutos)) return;
    pushPast({ strokes, autos, texts });
    setAutos(originalAutos.map((a) => ({ bbox: { ...a.bbox }, deleted: false })));
    setSelectedAuto(null);
  }, [autos, originalAutos, pushPast, strokes, texts]);

  const restoreTexts = useCallback(() => {
    if (!textsDirty) return;
    pushPast({ strokes, autos, texts });
    setTexts(
      texts.map((t) => ({
        ...t,
        text: t.originalText,
        box: { ...t.defaultBox },
        deleted: false,
      })),
    );
    setSelectedText(null);
  }, [autos, pushPast, strokes, texts, textsDirty]);

  const setSelectedTextDeleted = useCallback(
    (deleted: boolean) => {
      if (selectedText === null) return;
      const item = texts[selectedText];
      if (!item || item.deleted === deleted) return;
      pushPast({ strokes, autos, texts });
      setTexts(texts.map((t, i) => (i === selectedText ? { ...t, deleted } : t)));
    },
    [autos, pushPast, selectedText, strokes, texts],
  );

  const toggleSelectedTextDeleted = useCallback(() => {
    if (selectedText === null) return;
    const item = texts[selectedText];
    if (!item) return;
    setSelectedTextDeleted(!item.deleted);
  }, [selectedText, setSelectedTextDeleted, texts]);

  const setTextContent = useCallback((index: number, value: string) => {
    setTexts((prev) => prev.map((t, i) => (i === index ? { ...t, text: value } : t)));
  }, []);

  const discardDraft = useCallback(() => {
    lsSet(LS.draft(jobId, file), null);
    setDraftNotice(false);
    setStrokes(serverStrokesRef.current);
    setAutos(originalAutos.map((a) => ({ bbox: { ...a.bbox }, deleted: false })));
    setTexts(serverTextsRef.current);
    setSelectedAuto(null);
    setSelectedText(null);
    setPast([]);
    setFuture([]);
  }, [jobId, file, originalAutos]);

  function chooseTool(value: Tool) {
    setTool(value);
    setSelectedAuto(null);
    setHover(null);
  }

  function chooseTab(value: Tab) {
    setTab(value);
    setSelectedAuto(null);
    setSelectedText(null);
    setHover(null);
  }

  // Ctrl+scroll = zoom ke arah kursor; scroll biasa = geser halaman;
  // Shift+scroll = geser kanan/kiri (roda mouse biasa hanya punya deltaY).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !data) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0018));
        return;
      }
      setHover(null);
      const horizontal = e.shiftKey;
      const dx = horizontal
        ? Math.abs(e.deltaX) > Math.abs(e.deltaY)
          ? e.deltaX
          : e.deltaY
        : e.deltaX;
      const dy = horizontal ? 0 : e.deltaY;
      setView((v) => ({ ...v, pan: { x: v.pan.x - dx, y: v.pan.y - dy } }));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [data, zoomAt]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code === "Space") spaceRef.current = true;
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") spaceRef.current = false;
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !typing && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redoStep();
        else undo();
        return;
      }
      if (mod && !typing && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redoStep();
        return;
      }
      if (typing) return;
      if (e.key === "Escape") {
        if (selectedAuto !== null) {
          setSelectedAuto(null);
          return;
        }
        if (selectedText !== null) {
          setSelectedText(null);
          return;
        }
        if (!saving) onClose();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && tab === "text" && selectedText !== null) {
        e.preventDefault();
        setSelectedTextDeleted(true);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && tool === "auto" && selectedAuto !== null) {
        e.preventDefault();
        setSelectedAutoDeleted(true);
        return;
      }
      if (e.key === "b" || e.key === "B") chooseTool("paint");
      else if (e.key === "e" || e.key === "E") chooseTool("erase");
      else if (e.key === "m" || e.key === "M") chooseTool("auto");
      else if (e.key === "[") updateBrush(brushPx / 1.25);
      else if (e.key === "]") updateBrush(brushPx * 1.25);
      else if (e.key === "+" || e.key === "=") zoomBy(1.2);
      else if (e.key === "-") zoomBy(1 / 1.2);
      else if (e.key === "0") resetView();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    brushPx,
    onClose,
    redoStep,
    resetView,
    saving,
    selectedAuto,
    selectedText,
    setSelectedAutoDeleted,
    setSelectedTextDeleted,
    tab,
    tool,
    undo,
    updateBrush,
    zoomBy,
  ]);

  const pagePoint = useCallback(
    (e: { clientX: number; clientY: number }): Point | null => {
      const canvas = canvasRef.current;
      if (!canvas || !data) return null;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return [
        clamp(((e.clientX - rect.left) / rect.width) * data.width, 0, data.width),
        clamp(((e.clientY - rect.top) / rect.height) * data.height, 0, data.height),
      ];
    },
    [data],
  );

  function readPinch() {
    const points = [...pointersRef.current.values()];
    const a = points[0];
    const b = points[1];
    if (!a || !b) return null;
    return {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }

  function cancelAutoDrag() {
    const drag = autoDragRef.current;
    autoDragRef.current = null;
    if (!drag) return;
    setStrokes(drag.previous.strokes);
    setAutos(drag.previous.autos);
    setTexts(drag.previous.texts);
  }

  function findAutoBox(x: number, y: number, tolerance: number): number | null {
    for (let i = autos.length - 1; i >= 0; i--) {
      const b = autos[i].bbox;
      if (x >= b.x0 - tolerance && x <= b.x1 + tolerance && y >= b.y0 - tolerance && y <= b.y1 + tolerance) {
        return i;
      }
    }
    return null;
  }

  function startTextDrag(pointer: React.PointerEvent<HTMLElement>, index: number, handle: Handle | null) {    if (!data || saving) return;
    pointer.stopPropagation();
    pointer.preventDefault();
    pointer.currentTarget.setPointerCapture(pointer.pointerId);
    setSelectedText(index);
    // Teks yang sudah dihapus tetap bisa dipilih (untuk diaktifkan lagi),
    // tapi tidak bisa digeser/di-resize.
    if (texts[index].deleted) return;
    textDragRef.current = {
      index,
      handle,
      startX: pointer.clientX,
      startY: pointer.clientY,
      origin: { ...texts[index].box },
      moved: false,
      previous: { strokes, autos, texts },
    };
  }

  function onTextDragMove(pointer: React.PointerEvent<HTMLElement>) {
    const drag = textDragRef.current;
    const stage = stageRef.current;
    if (!drag || !stage || !data) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = (pointer.clientX - drag.startX) * (data.width / rect.width);
    const dy = (pointer.clientY - drag.startY) * (data.height / rect.height);
    if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;

    const o = drag.origin;
    let x0 = o.x;
    let y0 = o.y;
    let x1 = o.x + o.w;
    let y1 = o.y + o.h;
    if (!drag.handle) {
      x0 = clamp(o.x + dx, 0, Math.max(0, data.width - o.w));
      y0 = clamp(o.y + dy, 0, Math.max(0, data.height - o.h));
      x1 = x0 + o.w;
      y1 = y0 + o.h;
    } else {
      const h = drag.handle;
      if (h.includes("w")) x0 = o.x + dx;
      if (h.includes("e")) x1 = o.x + o.w + dx;
      if (h.includes("n")) y0 = o.y + dy;
      if (h.includes("s")) y1 = o.y + o.h + dy;
      if (x1 - x0 < MIN_TEXT_BOX) {
        if (h.includes("w")) x0 = x1 - MIN_TEXT_BOX;
        else x1 = x0 + MIN_TEXT_BOX;
      }
      if (y1 - y0 < MIN_TEXT_BOX) {
        if (h.includes("n")) y0 = y1 - MIN_TEXT_BOX;
        else y1 = y0 + MIN_TEXT_BOX;
      }
      const r = clampRect({ x0, y0, x1, y1 }, data.width, data.height);
      x0 = r.x0;
      y0 = r.y0;
      x1 = r.x1;
      y1 = r.y1;
    }
    const box = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    setTexts((prev) => prev.map((t, i) => (i === drag.index ? { ...t, box } : t)));
  }

  function onTextDragEnd() {
    const drag = textDragRef.current;
    textDragRef.current = null;
    if (drag?.moved) pushPast(drag.previous);
  }

  function beginTextEdit() {
    if (selectedText === null) return;
    textEditSnapshotRef.current = { strokes, autos, texts };
  }

  function endTextEdit() {
    const snapshot = textEditSnapshotRef.current;
    textEditSnapshotRef.current = null;
    if (snapshot && JSON.stringify(snapshot.texts) !== JSON.stringify(texts)) {
      pushPast(snapshot);
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!data || saving) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);

    if (pointersRef.current.size >= 2) {
      // Jari kedua = pinch: batalkan goresan / drag yang sedang berjalan.
      if (activeRef.current) {
        activeRef.current = null;
        drawAll(strokes);
      }
      cancelAutoDrag();
      gestureRef.current = "pinch";
      pinchRef.current = readPinch();
      return;
    }

    const wantsPan = e.button === 1 || (e.pointerType === "mouse" && e.button === 0 && spaceRef.current);
    if (wantsPan) {
      e.preventDefault();
      gestureRef.current = "pan";
      panStartRef.current = { x: e.clientX, y: e.clientY, panX: view.pan.x, panY: view.pan.y };
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) return;

    const point = pagePoint(e);
    if (!point) return;

    if (tool === "auto") {
      const tolerance = 12 * pagePerScreen;
      const selectedBox = selectedAuto !== null ? autos[selectedAuto] : undefined;
      const handle =
        selectedBox && !selectedBox.deleted
          ? hitHandle(selectedBox.bbox, point[0], point[1], tolerance)
          : null;
      if (selectedBox && handle) {
        autoDragRef.current = {
          mode: "resize",
          index: selectedAuto!,
          handle,
          startX: point[0],
          startY: point[1],
          origin: { ...selectedBox.bbox },
          moved: false,
          previous: { strokes, autos, texts },
        };
        gestureRef.current = "auto";
        return;
      }
      const index = findAutoBox(point[0], point[1], tolerance);
      if (index === null) {
        setSelectedAuto(null);
        return;
      }
      setSelectedAuto(index);
      // Mask yang sudah dihapus tetap bisa dipilih (ditandai merah) agar bisa
      // diaktifkan lagi, tapi tidak bisa digeser/di-resize.
      if (autos[index].deleted) return;
      autoDragRef.current = {
        mode: "move",
        index,
        startX: point[0],
        startY: point[1],
        origin: { ...autos[index].bbox },
        moved: false,
        previous: { strokes, autos, texts },
      };
      gestureRef.current = "auto";
      return;
    }

    if (strokes.length >= MAX_STROKES) {
      setSaveError(`Maksimal ${MAX_STROKES} goresan per halaman.`);
      return;
    }
    setSaveError("");
    const stroke: Stroke = {
      mode: tool,
      size: brushPx,
      points: [point],
      color: tool === "paint" ? previewColorAt(point[0], point[1], brushPx) : undefined,
    };
    activeRef.current = stroke;
    gestureRef.current = "draw";
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) paintStroke(ctx, stroke, canvas.width / data.width, stroke.color || "#ffffff");
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!data) return;
    const tracked = pointersRef.current.get(e.pointerId);
    if (tracked) {
      tracked.x = e.clientX;
      tracked.y = e.clientY;
    }

    if (gestureRef.current === "pinch") {
      const next = readPinch();
      const prev = pinchRef.current;
      if (!next) return;
      if (prev) {
        const factor = next.dist / prev.dist;
        if (Number.isFinite(factor) && factor > 0) zoomAt(next.mid.x, next.mid.y, factor);
        const dx = next.mid.x - prev.mid.x;
        const dy = next.mid.y - prev.mid.y;
        if (dx || dy) setView((v) => ({ ...v, pan: { x: v.pan.x + dx, y: v.pan.y + dy } }));
      }
      pinchRef.current = next;
      return;
    }

    if (gestureRef.current === "pan") {
      const start = panStartRef.current;
      if (!start) return;
      setView((v) => ({
        ...v,
        pan: { x: start.panX + (e.clientX - start.x), y: start.panY + (e.clientY - start.y) },
      }));
      return;
    }

    const point = pagePoint(e);

    if (gestureRef.current === "auto") {
      const drag = autoDragRef.current;
      if (!drag || !point) return;
      const dx = point[0] - drag.startX;
      const dy = point[1] - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
      let next: Rect = { ...drag.origin };
      if (drag.mode === "move") {
        const w = drag.origin.x1 - drag.origin.x0;
        const h = drag.origin.y1 - drag.origin.y0;
        const x0 = clamp(drag.origin.x0 + dx, 0, data.width - w);
        const y0 = clamp(drag.origin.y0 + dy, 0, data.height - h);
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
      setAutos((prev) => prev.map((a, i) => (i === drag.index ? { ...a, bbox: next, deleted: false } : a)));
      return;
    }

    setHover(point);

    if (gestureRef.current !== "draw") return;
    const active = activeRef.current;
    if (!active || !point) return;
    const [lx, ly] = active.points[active.points.length - 1];
    if (Math.hypot(point[0] - lx, point[1] - ly) < Math.max(1, active.size * 0.12)) return;
    active.points.push(point);

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const scale = canvas.width / data.width;
    ctx.save();
    if (active.mode === "erase") ctx.globalCompositeOperation = "destination-out";
    const color = active.mode === "erase" ? "#000000" : active.color || "#ffffff";
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, active.size * scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(lx * scale, ly * scale);
    ctx.lineTo(point[0] * scale, point[1] * scale);
    ctx.stroke();
    ctx.restore();
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    pointersRef.current.delete(e.pointerId);
    if (gestureRef.current === "pinch") {
      if (pointersRef.current.size < 2) {
        pinchRef.current = null;
        gestureRef.current = "idle";
      }
      return;
    }
    if (gestureRef.current === "pan") {
      panStartRef.current = null;
      gestureRef.current = "idle";
      return;
    }
    if (gestureRef.current === "auto") {
      const drag = autoDragRef.current;
      autoDragRef.current = null;
      gestureRef.current = "idle";
      if (drag?.moved) pushPast(drag.previous);
      return;
    }
    if (gestureRef.current !== "draw") return;
    const active = activeRef.current;
    activeRef.current = null;
    gestureRef.current = "idle";
    if (!active) return;
    if (strokes.length >= MAX_STROKES) {
      drawAll(strokes);
      return;
    }
    pushPast({ strokes, autos, texts });
    setStrokes([...strokes, active]);
  }

  function onPointerCancel(e: React.PointerEvent<HTMLCanvasElement>) {
    pointersRef.current.delete(e.pointerId);
    if (gestureRef.current === "draw") {
      activeRef.current = null;
      drawAll(strokes);
    }
    if (gestureRef.current === "auto") cancelAutoDrag();
    pinchRef.current = null;
    panStartRef.current = null;
    gestureRef.current = "idle";
  }

  async function apply() {
    if (!data || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const autoMaskEdits: AutoMaskEdit[] = [];
      autos.forEach((box, i) => {
        const original = originalAutos[i];
        if (!original) return;
        if (box.deleted) {
          autoMaskEdits.push({ index: i, deleted: true });
          return;
        }
        if (!sameRect(box.bbox, original.bbox)) {
          autoMaskEdits.push({
            index: i,
            bbox: {
              x0: Math.round(box.bbox.x0),
              y0: Math.round(box.bbox.y0),
              x1: Math.round(box.bbox.x1),
              y1: Math.round(box.bbox.y1),
            },
          });
        }
      });
      // `color` hanya untuk preview lokal; server sampling warnanya sendiri.
      const apiStrokes = strokes.map((s) => ({ mode: s.mode, size: s.size, points: s.points }));
      const textOverrides = texts
        .filter((t) => t.deleted || t.text !== t.originalText || !sameBox(t.box, t.defaultBox))
        .map((t) => ({
          index: t.index,
          x: Math.round(t.box.x),
          y: Math.round(t.box.y),
          w: Math.round(t.box.w),
          h: Math.round(t.box.h),
          ...(t.text !== t.originalText ? { text: t.text } : {}),
          ...(t.deleted ? { deleted: true } : {}),
        }));
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/mask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: data.file,
          strokes: apiStrokes,
          autoMaskEdits,
          textOverrides,
          font: { family: font.family, bold: font.bold, scale: font.scale },
          fontScope: font.scope,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Gagal menyimpan koreksi");
      lsSet(LS.draft(jobId, file), null);
      onSaved(
        Number(body.version) || Date.now(),
        body.archivesUpdated !== false,
        Number(body.pagesUpdated) || 1,
      );
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
      <div
        className={`bg-background relative flex w-full flex-col overflow-hidden border-2 ${
          fullscreen ? "h-full max-h-none max-w-none" : "h-[94vh] max-w-5xl"
        }`}
      >
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="mask-editor-title" className="truncate text-sm font-semibold">
              Koreksi mask — {data?.file || file}
            </h2>
            <p className="text-muted-foreground text-xs">
              {tab === "text"
                ? "Pilih kotak untuk mengubah isi & font. Geser = pindah, handle = ukuran, Delete = hapus teks. Terapkan untuk merender."
                : tool === "auto"
                  ? "Klik kotak kuning untuk memilih. Geser = pindah, tarik handle = ubah ukuran, Delete = hapus, klik kotak merah = aktifkan lagi."
                  : "Brush langsung menimpa dengan warna kertas (live preview). Ctrl+scroll zoom, scroll geser, Shift+scroll kanan/kiri, Space+drag pan."}
            </p>
          </div>
          {data && data.undetected > 0 && (
            <Badge variant="secondary" className="shrink-0">
              {data.undetected} bubble tak terdeteksi
            </Badge>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={fullscreen ? "Keluar layar penuh" : "Layar penuh"}
            title={fullscreen ? "Keluar layar penuh" : "Layar penuh"}
            onClick={() => setFullscreen((v) => !v)}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label="Tutup" onClick={onClose} disabled={saving}>
            <X />
          </Button>
        </header>

        <div
          className="bg-muted/40 flex items-end gap-1 border-b px-3 pt-1.5"
          role="tablist"
          aria-label="Bagian editor"
        >
          {([
            ["mask", "Mask"],
            ["text", "Teks"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => chooseTab(value)}
              className={`rounded-t-md border border-b-0 px-4 py-1.5 text-xs font-medium ${
                tab === value
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:text-foreground border-transparent"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "mask" ? (
          <div className="bg-background flex overflow-x-auto border-b" role="tabpanel" aria-label="Mask">
            <RibbonGroup label="Alat">
              <RibbonButton
                icon={Paintbrush}
                label="Brush"
                active={tool === "paint"}
                onClick={() => chooseTool("paint")}
              />
              <RibbonButton
                icon={Eraser}
                label="Eraser"
                active={tool === "erase"}
                onClick={() => chooseTool("erase")}
              />
              <RibbonButton
                icon={BoxSelect}
                label="Mask"
                active={tool === "auto"}
                onClick={() => chooseTool("auto")}
              />
            </RibbonGroup>

            <RibbonGroup label="Ukuran">
              <div className="flex h-14 w-32 flex-col items-center justify-center gap-1">
                <input
                  type="range"
                  min={brushMin}
                  max={brushMax}
                  value={clamp(brushPx, brushMin, brushMax)}
                  onChange={(e) => updateBrush(Number(e.target.value))}
                  className="accent-primary w-28"
                  aria-label="Ukuran brush"
                />
                <span className="text-muted-foreground text-[11px] tabular-nums">{brushPx} px</span>
              </div>
            </RibbonGroup>

            <RibbonGroup label="Mask otomatis">
              <RibbonButton
                icon={selectedBox?.deleted ? Check : Trash2}
                label={selectedBox?.deleted ? "Aktifkan" : "Hapus"}
                title={selectedBox?.deleted ? "Aktifkan kembali mask ini" : "Hapus mask otomatis terpilih"}
                disabled={!selectedBox || saving}
                onClick={toggleSelectedAuto}
              />
              <RibbonButton
                icon={RotateCcw}
                label="Pulihkan"
                title="Kembalikan semua mask otomatis ke posisi/ukuran awal"
                disabled={!autosDirty || saving}
                onClick={restoreAutos}
              />
            </RibbonGroup>

            <RibbonGroup label="Riwayat">
              <RibbonButton icon={Undo2} label="Undo" disabled={!past.length || saving} onClick={undo} />
              <RibbonButton icon={Redo2} label="Redo" disabled={!future.length || saving} onClick={redoStep} />
              <RibbonButton
                icon={RotateCcw}
                label="Reset"
                title="Hapus semua goresan brush"
                disabled={!strokes.length || saving}
                onClick={resetStrokes}
              />
            </RibbonGroup>

            <RibbonGroup label="Latar">
              <RibbonButton icon={Eye} label="Hasil" active={bg === "result"} onClick={() => setBg("result")} />
              <RibbonButton
                icon={FileImage}
                label="Asli"
                active={bg === "original"}
                onClick={() => setBg("original")}
              />
            </RibbonGroup>

            <RibbonGroup label="Zoom">
              <RibbonButton icon={ZoomOut} label="Perkecil" onClick={() => zoomBy(1 / 1.2)} />
              <span className="text-muted-foreground flex h-14 w-12 items-center justify-center text-xs tabular-nums">
                {Math.round(view.scale * 100)}%
              </span>
              <RibbonButton icon={ZoomIn} label="Perbesar" onClick={() => zoomBy(1.2)} />
              <RibbonButton icon={Scan} label="Fit" title="Sesuaikan ke layar" onClick={resetView} />
            </RibbonGroup>
          </div>
        ) : (
          <div className="bg-background flex overflow-x-auto border-b" role="tabpanel" aria-label="Teks">
            <RibbonGroup label="Isi teks">
              <textarea
                value={selectedTextBox?.text ?? ""}
                onChange={(event) => {
                  if (selectedText !== null) setTextContent(selectedText, event.target.value);
                }}
                onFocus={beginTextEdit}
                onBlur={endTextEdit}
                disabled={!selectedTextBox || saving}
                placeholder={selectedTextBox ? "Ketik terjemahan..." : "Pilih kotak teks"}
                aria-label="Isi teks terjemahan"
                className="border-input bg-background h-14 w-64 resize-none rounded-md border p-1.5 text-xs leading-snug disabled:opacity-50"
              />
            </RibbonGroup>

            <RibbonGroup label="Font">
              <div className="flex h-14 flex-col justify-center gap-1 px-1">
                <select
                  value={font.family}
                  onChange={(e) => setFont({ ...font, family: e.target.value })}
                  className="border-input bg-background h-8 w-44 rounded-md border px-2 text-xs"
                  aria-label="Font terjemahan"
                >
                  {FONT_FAMILIES.map((family) => (
                    <option key={family} value={family}>
                      {family}
                    </option>
                  ))}
                </select>
                <span className="text-muted-foreground text-[10px]">Font terjemahan</span>
              </div>
            </RibbonGroup>

            <RibbonGroup label="Gaya">
              <RibbonButton
                icon={Type}
                label="Normal"
                active={!font.bold}
                onClick={() => setFont({ ...font, bold: false })}
              />
              <RibbonButton
                icon={Bold}
                label="Bold"
                active={font.bold}
                onClick={() => setFont({ ...font, bold: true })}
              />
            </RibbonGroup>

            <RibbonGroup label="Ukuran huruf">
              <div className="flex h-14 flex-col items-center justify-center gap-1 px-1">
                <select
                  value={font.scale}
                  onChange={(e) => setFont({ ...font, scale: Number(e.target.value) })}
                  className="border-input bg-background h-8 w-20 rounded-md border px-2 text-xs"
                  aria-label="Skala huruf"
                >
                  {FONT_SCALES.map((scale) => (
                    <option key={scale} value={scale}>
                      {scale}%
                    </option>
                  ))}
                </select>
                <span className="text-muted-foreground text-[10px]">Skala</span>
              </div>
            </RibbonGroup>

            <RibbonGroup label="Cakupan">
              <RibbonButton
                icon={File}
                label="Halaman"
                title="Halaman ini"
                active={font.scope === "page"}
                onClick={() => setFont({ ...font, scope: "page" })}
              />
              <RibbonButton
                icon={Files}
                label="Semua"
                title="Semua halaman"
                active={font.scope === "all"}
                onClick={() => setFont({ ...font, scope: "all" })}
              />
            </RibbonGroup>

            <RibbonGroup label="Tampilan">
              <RibbonButton icon={ZoomOut} label="Perkecil" onClick={() => zoomBy(1 / 1.2)} />
              <span className="text-muted-foreground flex h-14 w-12 items-center justify-center text-xs tabular-nums">
                {Math.round(view.scale * 100)}%
              </span>
              <RibbonButton icon={ZoomIn} label="Perbesar" onClick={() => zoomBy(1.2)} />
              <RibbonButton icon={Scan} label="Fit" title="Sesuaikan ke layar" onClick={resetView} />
            </RibbonGroup>

            <RibbonGroup label="Posisi teks">
              <RibbonButton
                icon={selectedTextBox?.deleted ? Check : Trash2}
                label={selectedTextBox?.deleted ? "Aktifkan" : "Hapus"}
                title={
                  selectedTextBox?.deleted
                    ? "Tampilkan kembali teks ini"
                    : "Hapus teks terjemahan ini (area tetap dibersihkan)"
                }
                disabled={!selectedTextBox || saving}
                onClick={toggleSelectedTextDeleted}
              />
              <RibbonButton
                icon={RotateCcw}
                label="Pulihkan"
                title="Kembalikan semua kotak teks ke posisi/ukuran awal"
                disabled={!textsDirty || saving}
                onClick={restoreTexts}
              />
            </RibbonGroup>
          </div>
        )}

        <div ref={viewportRef} className="bg-muted/40 relative min-h-0 flex-1 overflow-hidden">
          {loadError ? (
            <p className="text-destructive absolute inset-0 flex items-center justify-center p-6 text-sm">
              {loadError}
            </p>
          ) : !data ? (
            <div className="text-muted-foreground absolute inset-0 flex items-center justify-center gap-2 text-sm">
              <Loader2 className="animate-spin" /> Memuat halaman...
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center p-2 sm:p-3">
              <div
                ref={stageRef}
                className="relative shrink-0 border shadow-sm"
                style={{
                  width: stageW || undefined,
                  height: stageH || undefined,
                  transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.scale})`,
                  transformOrigin: "0 0",
                }}
              >
                {tab === "mask" ? (
                  <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgRef}
                  src={bg === "original" ? data.originalUrl : baseUrl ?? data.resultUrl}
                  alt={`Halaman ${data.file}`}
                  className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
                  draggable={false}
                  onLoad={() => {
                    rebuildSample();
                    drawAll(strokes);
                  }}
                />
                {/* Gambar asli untuk patch live saat mask dihapus/digeser. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={originalImgRef}
                  src={data.originalUrl}
                  alt=""
                  aria-hidden
                  className="hidden"
                  onLoad={() => {
                    rebuildOriginalSample();
                    drawPatch();
                  }}
                />
                <canvas
                  ref={patchCanvasRef}
                  width={previewW}
                  height={previewH}
                  className="pointer-events-none absolute inset-0 h-full w-full"
                />
                <canvas
                  ref={canvasRef}
                  width={previewW}
                  height={previewH}
                  className="absolute inset-0 h-full w-full touch-none"
                  style={{
                    cursor: tool === "auto" ? "default" : tool === "erase" ? "cell" : "none",
                  }}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerCancel}
                  onPointerLeave={() => {
                    if (gestureRef.current === "idle") setHover(null);
                  }}
                />
                {/* Teks terjemahan selalu digambar di ATAS sapuan brush, sama
                    seperti render server (brush dulu, teks terakhir). */}
                {bg === "result" && baseUrl && (
                  <div className="pointer-events-none absolute inset-0">
                    {textLayouts.map((layout) => {
                      if (!layout) return null;
                      const fontSize = layout.fs * (stageW / Math.max(1, data.width));
                      return (
                        <div
                          key={`preview-text-${layout.index}`}
                          className="absolute flex items-center justify-center overflow-hidden px-1 text-center"
                          style={{
                            left: `${(layout.box.x / data.width) * 100}%`,
                            top: `${(layout.box.y / data.height) * 100}%`,
                            width: `${(layout.box.w / data.width) * 100}%`,
                            height: `${(layout.box.h / data.height) * 100}%`,
                            fontFamily: fontStack(font.family),
                            fontWeight: font.bold ? 700 : 400,
                            fontSize: `${fontSize}px`,
                            lineHeight: 1.25,
                            whiteSpace: "pre-wrap",
                            color: "#111111",
                          }}
                        >
                          {layout.lines.join("\n")}
                        </div>
                      );
                    })}
                  </div>
                )}
                <svg
                  viewBox={`0 0 ${data.width} ${data.height}`}
                  className="pointer-events-none absolute inset-0 h-full w-full"
                >
                  {autos.map((box, i) => {
                    const selected = selectedAuto === i;
                    const b = box.bbox;
                    const dash = `${Math.max(3, data.width / 300)} ${Math.max(3, data.width / 300)}`;
                    const sw = Math.max(1, data.width / 900);

                    // Mask yang dihapus TETAP ditampilkan (merah + silang) supaya
                    // user tahu area mana yang dinonaktifkan dan bisa
                    // mengaktifkannya lagi.
                    if (box.deleted) {
                      return (
                        <g key={`auto-${i}`}>
                          <rect
                            x={b.x0}
                            y={b.y0}
                            width={Math.max(0, b.x1 - b.x0)}
                            height={Math.max(0, b.y1 - b.y0)}
                            fill={selected ? "rgba(239, 68, 68, 0.16)" : "none"}
                            stroke="#ef4444"
                            strokeWidth={sw}
                            strokeDasharray={dash}
                          />
                          <line
                            x1={b.x0}
                            y1={b.y0}
                            x2={b.x1}
                            y2={b.y1}
                            stroke="#ef4444"
                            strokeWidth={1.5}
                            opacity={0.9}
                            vectorEffect="non-scaling-stroke"
                          />
                          <line
                            x1={b.x1}
                            y1={b.y0}
                            x2={b.x0}
                            y2={b.y1}
                            stroke="#ef4444"
                            strokeWidth={1.5}
                            opacity={0.9}
                            vectorEffect="non-scaling-stroke"
                          />
                        </g>
                      );
                    }

                    return (
                      <g key={`auto-${i}`}>
                        <rect
                          x={b.x0}
                          y={b.y0}
                          width={Math.max(0, b.x1 - b.x0)}
                          height={Math.max(0, b.y1 - b.y0)}
                          fill={selected ? "rgba(245, 158, 11, 0.16)" : "none"}
                          stroke="#f59e0b"
                          strokeWidth={sw}
                          strokeDasharray={dash}
                        />
                        {selected &&
                          HANDLES.map((h) => {
                            const [hx, hy] = handlePoint(b, h);
                            const size = 10 * pagePerScreen;
                            return (
                              <rect
                                key={h}
                                x={hx - size / 2}
                                y={hy - size / 2}
                                width={size}
                                height={size}
                                fill="#ffffff"
                                stroke="#f59e0b"
                                strokeWidth={2}
                                vectorEffect="non-scaling-stroke"
                              />
                            );
                          })}
                      </g>
                    );
                  })}
                  {hover && tool !== "auto" && (
                    <>
                      <circle
                        cx={hover[0]}
                        cy={hover[1]}
                        r={Math.max(2, brushPx / 2)}
                        fill="none"
                        stroke="#ffffff"
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                      />
                      <circle
                        cx={hover[0]}
                        cy={hover[1]}
                        r={Math.max(2, brushPx / 2)}
                        fill="none"
                        stroke="#2563eb"
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                      />
                    </>
                  )}
                </svg>
                  </>
                ) : (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={baseUrl ?? data.resultUrl}
                      alt={`Pratinjau teks ${data.file}`}
                      className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
                      draggable={false}
                    />
                    {!baseUrl && !baseFailed && (
                      <div className="bg-background/70 text-muted-foreground absolute inset-0 flex items-center justify-center gap-2 text-xs">
                        <Loader2 className="size-4 animate-spin" /> Memuat pratinjau teks...
                      </div>
                    )}
                    <div
                      className="absolute inset-0"
                      onPointerDown={(event) => {
                        if (event.target === event.currentTarget) setSelectedText(null);
                      }}
                    >
                      {texts.map((text, index) => {
                        if (!text.text.trim()) return null;
                        const selected = selectedText === index;
                        const deleted = text.deleted;
                        const fitted = fitText(
                          text.text,
                          Math.max(1, text.box.w - 8),
                          Math.max(1, text.box.h - 8),
                          font.scale,
                        );
                        const fontSize = fitted.fs * (stageW / Math.max(1, data.width));
                        const handleSize = 10 / view.scale;
                        return (
                          <div
                            key={`text-${text.index}`}
                            className={`absolute touch-none select-none ${selected ? "z-20" : "z-10"}`}
                            style={{
                              left: `${(text.box.x / data.width) * 100}%`,
                              top: `${(text.box.y / data.height) * 100}%`,
                              width: `${(text.box.w / data.width) * 100}%`,
                              height: `${(text.box.h / data.height) * 100}%`,
                            }}
                            onPointerDown={(event) => startTextDrag(event, index, null)}
                            onPointerMove={onTextDragMove}
                            onPointerUp={onTextDragEnd}
                            onPointerCancel={onTextDragEnd}
                          >
                            <div
                              className={`pointer-events-none absolute inset-0 border ${
                                deleted
                                  ? selected
                                    ? "border-2 border-red-500"
                                    : "border border-dashed border-red-500/60"
                                  : selected
                                    ? "border-2 border-amber-500"
                                    : "border border-dashed border-amber-500/35"
                              }`}
                            />
                            <div
                              className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden px-1 text-center"
                              style={{
                                fontFamily: fontStack(font.family),
                                fontWeight: font.bold ? 700 : 400,
                                fontSize: `${fontSize}px`,
                                lineHeight: 1.25,
                                whiteSpace: "pre-wrap",
                                color: deleted ? "#ef4444" : "#111111",
                                opacity: deleted ? 0.55 : 1,
                                textDecoration: deleted ? "line-through" : undefined,
                              }}
                            >
                              {fitted.lines.join("\n")}
                            </div>
                            {deleted && (
                              <svg
                                className="pointer-events-none absolute inset-0 h-full w-full"
                                viewBox="0 0 100 100"
                                preserveAspectRatio="none"
                                aria-hidden
                              >
                                <line
                                  x1="0"
                                  y1="0"
                                  x2="100"
                                  y2="100"
                                  stroke="#ef4444"
                                  strokeWidth={1.5}
                                  opacity={0.85}
                                  vectorEffect="non-scaling-stroke"
                                />
                                <line
                                  x1="100"
                                  y1="0"
                                  x2="0"
                                  y2="100"
                                  stroke="#ef4444"
                                  strokeWidth={1.5}
                                  opacity={0.85}
                                  vectorEffect="non-scaling-stroke"
                                />
                              </svg>
                            )}
                            {selected &&
                              !deleted &&
                              HANDLES.map((h) => {
                                const left = h.includes("w") ? "0%" : h.includes("e") ? "100%" : "50%";
                                const top = h.includes("n") ? "0%" : h.includes("s") ? "100%" : "50%";
                                const cursor =
                                  h === "n" || h === "s"
                                    ? "ns-resize"
                                    : h === "e" || h === "w"
                                      ? "ew-resize"
                                      : h === "nw" || h === "se"
                                        ? "nwse-resize"
                                        : "nesw-resize";
                                return (
                                  <div
                                    key={h}
                                    onPointerDown={(event) => startTextDrag(event, index, h)}
                                    className="absolute rounded-sm border border-amber-500 bg-white"
                                    style={{
                                      left,
                                      top,
                                      width: handleSize,
                                      height: handleSize,
                                      transform: "translate(-50%, -50%)",
                                      cursor,
                                    }}
                                  />
                                );
                              })}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="bg-muted/30 text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-1.5 text-[11px]">
          {tab === "mask" ? (
            <>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm border bg-white" />
                brush (warna kertas)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm border border-dashed border-amber-500" />
                mask otomatis
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm border border-red-500 bg-red-500/20" />
                dihapus
              </span>
              <span className="ml-auto tabular-nums">
                {strokes.length}/{MAX_STROKES} goresan · {autoCount} mask
                {deletedCount > 0 ? ` · ${deletedCount} dihapus` : ""}
              </span>
            </>
          ) : (
            <>
              <span>Klik kotak untuk ubah isi/font · geser untuk pindah · handle untuk ukuran.</span>
              {maskDirty && (
                <span className="text-amber-600">
                  Perubahan mask belum diterapkan — pratinjau memakai mask tersimpan.
                </span>
              )}
              <span className="ml-auto tabular-nums">
                {editedTextCount} kotak diubah
                {deletedTextCount > 0 ? ` · ${deletedTextCount} dihapus` : ""} · {font.family}
                {font.bold ? " Bold" : ""} · {font.scale}%
              </span>
            </>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
          {saveError && <p className="text-destructive w-full text-xs">{saveError}</p>}
          {draftNotice && (
            <p className="text-muted-foreground text-xs">
              Draf koreksi dipulihkan.{" "}
              <button type="button" className="underline underline-offset-2" onClick={discardDraft}>
                Buang draf
              </button>
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            {tab === "text"
              ? "Pratinjau font & posisi teks. Terapkan untuk merender hasil akhir."
              : "Preview langsung memakai warna kertas; Terapkan menyimpan ke hasil & ZIP/PDF."}
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
