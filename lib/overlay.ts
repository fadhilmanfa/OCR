import sharp from "sharp";
import type { BBox } from "./ocr";
import { normalizeCleanMode, type CleanMode } from "./cleanMode";
import { fontStack, normalizeFont, type FontChoice } from "./fonts";
import { fitText } from "./textLayout";

const PAD = 2; // untuk layout teks fallback (area baca, bukan mask)
const MASK_INSET = 1; // mask DICUPET 1px dari box: box YOLO sudah memeluk
// outline, expand (+PAD seperti dulu) justru memutihkan ilustrasi di luar.
// Teks dimuat dalam persegi dalam elips (lebar ~0.72, tinggi ~0.70)
// supaya tidak menyentuh garis bubble.
const ELLIPSE_INNER_W = 0.72;
const ELLIPSE_INNER_H = 0.7;
// Bubble kotak hampir memenuhi bbox polygon -> boleh pakai area lebih besar.
// Awan pikiran / freeform bergerigi -> lebih konservatif dari elips.
const RECT_INNER_W = 0.86;
const RECT_INNER_H = 0.84;
const FREEFORM_INNER_W = 0.66;
const FREEFORM_INNER_H = 0.64;

export interface OverlayPolygonPoint {
  x: number;
  y: number;
}

export interface OverlayItem {
  text: string;
  bbox: BBox;
  /** Kontur bubble dalam koordinat halaman (opsional; tanpa ini = fallback). */
  polygon?: OverlayPolygonPoint[];
  /** Klasifikasi dari Python: rect | ellipse | freeform | unknown. */
  kind?: string;
  /** Saat kontur gagal: "rect" untuk kotak teks Google, "round" (kapsul
   *  inset 4%) untuk bubble YOLO agar sama dengan cleanAreas,
   *  "line" untuk mask per-baris yang tight, "manual" untuk kotak gambar
   *  user (persis, tanpa inset/expand). */
  fallbackShape?: "rect" | "round" | "line" | "manual";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function validPolygon(poly: OverlayPolygonPoint[] | undefined): poly is OverlayPolygonPoint[] {
  if (!Array.isArray(poly) || poly.length < 3 || poly.length > 512) return false;
  for (const p of poly) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  }
  return true;
}

function pathFromPolygon(poly: OverlayPolygonPoint[]): string {
  const parts = poly.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  return parts.join(" ") + " Z";
}

function polygonBBox(poly: OverlayPolygonPoint[]): BBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

function pointInPolygon(x: number, y: number, poly: OverlayPolygonPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

// Cari persegi terbesar yang benar-benar berada di dalam kontur. Faktor
// lebar/tinggi tetap tidak cukup untuk bubble kotak, awan, dan berekor.
function safeTextRect(poly: OverlayPolygonPoint[]): { x: number; y: number; w: number; h: number } | null {
  const b = polygonBBox(poly);
  const width = b.x1 - b.x0;
  const height = b.y1 - b.y0;
  if (width < 12 || height < 12) return null;
  const cols = 32;
  const rows = 32;
  const dx = width / cols;
  const dy = height / rows;
  const heights = Array<number>(cols).fill(0);
  let best: { x: number; y: number; w: number; h: number; score: number } | null = null;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = b.x0 + (col + 0.5) * dx;
      const y = b.y0 + (row + 0.5) * dy;
      heights[col] = pointInPolygon(x, y, poly) ? heights[col] + 1 : 0;
    }
    const stack: number[] = [];
    for (let col = 0; col <= cols; col++) {
      const current = col === cols ? 0 : heights[col];
      while (stack.length && heights[stack[stack.length - 1]] > current) {
        const at = stack.pop()!;
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const cellsW = col - left;
        const cellsH = heights[at];
        const area = cellsW * cellsH;
        const cx = (left + col) / 2 / cols;
        const cy = (row + 1 - cellsH / 2) / rows;
        const distance = Math.hypot(cx - 0.5, cy - 0.5);
        const score = area * (1 - Math.min(0.4, distance * 0.5));
        if (!best || score > best.score) {
          best = {
            x: b.x0 + left * dx,
            y: b.y0 + (row + 1 - cellsH) * dy,
            w: cellsW * dx,
            h: cellsH * dy,
            score,
          };
        }
      }
      stack.push(col);
    }
  }
  if (!best) return null;
  const inset = Math.max(2, Math.min(dx, dy));
  return {
    x: best.x + inset,
    y: best.y + inset,
    w: Math.max(0, best.w - inset * 2),
    h: Math.max(0, best.h - inset * 2),
  };
}

// Faktor inner sesuai bentuk: rect penuh, elips standar, freeform konservatif.
function innerFactor(kind: string | undefined): { w: number; h: number } {
  if (kind === "rect") return { w: RECT_INNER_W, h: RECT_INNER_H };
  if (kind === "freeform") return { w: FREEFORM_INNER_W, h: FREEFORM_INNER_H };
  return { w: ELLIPSE_INNER_W, h: ELLIPSE_INNER_H };
}

// Area efektif untuk teks: persegi aman di dalam polygon.
// Fallback = bbox deteksi/teks + PAD.
function textBox(it: OverlayItem, W: number, H: number): { x: number; y: number; w: number; h: number } {
  if (validPolygon(it.polygon)) {
    const safe = safeTextRect(it.polygon);
    if (safe && safe.w > 10 && safe.h > 10) {
      const x = Math.max(0, safe.x);
      const y = Math.max(0, safe.y);
      return { x, y, w: Math.min(W - x, safe.w), h: Math.min(H - y, safe.h) };
    }
  }
  const b = it.bbox;
  const x = Math.max(0, Math.floor(b.x0) - PAD);
  const y = Math.max(0, Math.floor(b.y0) - PAD);
  const w = Math.min(W - x, Math.ceil(b.x1 - b.x0) + PAD * 2);
  const h = Math.min(H - y, Math.ceil(b.y1 - b.y0) + PAD * 2);
  return { x, y, w, h };
}

// Posisi/ukuran kotak teks hasil geser/resize user di workspace teks.
export interface TextBoxOverride {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** true = teks terjemahan item ini tidak digambar (dihapus user). */
  deleted?: boolean;
  /** Isi teks pengganti hasil edit user (opsional). */
  text?: string;
}

export interface ResolvedTextBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function defaultTextBox(it: OverlayItem, W: number, H: number): ResolvedTextBox {
  return textBox(it, W, H);
}

// Box efektif: override user dipakai PERSIS (tanpa inset/expand), hanya
// di-clamp ke batas halaman. Tanpa override = box otomatis.
export function textBoxFor(
  it: OverlayItem,
  override: TextBoxOverride | undefined,
  W: number,
  H: number,
): ResolvedTextBox {
  if (!override) return textBox(it, W, H);
  const x = Math.max(0, Math.min(Math.max(0, W - 1), override.x));
  const y = Math.max(0, Math.min(Math.max(0, H - 1), override.y));
  const w = Math.max(1, Math.min(W - x, override.w));
  const h = Math.max(1, Math.min(H - y, override.h));
  return { x, y, w, h };
}

// Area teks efektif: box luar dikurangi inner factor (elips/freeform/fallback)
// dan dipusatkan. Editor memakai ini agar preview client memakai ukuran area
// yang sama dengan server (yang menghitung fitText dari w/h area ini).
export function textAreaFor(
  it: OverlayItem,
  override: TextBoxOverride | undefined,
  W: number,
  H: number,
): ResolvedTextBox {
  const outer = textBoxFor(it, override, W, H);
  const f = override || validPolygon(it.polygon) ? { w: 1, h: 1 } : innerFactor(it.fallbackShape);
  const w = outer.w * f.w;
  const h = outer.h * f.h;
  return {
    x: outer.x + (outer.w - w) / 2,
    y: outer.y + (outer.h - h) / 2,
    w,
    h,
  };
}

// Bentuk area yang ditutup mask: kontur bubble, persegi fallback, atau elips.
// Disimpan terpisah dari SVG agar bisa dipakai juga untuk mengambil sampel
// warna kertas di mode "bubble".
type MaskGeometry =
  | { kind: "polygon"; polygon: OverlayPolygonPoint[]; bbox: BBox }
  | {
      kind: "rect";
      rect: { x: number; y: number; w: number; h: number; radius?: number };
      bbox: BBox;
      /** Kontur bubble untuk memotong mask (mis. mask baris dekat tepi). */
      clip?: OverlayPolygonPoint[];
    }
  | { kind: "ellipse"; ellipse: { cx: number; cy: number; rx: number; ry: number }; bbox: BBox };

// Bentuk minimal untuk mask: dipenuhi OverlayItem maupun CleanArea.
// "round" = kotak sudut membulat, fallback untuk bubble yang konturnya gagal
// (lebih enak dilihat daripada persegi tajam, tapi tetap menutup seluruh teks).
// "line" = mask per BARIS teks (rapi, tidak oversize): box diperlebar sedikit
// agar tepi huruf tertutup, radius kecil.
// "manual" = kotak yang digambar user di editor: diisi PERSIS sesuai kotak
// (tanpa inset/expand), hanya di-clamp ke batas gambar.
// "none" = mask dinonaktifkan user dari editor; area tetap ada di daftar agar
// maskSources tidak jatuh ke fallback per kotak teks.
// clipPolygon = kontur bubble; mask kotak dipotong agar tidak melewati garis.
interface MaskSource {
  bbox: BBox;
  polygon?: OverlayPolygonPoint[];
  clipPolygon?: OverlayPolygonPoint[];
  kind?: string;
  fallbackShape?: "rect" | "round" | "line" | "manual" | "none";
}

function maskGeometry(it: MaskSource, W: number, H: number): MaskGeometry | null {
  if (it.fallbackShape === "none") return null;
  if (validPolygon(it.polygon)) {
    return { kind: "polygon", polygon: it.polygon, bbox: polygonBBox(it.polygon) };
  }
  const b = it.bbox;
  const clip = validPolygon(it.clipPolygon) ? it.clipPolygon : undefined;
  if (it.fallbackShape === "manual") {
    const x = Math.max(0, Math.floor(b.x0));
    const y = Math.max(0, Math.floor(b.y0));
    const w = Math.min(W - x, Math.ceil(b.x1) - x);
    const h = Math.min(H - y, Math.ceil(b.y1) - y);
    if (w <= 1 || h <= 1) return null;
    return {
      kind: "rect",
      rect: { x, y, w, h, radius: Math.min(3, Math.floor(Math.min(w, h) / 4)) },
      bbox: { x0: x, y0: y, x1: x + w, y1: y + h },
    };
  }
  if (it.fallbackShape === "line") {
    // Mask per baris: TIGHT tapi menutup tepi huruf (expand 2-6px).
    // Beda dengan "round" yang INSET (mengecil) untuk menjaga outline bubble.
    const bw = Math.ceil(b.x1) - Math.floor(b.x0);
    const bh = Math.ceil(b.y1) - Math.floor(b.y0);
    const pad = Math.max(2, Math.min(6, Math.round(Math.min(bw, bh) * 0.15)));
    const x = Math.max(0, Math.floor(b.x0) - pad);
    const y = Math.max(0, Math.floor(b.y0) - pad);
    const w = Math.min(W - x, Math.ceil(b.x1) + pad - x);
    const h = Math.min(H - y, Math.ceil(b.y1) + pad - y);
    if (w <= 4 || h <= 4) return null;
    const radius = Math.min(6, Math.floor(Math.min(w, h) / 4));
    return {
      kind: "rect",
      rect: { x, y, w, h, radius },
      bbox: { x0: x, y0: y, x1: x + w, y1: y + h },
      clip,
    };
  }
  if (it.fallbackShape === "rect" || it.fallbackShape === "round") {
    // Fallback TIDAK boleh memakai seluruh box deteksi: box YOLO memeluk
    // outline, jadi mengisinya penuh akan menghapus garis bubble dan
    // meluber ke art ("bubble kemakan"). Masuk ke dalam beberapa piksel
    // supaya outline tetap utuh.
    const bw = Math.ceil(b.x1) - Math.floor(b.x0);
    const bh = Math.ceil(b.y1) - Math.floor(b.y0);
    const inset = Math.max(3, Math.min(8, Math.round(Math.min(bw, bh) * 0.04)));
    const x = Math.max(0, Math.floor(b.x0) + inset);
    const y = Math.max(0, Math.floor(b.y0) + inset);
    const w = Math.min(W - x, Math.ceil(b.x1) - inset - x);
    const h = Math.min(H - y, Math.ceil(b.y1) - inset - y);
    if (w <= 4 || h <= 4) return null;
    // Kapsul/elips, bukan kotak: untuk bubble awan, sudut kotak akan
    // menutupi lekuk outline. Radius = setengah sisi terpendek membuat
    // bentuknya mendekati elips (kotak memanjang jadi kapsul).
    const radius =
      it.fallbackShape === "round"
        ? Math.max(6, Math.floor(Math.min(w, h) / 2))
        : undefined;
    return {
      kind: "rect",
      rect: { x, y, w, h, radius },
      bbox: { x0: x, y0: y, x1: x + w, y1: y + h },
      clip,
    };
  }
  const bw0 = Math.ceil(b.x1) - Math.floor(b.x0);
  const bh0 = Math.ceil(b.y1) - Math.floor(b.y0);
  // Elips fallback untuk box BESAR (bubble YOLO tanpa kontur) harus inset
  // proporsional seperti "round" (4%, 3-8px). Dulu selalu 1px sehingga elips
  // hampir selebar box YOLO yang memeluk outline + ekor: lingkaran putih
  // terlihat offside/meluber keluar garis bubble. Box kecil (teks full-page)
  // tetap inset 1px agar teks asli tertutup rapat.
  const largeBubble = Math.min(bw0, bh0) > 60;
  const eInset = largeBubble
    ? Math.max(3, Math.min(8, Math.round(Math.min(bw0, bh0) * 0.04)))
    : MASK_INSET;
  const x = Math.max(0, Math.floor(b.x0) + eInset);
  const y = Math.max(0, Math.floor(b.y0) + eInset);
  const w = Math.min(W - x, Math.ceil(b.x1 - b.x0) - eInset * 2);
  const h = Math.min(H - y, Math.ceil(b.y1 - b.y0) - eInset * 2);
  if (w <= 4 || h <= 4) return null;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    kind: "ellipse",
    ellipse: { cx, cy, rx: w / 2, ry: h / 2 },
    bbox: { x0: x, y0: y, x1: x + w, y1: y + h },
  };
}

// Geser tiap titik 1px ke arah pusat polygon. Kontur OpenCV kadang berada
// tepat di tepi luar garis bubble; tanpa inset, fill ikut menutup garis
// hitamnya sehingga bubble terlihat "hilang".
function insetPolygon(points: OverlayPolygonPoint[], px: number): OverlayPolygonPoint[] {
  const b = polygonBBox(points);
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  return points.map((p) => {
    const dx = cx - p.x;
    const dy = cy - p.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) return p;
    return { x: p.x + (dx / len) * px, y: p.y + (dy / len) * px };
  });
}

function fillShapeSvg(g: MaskGeometry, color: string, key = "0"): string {
  if (g.kind === "polygon") {
    // Path kontur asli, diinset supaya garis bubble tetap terlihat walau
    // kontur OpenCV berada di tepi luar outline.
    const d = esc(pathFromPolygon(insetPolygon(g.polygon, 2.5)));
    return `<path d="${d}" fill="${color}" stroke="${color}" stroke-width="0.5" stroke-linejoin="round"/>`;
  }
  if (g.kind === "rect") {
    const { x, y, w, h, radius } = g.rect;
    const round = radius ? ` rx="${radius}" ry="${radius}"` : "";
    const rect = `<rect x="${x}" y="${y}" width="${w}" height="${h}"${round} fill="${color}"/>`;
    // Mask kotak (terutama per baris) dipotong ke kontur bubble agar
    // tidak meluber melewati garis bubble / ke ilustrasi di luar.
    if (!validPolygon(g.clip)) return rect;
    const id = `mask-clip-${key}`;
    const d = esc(pathFromPolygon(insetPolygon(g.clip, 2.5)));
    return `<defs><clipPath id="${id}"><path d="${d}"/></clipPath></defs><rect x="${x}" y="${y}" width="${w}" height="${h}"${round} fill="${color}" clip-path="url(#${id})"/>`;
  }
  const { cx, cy, rx, ry } = g.ellipse;
  return `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="${color}"/>`;
}

export type BrushPoint = [number, number];

// Goresan brush dari editor koreksi mask. `erase` menghapus bagian goresan
// sebelumnya (bukan menambah mask), persis seperti kanvas: urutan goresan
// menentukan hasil akhir.
export interface BrushStroke {
  mode: "paint" | "erase";
  size: number;
  points: BrushPoint[];
}

function brushBBox(s: BrushStroke): BBox {
  const r = s.size / 2;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of s.points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
}

function brushShapeSvg(s: BrushStroke, color: string): string {
  const [first] = s.points;
  if (s.points.length === 1) {
    return `<circle cx="${first[0].toFixed(1)}" cy="${first[1].toFixed(1)}" r="${(s.size / 2).toFixed(1)}" fill="${color}"/>`;
  }
  const d = s.points
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${s.size.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// Goresan paint diwarnai warna kertas; goresan erase sesudahnya dipotong lewat
// <mask> sehingga urutan paint→erase→paint sama dengan kanvas editor. Semua
// goresan digabung dalam satu SVG = satu pass compositing, bukan N pass sharp.
function brushLayerSvg(
  strokes: BrushStroke[],
  colors: Array<string | null>,
  W: number,
  H: number,
): string {
  const defs: string[] = [];
  const shapes: string[] = [];
  let paint = 0;
  strokes.forEach((s, i) => {
    if (s.mode === "erase") return;
    const color = colors[paint++] || "white";
    const shape = brushShapeSvg(s, color);
    const erasers = strokes.slice(i + 1).filter((later) => later.mode === "erase");
    if (!erasers.length) {
      shapes.push(shape);
      return;
    }
    const id = `brush-erase-${i}`;
    defs.push(
      `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">` +
        `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>` +
        erasers.map((e) => brushShapeSvg(e, "#000000")).join("") +
        `</mask>`,
    );
    shapes.push(`<g mask="url(#${id})">${shape}</g>`);
  });
  return `<defs>${defs.join("")}</defs>${shapes.join("")}`;
}

function inGeometry(g: MaskGeometry, x: number, y: number): boolean {
  if (g.kind === "polygon") return pointInPolygon(x, y, g.polygon);
  if (g.kind === "rect") {
    return x >= g.rect.x && x < g.rect.x + g.rect.w && y >= g.rect.y && y < g.rect.y + g.rect.h;
  }
  const nx = (x - g.ellipse.cx) / g.ellipse.rx;
  const ny = (y - g.ellipse.cy) / g.ellipse.ry;
  return nx * nx + ny * ny <= 1;
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

type PaperSample = { lum: number; r: number; g: number; b: number };

// Warna dominan (bukan median): kertas biasanya menutupi area terbesar,
// sedangkan garis huruf / outline hanya minoritas. Kuantisasi 4-bit per
// kanal supaya gradien tipis tidak memecah kelompok yang sama.
function dominantColor(samples: PaperSample[]): string | null {
  if (samples.length < 8) return null;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (const s of samples) {
    const key = ((s.r >> 4) << 8) | ((s.g >> 4) << 4) | (s.b >> 4);
    const cur = buckets.get(key);
    if (cur) {
      cur.n++;
      cur.r += s.r;
      cur.g += s.g;
      cur.b += s.b;
    } else {
      buckets.set(key, { n: 1, r: s.r, g: s.g, b: s.b });
    }
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.n > best.n) best = bucket;
  }
  if (!best) return null;
  return toHex(best.r / best.n, best.g / best.n, best.b / best.n);
}

// Ambil warna kertas tiap area dari gambar aslinya.
//
// - Kontur bubble (polygon) mencakup seluruh bubble: median piksel DI DALAM
//   kontur. Huruf asli minoritas, jadi hasilnya warna kertas bubble.
// - Kotak/elips teks (tanpa kontur) sempit dan hurufnya memenuhi kotak:
//   median di dalam kotak jadi abu-abu. Karena itu sampel diambil dari CINCIN
//   di luar mask (paper di sekitar huruf), lalu fallback ke dalam bila cincin
//   kosong.
//
// Sampel dibatasi ±3.000 piksel per bentuk.
async function samplePaperColors(
  inputBuffer: Buffer,
  geometries: Array<MaskGeometry | null>,
  W: number,
  H: number,
): Promise<Array<string | null>> {
  try {
    const { data, info } = await sharp(inputBuffer)
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels;

    return geometries.map((g) => {
      if (!g) return null;

      const collect = (
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        wantInside: boolean,
      ): PaperSample[] => {
        const area = Math.max(1, (x1 - x0) * (y1 - y0));
        const stride = Math.max(1, Math.floor(Math.sqrt(area / 3000)));
        const out: PaperSample[] = [];
        for (let y = y0; y < y1; y += stride) {
          for (let x = x0; x < x1; x += stride) {
            if (inGeometry(g, x, y) !== wantInside) continue;
            const i = (y * W + x) * channels;
            const r = data[i];
            const gg = data[i + 1];
            const b = data[i + 2];
            out.push({ lum: 0.2126 * r + 0.7152 * gg + 0.0722 * b, r, g: gg, b });
          }
        }
        return out;
      };

      const bx0 = Math.max(0, Math.floor(g.bbox.x0));
      const by0 = Math.max(0, Math.floor(g.bbox.y0));
      const bx1 = Math.min(W, Math.ceil(g.bbox.x1));
      const by1 = Math.min(H, Math.ceil(g.bbox.y1));

      if (g.kind === "polygon") {
        return dominantColor(collect(bx0, by0, bx1, by1, true));
      }

      // Cincin selebar ±60% sisi terpendek (maks 48px) di luar mask, agar
      // sampel tidak terjebak di outline putih huruf judul.
      const shortSide = Math.min(bx1 - bx0, by1 - by0);
      const margin = Math.min(48, Math.max(6, Math.round(shortSide * 0.6)));
      const rx0 = Math.max(0, bx0 - margin);
      const ry0 = Math.max(0, by0 - margin);
      const rx1 = Math.min(W, bx1 + margin);
      const ry1 = Math.min(H, by1 + margin);
      return dominantColor(collect(rx0, ry0, rx1, ry1, false)) ?? dominantColor(collect(bx0, by0, bx1, by1, true));
    });
  } catch (e) {
    console.warn(`[overlay] sampling warna gagal, pakai putih. (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
    return geometries.map(() => null);
  }
}

// Area yang ditimpa, terpisah dari teks. Dipakai untuk membersihkan SELURUH
// bubble (termasuk bubble yang tidak menghasilkan teks OCR) atau, bila
// tersedia kotak baris, membersihkan per BARIS teks (rapi, tidak oversize).
export interface CleanArea {
  bbox: BBox;
  polygon?: OverlayPolygonPoint[];
  /** Kontur bubble untuk memotong kotak mask (mask baris dekat tepi). */
  clipPolygon?: OverlayPolygonPoint[];
  kind?: string;
  fallbackShape?: "rect" | "round" | "line" | "manual" | "none";
}

// Perubahan user atas mask OTOMATIS (garis kuning di editor). Disimpan
// per-indeks cleanAreas: bbox baru = kotak digeser/diubah ukuran, deleted =
// mask dimatikan. Indeks tetap valid karena cleanAreas tidak berubah setelah
// halaman diproses.
export interface AutoMaskEdit {
  index: number;
  bbox?: BBox;
  deleted?: boolean;
}

// Terapkan edit otomatis ke daftar cleanAreas. Area yang dihapus diganti
// placeholder "none" (bukan dibuang) supaya jumlah area tetap > 0 dan
// overlayTranslations tidak jatuh ke fallback "setiap kotak teks ditimpa".
export function applyAutoMaskEdits(
  areas: CleanArea[],
  edits: AutoMaskEdit[] | undefined,
): CleanArea[] {
  if (!edits?.length) return areas;
  const byIndex = new Map<number, AutoMaskEdit>();
  for (const edit of edits) byIndex.set(edit.index, edit);
  return areas.map((area, i) => {
    const edit = byIndex.get(i);
    if (!edit) return area;
    if (edit.deleted || !edit.bbox) {
      return { bbox: area.bbox, fallbackShape: "none" };
    }
    // Kotak user menggantikan kontur bubble: mask mengikuti kotak persis.
    return { bbox: edit.bbox, fallbackShape: "manual" };
  });
}

// items: [{ text (ID), bbox:{x0,y0,x1,y1}, polygon?, kind? }]
// options.cleanAreas: kalau diisi, hanya area ini yang ditimpa (seluruh
// bubble), dan kotak teks di luar bubble dibiarkan utuh. Kalau kosong,
// perilaku lama: setiap text box ditimpa sendiri.
// 1) tutup area dengan putih (mode "white"), warna kertas (mode "bubble"),
//    atau tidak menutup apa pun (mode "none"); 2) tulis teks ID di tengah
//    area aman polygon. Tidak pernah throw: gagal -> gambar asli.
export async function overlayTranslations(
  inputBuffer: Buffer,
  items: OverlayItem[],
  options: {
    cleanMode?: CleanMode;
    cleanAreas?: CleanArea[];
    manualStrokes?: BrushStroke[];
    font?: FontChoice;
    textOverrides?: TextBoxOverride[];
  } = {},
): Promise<Buffer> {
  try {
    const meta = await sharp(inputBuffer).metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    const cleanAreas = options.cleanAreas ?? [];
    const manualStrokes = (options.manualStrokes ?? []).filter(
      (s) =>
        Array.isArray(s.points) &&
        s.points.length > 0 &&
        Number.isFinite(s.size) &&
        s.size > 0 &&
        s.points.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])),
    );
    if (!W || !H || (!items.length && !cleanAreas.length && !manualStrokes.length)) return inputBuffer;

    const cleanMode = normalizeCleanMode(options.cleanMode);
    const font = normalizeFont(options.font);
    const overrideMap = new Map<number, TextBoxOverride>();
    for (const override of options.textOverrides ?? []) {
      if (
        Number.isInteger(override.index) &&
        Number.isFinite(override.x) &&
        Number.isFinite(override.y) &&
        Number.isFinite(override.w) &&
        Number.isFinite(override.h) &&
        override.w > 0 &&
        override.h > 0
      ) {
        overrideMap.set(override.index, override);
      }
    }
    // Sumber bentuk mask: area bubble (kalau ada) atau text box masing-masing.
    const maskSources: Array<CleanArea | OverlayItem> = cleanAreas.length ? cleanAreas : items;
    const maskGeometries = maskSources.map((it) => maskGeometry(it, W, H));
    const itemGeometries = items.map((it) => maskGeometry(it, W, H));
    // Warna kertas untuk tiap goresan paint di-sample dari cincin di luar
    // bounding box goresan, sama seperti mask manual kotak.
    const paintStrokes = manualStrokes.filter((s) => s.mode !== "erase");
    const brushGeometries = paintStrokes.map((s) => {
      const b = brushBBox(s);
      const x = Math.max(0, Math.floor(b.x0));
      const y = Math.max(0, Math.floor(b.y0));
      const x1 = Math.min(W, Math.ceil(b.x1));
      const y1 = Math.min(H, Math.ceil(b.y1));
      return {
        kind: "rect" as const,
        rect: { x, y, w: Math.max(1, x1 - x), h: Math.max(1, y1 - y) },
        bbox: { x0: x, y0: y, x1, y1 },
      };
    });

    // Sampling warna hanya perlu kalau hasilnya dipakai: isi mask mode
    // "bubble", atau penentu warna huruf saat mask tidak putih.
    const sampled =
      cleanMode === "white"
        ? []
        : await samplePaperColors(
            inputBuffer,
            [...maskGeometries, ...itemGeometries, ...brushGeometries],
            W,
            H,
          );
    const maskPaper = sampled.slice(0, maskGeometries.length);
    const itemPaper = sampled.slice(
      maskGeometries.length,
      maskGeometries.length + itemGeometries.length,
    );
    const brushPaper = sampled.slice(maskGeometries.length + itemGeometries.length);

    // Teks yang berada DI DALAM bubble ikut ditimpa per kotak teks. Ini
    // menutup sisa huruf di tepi bubble saat mask bubble berupa kapsul
    // fallback yang lebih kecil dari bubble aslinya. Teks di luar bubble
    // (SFX) tetap tidak disentuh.
    // Pengecualian per-baris: bila cleanAreas sudah berupa mask "line"
    // (tight per kalimat), JANGAN tambah mask whole-bubble lagi — itu yang
    // dulu membuat lingkaran putih oversize/offside. Syarat extra hanya bila
    // item lebih kecil dari mask (kotak teks di dalam bubble besar).
    const extraMasks: Array<{ g: MaskGeometry; color: string }> = [];
    if (cleanAreas.length && cleanMode !== "none") {
      const allLines = cleanAreas.every((a) => a.fallbackShape === "line" && !a.polygon);
      if (!allLines) {
        itemGeometries.forEach((ig) => {
          if (!ig) return;
          const cx = (ig.bbox.x0 + ig.bbox.x1) / 2;
          const cy = (ig.bbox.y0 + ig.bbox.y1) / 2;
          const mi = maskGeometries.findIndex((mg) => mg && inGeometry(mg, cx, cy));
          if (mi < 0) return;
          const mg = maskGeometries[mi]!;
          const igArea = (ig.bbox.x1 - ig.bbox.x0) * (ig.bbox.y1 - ig.bbox.y0);
          const mgArea = Math.max(1, (mg.bbox.x1 - mg.bbox.x0) * (mg.bbox.y1 - mg.bbox.y0));
          if (igArea > mgArea * 1.2) return;
          extraMasks.push({
            g: ig,
            color: cleanMode === "bubble" || cleanMode === "text" ? maskPaper[mi] || "white" : "white",
          });
        });
      }
    }

    const cleanShapes =
      cleanMode === "none"
        ? ""
        : [
            ...maskGeometries.map((g, k) => {
              if (!g) return "";
              const color = cleanMode === "bubble" || cleanMode === "text" ? maskPaper[k] || "white" : "white";
              return fillShapeSvg(g, color, `m${k}`);
            }),
            ...extraMasks.map(({ g, color }, k) => fillShapeSvg(g, color, `x${k}`)),
          ].join("");

    let cleaned = cleanShapes
      ? await sharp(inputBuffer)
          .composite([
            {
              input: Buffer.from(
                `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${cleanShapes}</svg>`,
              ),
              left: 0,
              top: 0,
            },
          ])
          .png()
          .toBuffer()
      : inputBuffer;

    // Koreksi brush manual: goresan user menimpa area apa pun (termasuk yang
    // tidak terdeteksi OCR), dengan urutan paint/erase seperti di editor.
    const brushShapes =
      cleanMode !== "none" && manualStrokes.length
        ? brushLayerSvg(manualStrokes, brushPaper, W, H)
        : "";
    if (brushShapes) {
      cleaned = await sharp(cleaned)
        .composite([
          {
            input: Buffer.from(
              `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${brushShapes}</svg>`,
            ),
            left: 0,
            top: 0,
          },
        ])
        .png()
        .toBuffer();
    }

    const texts = items
      .map((it, k) => {
        const override = overrideMap.get(k);
        // Teks yang dihapus user: area tetap dibersihkan, tapi tidak digambar.
        if (override?.deleted) return "";
        const label = typeof override?.text === "string" ? override.text : it.text;
        if (!label.trim()) return "";
        const { x, y, w, h } = textBoxFor(it, override, W, H);
        if (w <= 10 || h <= 10) return "";
        const f =
          override || validPolygon(it.polygon) ? { w: 1, h: 1 } : innerFactor(it.fallbackShape);
        const iw = w * f.w;
        const ih = h * f.h;
        const { fs, lines, lineH } = fitText(label, iw - 8, ih - 8, font.scale);
        const totalH = lines.length * lineH;
        const cx = x + w / 2;
        // Di mode "bubble"/"none", huruf ikut kontras dengan warna kertas:
        // hitam di kertas terang, putih di panel/bubble gelap.
        const paperColor = itemPaper[k];
        const ink = paperColor && luminance(paperColor) < 0.45 ? "white" : "black";
        const family = esc(fontStack(font.family));
        const weight = font.bold ? "bold" : "normal";
        let ty = y + (h - totalH) / 2 + lineH * 0.8;
        const tspans = lines
          .map((ln) => {
            const s = `<text x="${cx.toFixed(1)}" y="${ty.toFixed(1)}" font-family="${family}" font-size="${fs}" font-weight="${weight}" text-anchor="middle" fill="${ink}">${esc(ln)}</text>`;
            ty += lineH;
            return s;
          })
          .join("");
        return tspans;
      })
      .join("");

    if (!texts) return cleaned;

    return sharp(cleaned)
      .composite([
        {
          input: Buffer.from(
            `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${texts}</svg>`,
          ),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
  } catch (e) {
    console.warn(`[overlay] gagal, pakai gambar asli. (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
    return inputBuffer;
  }
}
