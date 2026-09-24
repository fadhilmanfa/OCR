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

export interface OverlayItem {
  text: string;
  bbox: BBox;
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

// items: [{ text (ID), bbox:{x0,y0,x1,y1} }]
// 1) tutup teks asli dengan ELIPS putih (mengikuti bentuk bubble, sudut
//    gambar tidak ikut diputihkan), 2) tulis teks ID di tengah elips.
export async function overlayTranslations(
  inputBuffer: Buffer,
  items: OverlayItem[],
): Promise<Buffer> {
  const meta = await sharp(inputBuffer).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;

  const cleanShapes = items
    .map((it) => {
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
      const b = it.bbox;
      const x = Math.max(0, Math.floor(b.x0) - PAD);
      const y = Math.max(0, Math.floor(b.y0) - PAD);
      const w = Math.min(W - x, Math.ceil(b.x1 - b.x0) + PAD * 2);
      const h = Math.min(H - y, Math.ceil(b.y1 - b.y0) + PAD * 2);
      if (w <= 10 || h <= 10) return "";
      const iw = w * ELLIPSE_INNER_W;
      const ih = h * ELLIPSE_INNER_H;
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
}
