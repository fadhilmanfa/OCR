// ID engine OCR yang dikirim dari UI (ControlPanel) / query param (?ocrEngine=).
// "tesseract" = default, kode lama, tidak diubah sama sekali.
// "vision_llm" = Vision LLM via OpenRouter (lihat lib/ocrVisionLLM.ts).
// "google_vision" = Google Cloud Vision API (lihat lib/ocrGoogleVision.ts).
export type OcrEngine = "tesseract" | "vision_llm" | "google_vision";

// Normalisasi input user/env jadi salah satu ID valid. Nilai asing
// (termasuk undefined/kosong, atau engine lama yang sudah dihapus) ->
// default "tesseract" (tidak breaking).
export function resolveOcrEngine(requested?: string): OcrEngine {
  const cand = (requested || process.env.OCR_ENGINE || "")
    .toLowerCase()
    .trim();
  if (cand === "vision_llm") return "vision_llm";
  if (cand === "google_vision") return "google_vision";
  return "tesseract";
}
