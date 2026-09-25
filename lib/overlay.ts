import sharp from "sharp";
import type { BBox } from "./ocr";

const PAD = 2; // cukup untuk anti-alias, tidak memutihkan garis bingkai dekat teks
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

// Faktor inner sesuai bentuk: rect penuh, elips standar, freeform konservatif.
function innerFactor(kind: string | undefined): { w: number; h: number } {
  if (kind === "rect") return { w: RECT_INNER_W, h: RECT_INNER_H };
  if (kind === "freeform") return { w: FREEFORM_INNER_W, h: FREEFORM_INNER_H };
  return { w: ELLIPSE_INNER_W, h: ELLIPSE_INNER_H };
}

// Area efektif untuk teks: bbox KETAT polygon (bukan bbox YOLO mentah)
// supaya teks tidak keluar dari bentuk asli bubble. Fallback = bbox YOLO + PAD.
function textBox(it: OverlayItem, W: number, H: number): { x: number; y: number; w: number; h: number } {
  if (validPolygon(it.polygon)) {
    const pb = polygonBBox(it.polygon);
    const x = Math.max(0, Math.floor(pb.x0));
    const y = Math.max(0, Math.floor(pb.y0));
    const w = Math.min(W - x, Math.ceil(pb.x1 - pb.x0));
    const h = Math.min(H - y, Math.ceil(pb.y1 - pb.y0));
    return { x, y, w, h };
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
//    di tengah bbox KETAT polygon. Tidak pernah throw: gagal -> gambar asli.
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
          // Path kontur asli: fill menutup teks, stroke tipis menyegel
          // sisa anti-alias di tepi outline tanpa memutihkan ilustrasi luar.
          const d = esc(pathFromPolygon(it.polygon));
          return `<path d="${d}" fill="white" stroke="white" stroke-width="2" stroke-linejoin="round"/>`;
        }
        const b = it.bbox;
        const x = Math.max(0, Math.floor(b.x0) - PAD);
        const y = Math.max(0, Math.floor(b.y0) - PAD);
        const w = Math.min(W - x, Math.ceil(b.x1 - b.x0) + PAD * 2);
        const h = Math.min(H - y, Math.ceil(b.y1 - b.y0) + PAD * 2);
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
        const f = innerFactor(validPolygon(it.polygon) ? it.kind : undefined);
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
