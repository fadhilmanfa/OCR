// Layout teks terjemahan di dalam box. Dipakai server (overlay) dan client
// (pratinjau workspace teks) agar hasil wrap & ukuran huruf sama persis.
export const MIN_FONT = 4;
export const START_FONT = 22; // sengaja kecil agar teks muat rapi di dalam elips

// CJK = lebar penuh (≈1em), latin ≈0.55em. Termasuk tanda baca CJK/fullwidth
// agar tidak disisipi spasi ("你好，世界").
const CJK_RE =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/;

function charWidth(ch: string, fontSize: number): number {
  return CJK_RE.test(ch) ? fontSize : fontSize * 0.55;
}

export function measureLine(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch, fontSize);
  return width;
}

function isCjk(ch: string): boolean {
  return CJK_RE.test(ch);
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let latin = "";
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (latin) {
        tokens.push(latin);
        latin = "";
      }
      continue;
    }
    if (isCjk(ch)) {
      if (latin) {
        tokens.push(latin);
        latin = "";
      }
      tokens.push(ch);
    } else {
      latin += ch;
    }
  }
  if (latin) tokens.push(latin);
  return tokens;
}

// Bungkus teks agar muat dalam lebar box pada font tertentu.
// Baris baru (\n) dari editor inline dipertahankan sebagai hard break.
export function wrapText(text: string, boxW: number, fontSize: number): string[] {
  const maxWidth = Math.max(fontSize, boxW);
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const tokens = tokenize(paragraph);
    if (!tokens.length) {
      lines.push("");
      continue;
    }
    let cur = "";
    for (const token of tokens) {
      // CJK bertemu CJK = tanpa spasi; selain itu beri spasi antar token.
      const last = cur.slice(-1);
      const sep = cur && !(isCjk(last) && isCjk(token[0])) ? " " : "";
      const candidate = cur + sep + token;
      if (measureLine(candidate, fontSize) <= maxWidth) {
        cur = candidate;
        continue;
      }
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      // Token tunggal (kata latin panjang) masih bisa melebihi lebar box.
      if (measureLine(token, fontSize) <= maxWidth) {
        cur = token;
        continue;
      }
      let piece = "";
      for (const ch of token) {
        if (piece && measureLine(piece + ch, fontSize) > maxWidth) {
          lines.push(piece);
          piece = "";
        }
        piece += ch;
      }
      cur = piece;
    }
    if (cur) lines.push(cur);
  }
  return lines.length ? lines : [""];
}

export interface FitTextResult {
  fs: number;
  lines: string[];
  lineH: number;
}

// Cari font terbesar yang muat (lebar & tinggi). `scale` (%) menaikkan /
// menurunkan batas atas-bawah agar slider font benar-benar berpengaruh.
// `maxFont` (px) mencegah font membesar saat bingkai diperbesar dari sisi.
export function fitText(
  text: string,
  boxW: number,
  boxH: number,
  scale = 100,
  maxFont?: number,
): FitTextResult {
  const natural = Math.max(1, Math.round(START_FONT * (scale / 100)));
  const cap =
    Number.isFinite(maxFont) && (maxFont as number) > 0
      ? Math.max(1, Math.min(natural, Math.floor(maxFont as number)))
      : natural;
  const min = Math.max(1, Math.round(MIN_FONT * (scale / 100)));
  const lower = Math.min(min, cap);
  for (let fs = cap; fs >= lower; fs -= 1) {
    const lines = wrapText(text, boxW, fs);
    const lineH = fs * 1.25;
    const totalH = lines.length * lineH;
    const totalW = Math.max(...lines.map((l) => measureLine(l, fs)), 1);
    if (totalH <= boxH && totalW <= boxW) return { fs, lines, lineH };
  }
  const fs = lower;
  return { fs, lines: wrapText(text, boxW, fs), lineH: fs * 1.25 };
}
