// Bahasa sumber & target yang didukung: Inggris, Jepang, Indonesia, Mandarin.
// Satu sumber kebenaran untuk mapping per-provider agar tidak hardcode
// `en -> id` di banyak tempat.

export type AppLang = "en" | "ja" | "id" | "zh";

export const APP_LANGS: readonly AppLang[] = ["en", "ja", "id", "zh"] as const;

export const LANG_LABEL: Record<AppLang, string> = {
  en: "Inggris",
  ja: "Jepang",
  id: "Indonesia",
  zh: "Mandarin (Sederhana)",
};

export const LANG_SHORT: Record<AppLang, string> = {
  en: "EN",
  ja: "JA",
  id: "ID",
  zh: "ZH",
};

// Nama bahasa dalam Bahasa Inggris untuk prompt LLM (model paling patuh
// pada instruksi Inggris).
export const LANG_EN_NAME: Record<AppLang, string> = {
  en: "English",
  ja: "Japanese",
  id: "Indonesian",
  zh: "Chinese (Simplified)",
};

// Kode Tesseract traineddata. `jpn` mencakup kana + kanji + latin.
// `jpn_vert` hanya untuk teks vertikal murni — tidak dipakai default
// karena merusak teks horizontal. `chi_sim` = Mandarin Sederhana.
export const TESSERACT_MAP: Record<AppLang, string> = {
  en: "eng",
  ja: "jpn",
  id: "ind",
  zh: "chi_sim",
};

// Kode Google Translate / MyMemory. Google memakai `zh-CN` untuk
// Mandarin Sederhana, bukan `zh` saja.
export const GOOGLE_MAP: Record<AppLang, string> = {
  en: "en",
  ja: "ja",
  id: "id",
  zh: "zh-CN",
};

export function normalizeAppLang(v: unknown, fallback: AppLang): AppLang {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "en" || s === "english" || s === "eng") return "en";
  if (s === "ja" || s === "jp" || s === "jpn" || s === "japanese") return "ja";
  if (s === "id" || s === "ind" || s === "indonesia" || s === "indonesian") return "id";
  // `zh-CN` = Mandarin Sederhana. Varian tradisional (zh-TW/HK) sengaja
  // tidak dipetakan ke sini karena traineddata & kode terjemahannya beda.
  if (
    s === "zh" ||
    s === "zh-cn" ||
    s === "zh_cn" ||
    s === "zh-hans" ||
    s === "cn" ||
    s === "chi" ||
    s === "chi_sim" ||
    s === "chinese" ||
    s === "mandarin" ||
    s === "tionghoa" ||
    s === "cina"
  )
    return "zh";
  return fallback;
}

export function tesseractLangsFor(source: AppLang): string {
  return TESSERACT_MAP[source] ?? "eng";
}

export function googleLangCode(source: AppLang): string {
  return GOOGLE_MAP[source] ?? source;
}
