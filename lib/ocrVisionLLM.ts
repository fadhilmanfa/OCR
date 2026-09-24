// Engine OCR alternatif "vision_llm": membaca teks LANGSUNG dari gambar
// crop bubble memakai model Vision LLM lewat OpenRouter API
// (bukan OCR tradisional seperti Tesseract).
//
// Alurnya per bubble:
//   crop bubble (Buffer PNG dari cropBubble() di lib/bubble.ts)
//     -> encode base64
//     -> POST ke https://openrouter.ai/api/v1/chat/completions
//     -> ambil teks dari choices[0].message.content
//
// Pola request di bawah ini SENGAJA meniru lib/translate.ts:
//   - API key dari process.env.OPENROUTER_API_KEY (SAMA, tidak perlu key baru)
//   - header Authorization Bearer + HTTP-Referer + X-Title
//   - penanganan error 401/402/429 yang sama
// Bedanya: pesan dikirim sebagai array "content" (teks + gambar),
// bukan string teks biasa, karena model vision butuh input gambar.
//
// Kompatibilitas dengan engine lama:
//   - ocrVisionBubbleCrops() punya SIGNATURE & OUTPUT SAMA PERSIS dengan
//     ocrBubbleCrops() di lib/ocr.ts:
//       input  : Buffer[]  (daftar crop bubble)
//       output : Array<{ text: string; conf: number } | null>
//     Jadi di app/api/process/route.ts tinggal tukar panggilannya,
//     langkah translateBatch() + overlayTranslations() TIDAK berubah.
//   - Nilai `conf` adalah angka dummy (Vision LLM tidak mengeluarkan
//     skor confidence seperti Tesseract). Route tidak memfilter
//     berdasarkan conf, jadi aman.

import { readFile } from "fs/promises";

// Alamat API yang SAMA dengan translate (lihat lib/translate.ts).
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Model default: murah tapi akurat untuk baca teks di gambar.
// Bisa diganti lewat env OPENROUTER_VISION_MODEL (lihat .env.example).
const DEFAULT_VISION_MODEL = "google/gemini-2.0-flash-001";

// Batas request yang jalan BARENG. OpenRouter punya rate-limit,
// jadi jangan tembak semua bubble sekaligus (1 halaman bisa 20-40 bubble).
const MAX_CONCURRENCY = 5;

// Batas waktu tunggu per 1 request bubble (ms). Bisa dioverride via env.
function visionTimeoutMs(): number {
  const v = Number(process.env.OPENROUTER_VISION_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 60000;
}

// Nama model vision yang dipakai. Env kosong -> pakai default di atas.
export function visionModel(): string {
  return process.env.OPENROUTER_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
}

// Header otentikasi — SAMA PERSIS dengan openRouterHeaders()
// di lib/translate.ts (key yang sama, tidak perlu env baru).
function openRouterHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY || ""}`,
    // Direkomendasikan OpenRouter (boleh kosong, tapi bagus untuk ranking).
    "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "http://localhost:3000",
    "X-Title": process.env.OPENROUTER_APP_NAME || "komik-ocr-next",
  };
}

// Perintah ke model: "kembalikan HANYA teks yang terlihat".
// Ditulis dalam Bahasa Inggris karena model vision umumnya paling
// patuh pada instruksi OCR berbahasa Inggris.
const VISION_PROMPT =
  "Transcribe exactly the text visible in this image. " +
  "Return ONLY the transcribed text, nothing else: " +
  "no explanations, no markdown, no quotation marks. " +
  "If there is no readable text, return an empty response.";

// Bersihkan output model: buang fence ``` , spasi, dan satu lapis
// tanda kutip pembungkus (model kadang bandel membungkus jawaban).
function cleanVisionText(raw: string): string {
  const t = String(raw || "")
    .trim()
    .replace(/^```(?:json|markdown|text)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  return t.replace(/^["“”']+|["“”']+$/g, "").trim();
}

// ---------------------------------------------------------------------------
// ocrVisionLLM: baca 1 gambar crop bubble -> teks Inggris apa adanya.
//
//   image : Buffer PNG hasil cropBubble() ATAU path file gambar (string).
//   return: teks yang terbaca. GAGAL APAPUN (key kosong, timeout,
//           rate-limit, response kosong) -> return "" (TIDAK PERNAH throw),
//           supaya 1 bubble gagal tidak menggagalkan seluruh halaman.
// ---------------------------------------------------------------------------
export async function ocrVisionLLM(image: Buffer | string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY || "";
  if (!apiKey) {
    // Sama seperti translate: tanpa key, OpenRouter pasti 401.
    // Log sekali per bubble gagal, lalu kembalikan "".
    console.error(
      "[vision-llm] OPENROUTER_API_KEY belum diisi. Isi di file .env lalu restart 'npm run dev'.",
    );
    return "";
  }

  // Terima Buffer atau path file -> samakan jadi Buffer dulu.
  let buffer: Buffer;
  if (typeof image === "string") {
    try {
      buffer = await readFile(image);
    } catch (e) {
      console.error(
        `[vision-llm] file tidak bisa dibaca (${image}): ${e instanceof Error ? e.message : String(e)}`,
      );
      return "";
    }
  } else {
    buffer = image;
  }
  if (!buffer.length) return "";

  // Gambar dikirim sebagai "data URL" base64 di dalam pesan.
  // Format ini standar OpenAI-compatible (OpenRouter mengikutinya):
  //   { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;

  // AbortController = "alarm": kalau model kelamaan (> timeout),
  // request dibatalkan paksa supaya halaman tidak macet menunggu.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), visionTimeoutMs());
  try {
    let res: Response;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: openRouterHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          model: visionModel(),
          temperature: 0, // 0 = deterministik, cocok untuk OCR (jangan kreatif)
          max_tokens: 500, // teks bubble pendek; batasi biar murah & cepat
          messages: [
            {
              role: "user",
              // "content" berupa ARRAY: [instruksi teks, gambar].
              // Inilah bedanya dengan request translate yang isinya string.
              content: [
                { type: "text", text: VISION_PROMPT },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      });
    } catch (e) {
      // Kegagalan jaringan/timeout. AbortError = alarm di atas berbunyi.
      if (e instanceof Error && e.name === "AbortError") {
        console.error(
          `[vision-llm] timeout setelah ${visionTimeoutMs()}ms (model ${visionModel()}).`,
        );
      } else {
        console.error(
          `[vision-llm] tidak terjangkau (cek internet): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return "";
    }

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      if (res.status === 401) {
        console.error(
          "[vision-llm] 401: API key salah/kadaluarsa. Cek OPENROUTER_API_KEY di .env.",
        );
      } else if (res.status === 402) {
        console.error(
          "[vision-llm] 402: kredit habis. Top-up di openrouter.ai/settings/credits.",
        );
      } else if (res.status === 429) {
        console.error(
          "[vision-llm] 429: rate-limit (terlalu banyak request). Bubble ini dilewati.",
        );
      } else {
        console.error(`[vision-llm] ${res.status} ${t.slice(0, 300)}`);
      }
      return "";
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    // Normalnya string; tapi beberapa model mengembalikan array
    // potongan [{type:"text", text:"..."}] — gabungkan jadi satu.
    const raw =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((p) => p?.text || "").join("")
          : "";
    const text = cleanVisionText(raw);
    if (!text) {
      console.error("[vision-llm] response kosong untuk 1 bubble (dilewati).");
      return "";
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// ocrVisionBubbleCrops: versi BATCH, pengganti ocrBubbleCrops() dari Tesseract.
//
//   input  : Buffer[]  (sama)
//   output : Array<{ text, conf } | null>  (sama; null = bubble tak terbaca)
//   Bedanya: tiap bubble = 1 API call, dijalankan dengan worker-pool
//   sederhana (maks MAX_CONCURRENCY request bareng) supaya tidak kena
//   rate-limit OpenRouter. Urutan hasil SAMA dengan urutan input.
// ---------------------------------------------------------------------------
export async function ocrVisionBubbleCrops(
  crops: Buffer[],
  onProgress?: (done: number, total: number) => void,
): Promise<Array<{ text: string; conf: number } | null>> {
  const out: Array<{ text: string; conf: number } | null> = new Array(
    crops.length,
  ).fill(null);
  if (!crops.length) return out;

  // Worker-pool tanpa library: N "pekerja" (N = min(5, jumlah bubble))
  // berebut mengambil index berikutnya sampai habis. Hasil ditulis ke
  // posisi index-nya sendiri, jadi urutan tetap terjaga walau yang
  // selesai duluan acak.
  let next = 0;
  let finished = 0;
  const workerCount = Math.min(MAX_CONCURRENCY, crops.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= crops.length) return;
      const text = await ocrVisionLLM(crops[i]);
      // conf = 99 dummy: Vision LLM tidak punya skor confidence.
      // Route tidak memfilter berdasarkan conf (hanya memakai text),
      // jadi angka ini tidak mempengaruhi hasil.
      out[i] = text ? { text, conf: 99 } : null;
      finished++;
      onProgress?.(finished, crops.length);
    }
  });
  await Promise.all(workers);
  return out;
}
