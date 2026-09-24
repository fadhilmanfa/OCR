// Provider translate pluggable:
// - auto      : google gratis -> mymemory (fallback). Kaku/literal, tapi gratis.
// - openrouter: LLM via OpenRouter (OpenAI-compatible). Jauh lebih natural
//               untuk dialog komik. Butuh OPENROUTER_API_KEY.
//               Endpoint: POST https://openrouter.ai/api/v1/chat/completions
// - opencode  : server OpenCode lokal (opsional, legacy).

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
}

export function openRouterConfig(): OpenRouterConfig {
  return {
    apiKey: process.env.OPENROUTER_API_KEY || "",
    // Default: murah + bagus untuk EN->ID. Bisa diganti di .env, misal:
    //  - "google/gemini-2.5-flash" (murah/cepat)
    //  - "deepseek/deepseek-chat" (murah, natural)
    //  - "openai/gpt-4o-mini" (stabil)
    //  - "anthropic/claude-3.5-haiku" (natural, agak mahal)
    model: process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash",
  };
}

export interface OpencodeConfig {
  url: string;
  model: string;
  username: string;
  password: string;
}

export function opencodeConfig(): OpencodeConfig {
  return {
    url: (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(
      /\/$/,
      "",
    ),
    model: process.env.OPENCODE_MODEL || "", // kosong = pakai default model opencode
    username: process.env.OPENCODE_SERVER_USERNAME || "opencode",
    password: process.env.OPENCODE_SERVER_PASSWORD || "",
  };
}

function opencodeHeaders(): Record<string, string> {
  const { username, password } = opencodeConfig();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  // Kalau `opencode serve` diproteksi password (OPENCODE_SERVER_PASSWORD),
  // kirim sebagai HTTP Basic Auth. Tanpa password, header ini di-skip.
  if (password) {
    h.Authorization =
      "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  }
  return h;
}

async function googleTranslate(text: string): Promise<string> {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=id&dt=t&q=" +
    encodeURIComponent(text);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("google " + res.status);
  const data = await res.json();
  // data[0] = array segmen, tiap segmen [translated, original]
  const out = ((data?.[0] || []) as Array<Array<string | null>>)
    .map((s) => s?.[0] || "")
    .join("");
  if (!out.trim()) throw new Error("google empty");
  return out;
}

async function myMemoryTranslate(text: string): Promise<string> {
  const url =
    "https://api.mymemory.translated.net/get?q=" +
    encodeURIComponent(text) +
    "&langpair=en|id";
  const res = await fetch(url);
  if (!res.ok) throw new Error("mymemory " + res.status);
  const data = await res.json();
  const out: string = data?.responseData?.translatedText || "";
  if (!out.trim() || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) {
    throw new Error("mymemory limit/empty");
  }
  return out;
}

const OPENROUTER_SYSTEM_PROMPT =
  "Kamu adalah penerjemah komik profesional Inggris → Indonesia. " +
  "Pakai Bahasa Indonesia sehari-hari yang natural, luwes, dan ekspresif seperti komik terbitan Indonesia — JANGAN kaku/literal seperti Google Translate. " +
  "Sesuaikan gaya bicara (kasar, sopan, panik, bercanda) dengan konteks kalimatnya. " +
  "Pertahankan nama orang/tempat, jangan terjemahkan SFX (mis. BOOM, WHAM). " +
  "Jangan tambah penjelasan, hanya keluarkan terjemahan.";

function openRouterHeaders(): Record<string, string> {
  const { apiKey } = openRouterConfig();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    // Direkomendasikan OpenRouter (boleh kosong, tapi bagus untuk ranking).
    "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "http://localhost:3000",
    "X-Title": process.env.OPENROUTER_APP_NAME || "komik-ocr-next",
  };
}

async function openRouterChat(
  userContent: string,
  temperature = 0.3,
): Promise<string> {
  const { apiKey, model } = openRouterConfig();
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY belum diisi. Isi di file .env lalu restart 'npm run dev'.",
    );
  }
  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: openRouterHeaders(),
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: "system", content: OPENROUTER_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });
  } catch (e) {
    throw new Error(
      `openrouter tidak terjangkau (cek internet). (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new Error(
        "openrouter 401: API key salah/kadaluarsa. Cek OPENROUTER_API_KEY di .env.",
      );
    }
    if (res.status === 402) {
      throw new Error(
        "openrouter 402: kredit habis. Top-up di openrouter.ai/settings/credits.",
      );
    }
    if (res.status === 429) {
      throw new Error("openrouter 429: rate-limit. Coba lagi sebentar.");
    }
    throw new Error(`openrouter ${res.status} ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const out: string = data?.choices?.[0]?.message?.content || "";
  if (!out.trim()) throw new Error("openrouter empty response");
  return out.trim();
}

async function openRouterTranslate(text: string): Promise<string> {
  const out = await openRouterChat(
    `Terjemahkan teks komik bahasa Inggris berikut ke Bahasa Indonesia.\n` +
      `Hanya keluarkan hasil terjemahan, tanpa tanda kutip tambahan, tanpa penjelasan.\n\nTeks:\n${text}`,
  );
  // Model kadang membungkus dengan kutip — kupas satu lapis.
  return out.replace(/^["“”']+|["“”']+$/g, "").trim() || out;
}

// Batch SEKALIGUS dalam 1 request (hemat biaya & cepat).
// Format: kirim list bernomor, minta kembali JSON array murni.
async function openRouterTranslateMany(texts: string[]): Promise<string[]> {
  if (!texts.length) return [];
  const numbered = texts
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n");
  const userContent =
    `Terjemahkan setiap baris teks komik Inggris berikut ke Bahasa Indonesia yang natural.\n` +
    `Jumlah baris: ${texts.length}. Wajib kembalikan TEPAT ${texts.length} terjemahan, urutan sama.\n` +
    `Balas HANYA dengan JSON array murni, tanpa markdown, tanpa penjelasan. Contoh: ["halo", "apa kabar"]\n\n` +
    numbered;
  const raw = await openRouterChat(userContent, 0.3);

  // 1) Coba parse JSON langsung (buang fence ```json bila ada).
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length === texts.length) {
      return parsed.map((s) => String(s ?? "").trim());
    }
  } catch {
    // lanjut ke fallback parsing
  }
  // 2) Fallback: parse baris bernomor "1. ..." (model kadang bandel).
  const lines = cleaned.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const byNumber: string[] = [];
  for (const l of lines) {
    const m = l.match(/^(\d+)[.)]\s*(.*)$/);
    if (m) byNumber[parseInt(m[1], 10) - 1] = (m[2] || "").trim();
  }
  if (
    byNumber.length === texts.length &&
    byNumber.every((s) => s !== undefined && s !== "")
  ) {
    return byNumber;
  }
  throw new Error(
    `openrouter: jumlah hasil (${byNumber.length || "?"}) != input (${texts.length}). Coba lagi atau kecilkan batch.`,
  );
}

async function opencodeTranslate(text: string): Promise<string> {
  const { url, model } = opencodeConfig();
  const prompt =
    "Terjemahkan teks komik bahasa Inggris berikut ke Bahasa Indonesia yang natural dan kasual. " +
    "Hanya keluarkan hasil terjemahan, tanpa penjelasan.\n\nTeks:\n" +
    text;
  const body: { prompt: string; model?: string } = { prompt };
  if (model) body.model = model;
  let res: Response;
  try {
    res = await fetch(`${url}/api/experimental/generate`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(
      `opencode tidak terjangkau di ${url}. Pastikan 'opencode serve' sedang jalan. (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("opencode " + res.status + " " + t.slice(0, 200));
  }
  const data = await res.json();
  // Bentuk respons bisa beda versi: coba beberapa field umum.
  const out =
    data?.text ||
    data?.data?.text ||
    data?.content ||
    (typeof data === "string" ? data : "");
  if (!String(out).trim()) throw new Error("opencode empty response");
  return String(out).trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function translateOne(
  text: string,
  provider = "auto",
): Promise<string> {
  if (!text.trim()) return text;
  if (provider === "openrouter") return openRouterTranslate(text);
  if (provider === "opencode") return opencodeTranslate(text);
  // auto: google dulu, fallback mymemory
  try {
    return await googleTranslate(text);
  } catch {
    await sleep(300);
    return await myMemoryTranslate(text);
  }
}

// Batch berurutan + jeda kecil biar tidak kena rate-limit Google.
// Untuk openrouter: kirim per-chunk sekaligus (1 request per ~30 teks).
export async function translateBatch(
  texts: string[],
  provider = "auto",
): Promise<string[]> {
  if (provider === "openrouter") {
    const CHUNK = 30;
    const out: string[] = [];
    for (let i = 0; i < texts.length; i += CHUNK) {
      const chunk = texts.slice(i, i + CHUNK);
      try {
        out.push(...(await openRouterTranslateMany(chunk)));
      } catch {
        // Chunk gagal -> fallback per-teks supaya 1 baris gagal
        // tidak menggugurkan semuanya.
        for (const t of chunk) {
          try {
            out.push(await openRouterTranslate(t));
          } catch {
            out.push(t); // kembalikan asli
          }
          await sleep(200);
        }
      }
    }
    return out;
  }
  const out: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    try {
      out.push(await translateOne(texts[i], provider));
    } catch {
      // Gagal total -> kembalikan teks asli supaya gambar tetap diproses.
      out.push(texts[i]);
    }
    if (i < texts.length - 1) await sleep(250);
  }
  return out;
}
