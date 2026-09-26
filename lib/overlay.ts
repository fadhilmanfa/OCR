import sharp from "sharp";
import type { BBox } from "./ocr";

const PAD = 2; // untuk layout teks fallback (area baca, bukan mask)
const MASK_INSET = 1; // mask DICUPET 1px dari box: box YOLO sudah memeluk
// outline, expand (+PAD seperti dulu) justru memutihkan ilustrasi di luar.
const MIN_FONT = 10;
const START_FONT = 22; // sengaja kecil agar teks ID muat rapi di dalam elips
const FONT_FAMILY = "'Comic Sans MS', 'Comic Sans', cursive";
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
  /** Kontur bubble dalam koordinat halaman (opsional; tanpa ini = elips). */
  polygon?: OverlayPolygonPoint[];
  /** Klasifikasi dari Python: rect | ellipse | freeform | unknown. */
  kind?: string;
  /** Saat kontur gagal, kotak teks Google dibersihkan sebagai persegi. */
  fallbackShape?: "rect";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Bungkus kata agar muat dalam lebar box pada font tertentu.
function wrap(text: string, boxW: number, fontSize: number): string[] {
  const avgChar = fontSize * 0.55;
  const maxChars = Math.max(8, Math.floor(boxW / avgChar));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (next.length <= maxChars) {
      cur = next;
    } else {
      if (cur) lines.push(cur);
      // Kata super panjang: potong paksa.
      if (w.length > maxChars) {
        for (let i = 0; i < w.length; i += maxChars) {
          lines.push(w.slice(i, i + maxChars));
        }
        cur = "";
      } else {
        cur = w;
      }
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Cari font terbesar yang muat (lebar & tinggi).
function fitFont(
  text: string,
  boxW: number,
  boxH: number,
): { fs: number; lines: string[]; lineH: number } {
  for (let fs = START_FONT; fs >= MIN_FONT; fs -= 2) {
    const lines = wrap(text, boxW, fs);
    const lineH = fs * 1.25;
    const totalH = lines.length * lineH;
    const longest = Math.max(...lines.map((l) => l.length), 1);
    const totalW = longest * fs * 0.55;
    if (totalH <= boxH && totalW <= boxW) return { fs, lines, lineH };
  }
  const fs = MIN_FONT;
  return { fs, lines: wrap(text, boxW, fs), lineH: fs * 1.25 };
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

// items: [{ text (ID), bbox:{x0,y0,x1,y1}, polygon?, kind? }]
// 1) tutup teks asli dengan PATH mengikuti kontur bubble (fallback: ELIPS
//    putih seperti dulu bila polygon hilang/tidak valid), 2) tulis teks ID
//    di tengah area aman polygon. Tidak pernah throw: gagal -> gambar asli.
export async function overlayTranslations(
  inputBuffer: Buffer,
  items: OverlayItem[],
): Promise<Buffer> {
  try {
    const meta = await sharp(inputBuffer).metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    if (!W || !H || !items.length) return inputBuffer;

    const cleanShapes = items
      .map((it) => {
        if (validPolygon(it.polygon)) {
          // Path kontur asli (sudah di tepi dalam outline): fill pas,
          // stroke 1px saja untuk menyegel anti-alias. Stroke 2px dulu
          // terbukti meluber memutihkan ilustrasi luar bubble.
          const d = esc(pathFromPolygon(it.polygon));
          return `<path d="${d}" fill="white" stroke="white" stroke-width="1" stroke-linejoin="round"/>`;
        }
        const b = it.bbox;
        if (it.fallbackShape === "rect") {
          const x = Math.max(0, Math.floor(b.x0) - PAD);
          const y = Math.max(0, Math.floor(b.y0) - PAD);
          const w = Math.min(W - x, Math.ceil(b.x1) + PAD - x);
          const h = Math.min(H - y, Math.ceil(b.y1) + PAD - y);
          return w > 4 && h > 4 ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white"/>` : "";
        }
        const x = Math.max(0, Math.floor(b.x0) + MASK_INSET);
        const y = Math.max(0, Math.floor(b.y0) + MASK_INSET);
        const w = Math.min(W - x, Math.ceil(b.x1 - b.x0) - MASK_INSET * 2);
        const h = Math.min(H - y, Math.ceil(b.y1 - b.y0) - MASK_INSET * 2);
        if (w <= 4 || h <= 4) return "";
        const cx = x + w / 2;
        const cy = y + h / 2;
        return `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(w / 2).toFixed(1)}" ry="${(h / 2).toFixed(1)}" fill="white"/>`;
      })
      .join("");

    const cleaned = await sharp(inputBuffer)
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
      .toBuffer();

    const texts = items
      .map((it) => {
        const { x, y, w, h } = textBox(it, W, H);
        if (w <= 10 || h <= 10) return "";
        const f = validPolygon(it.polygon) ? { w: 1, h: 1 } : innerFactor(it.fallbackShape);
        const iw = w * f.w;
        const ih = h * f.h;
        const { fs, lines, lineH } = fitFont(it.text, iw - 8, ih - 8);
        const totalH = lines.length * lineH;
        const cx = x + w / 2;
        let ty = y + (h - totalH) / 2 + lineH * 0.8;
        const tspans = lines
          .map((ln) => {
            const s = `<text x="${cx.toFixed(1)}" y="${ty.toFixed(1)}" font-family="${FONT_FAMILY}" font-size="${fs}" font-weight="bold" text-anchor="middle" fill="black">${esc(ln)}</text>`;
            ty += lineH;
            return s;
          })
          .join("");
        return tspans;
      })
      .join("");

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
