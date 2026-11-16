// Metadata render per halaman, disimpan bersama output job (TTL 10 menit).
// Dipakai editor mask manual: butuh gambar ASLI + daftar terjemahan + mask
// otomatis agar halaman bisa dirender ulang tanpa mengulang OCR/translate.
import fs from "fs";
import path from "path";
import type { CleanArea, OverlayItem } from "./overlay";
import type { CleanMode } from "./cleanMode";

export const RENDER_FILE = ".render.json";
export const SOURCE_DIR = ".src";

export interface StoredPage {
  file: string;
  /** Nama file sumber di dalam folder .src (tanpa path). */
  sourceFile: string;
  width: number;
  height: number;
  cleanMode: CleanMode;
  items: OverlayItem[];
  /** Mask otomatis hasil proses (garis/bubble/region). */
  cleanAreas: CleanArea[];
  /** Kotak tambahan dari user; disimpan agar editor bisa dibuka lagi. */
  manualMasks: CleanArea[];
  /** Jumlah bubble tanpa teks OCR (dibiarkan utuh). */
  undetected: number;
}

export interface RenderStore {
  version: 1;
  pages: Record<string, StoredPage>;
}

export function renderStorePath(jobDir: string): string {
  return path.join(jobDir, RENDER_FILE);
}

export function sourceFilePath(jobDir: string, sourceFile: string): string {
  // sourceFile selalu basename dari proses internal; tolak apa pun yang
  // mencoba keluar folder .src.
  const base = path.basename(sourceFile);
  return path.join(jobDir, SOURCE_DIR, base);
}

export function safeSourceName(file: string, index: number): string {
  const base = path.parse(file).name.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80);
  return `${String(index + 1).padStart(4, "0")}-${base || "page"}.png`;
}

export function readRenderStore(jobDir: string): RenderStore | null {
  try {
    const raw = fs.readFileSync(renderStorePath(jobDir), "utf8");
    const parsed = JSON.parse(raw) as RenderStore;
    if (parsed?.version !== 1 || !parsed.pages || typeof parsed.pages !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeRenderStore(jobDir: string, store: RenderStore): void {
  const target = renderStorePath(jobDir);
  const temporary = target + ".tmp";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(store));
  fs.renameSync(temporary, target);
}
