// Mode pembersihan teks asli sebelum teks terjemahan ditempel.
//
// - "white" (default): area teks diisi putih. Dipakai untuk tahap "timpa
//   seluruh bubble" dan mode cek "Bersihkan saja".
// - "bubble": area diisi warna kertas yang diambil dari gambar itu sendiri
//   (dominan di dalam area). Bubble abu-abu/berwarna tidak jadi putih.
// - "text": hanya baris/paragraf hasil OCR yang ditimpa (bukan seluruh
//   bubble), jadi outline bubble dan ilustrasi tidak ikut tertutup. Warna
//   isi diambil dari kertas di sekitar baris. Butuh hasil OCR; pada mode
//   "Bersihkan saja" (tanpa OCR) otomatis kembali ke mask bubble.
// - "none": teks asli dibiarkan, hanya terjemahan yang ditempel.
export const CLEAN_MODES = ["text", "bubble", "white", "none"] as const;

export type CleanMode = (typeof CLEAN_MODES)[number];

export const DEFAULT_CLEAN_MODE: CleanMode = "white";

export function normalizeCleanMode(value: unknown): CleanMode {
  return typeof value === "string" && (CLEAN_MODES as readonly string[]).includes(value)
    ? (value as CleanMode)
    : DEFAULT_CLEAN_MODE;
}

// Mode proses: terjemahkan seperti biasa, atau hanya bersihkan (timpa bubble)
// tanpa OCR/translate. "clean" dipakai untuk mengecek coverage bubble dulu.
export const PROCESS_MODES = ["translate", "clean"] as const;

export type ProcessMode = (typeof PROCESS_MODES)[number];

export const DEFAULT_PROCESS_MODE: ProcessMode = "translate";

export function normalizeProcessMode(value: unknown): ProcessMode {
  return typeof value === "string" && (PROCESS_MODES as readonly string[]).includes(value)
    ? (value as ProcessMode)
    : DEFAULT_PROCESS_MODE;
}
