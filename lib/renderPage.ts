// Render ulang satu halaman dari gambar ASLI + mask + goresan + kotak teks.
// Dipakai editor koreksi (simpan) dan endpoint textbase (tanpa teks) agar
// logika render hanya ada di satu tempat.
import fs from "fs";
import path from "path";
import { applyAutoMaskEdits, overlayTranslations } from "./overlay";
import { DEFAULT_FONT } from "./fonts";
import { sourceFilePath, type RenderStore, type StoredPage } from "./renderStore";

export interface RenderPageOptions {
  /** false = gambar dasar workspace teks (tanpa teks terjemahan). */
  withText?: boolean;
  /** false = jangan menulis PNG halaman (mis. untuk preview). */
  write?: boolean;
}

export async function renderStoredPage(
  jobDir: string,
  page: StoredPage,
  store: RenderStore,
  options: RenderPageOptions = {},
): Promise<Buffer> {
  const sourceAbs = sourceFilePath(jobDir, page.sourceFile);
  if (!fs.existsSync(sourceAbs)) {
    throw new Error("Sumber halaman sudah tidak tersedia");
  }
  const withText = options.withText !== false;
  const source = fs.readFileSync(sourceAbs);
  const cleanMode = page.cleanMode === "none" ? "text" : page.cleanMode;
  // Tanpa teks: item tetap dikirim (teks dikosongkan) supaya area mask per
  // kotak teks pada halaman full-page OCR ikut dibersihkan seperti render asli.
  const items = withText ? page.items : page.items.map((item) => ({ ...item, text: "" }));
  const out = await overlayTranslations(source, items, {
    cleanMode,
    cleanAreas: applyAutoMaskEdits(page.cleanAreas, page.autoMaskEdits),
    manualStrokes: page.manualStrokes ?? [],
    font: page.font ?? store.font ?? DEFAULT_FONT,
    textOverrides: withText ? page.textOverrides : undefined,
  });
  if (options.write !== false) {
    fs.writeFileSync(path.join(jobDir, page.file), out);
  }
  return out;
}
