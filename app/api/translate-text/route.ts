import { NextResponse } from "next/server";
import { openRouterConfig, translateBatch } from "@/lib/translate";
import { normalizeAppLang } from "@/lib/languages";

export const runtime = "nodejs";

// Translate teks saja (tanpa OCR) — berguna untuk tes / edit manual.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { texts, provider, apiKey: apiKeyField, sourceLang: sourceRaw, targetLang: targetRaw } = (body || {}) as {
      texts?: unknown;
      provider?: unknown;
      apiKey?: unknown;
      sourceLang?: unknown;
      targetLang?: unknown;
    };
    if (!Array.isArray(texts) || !texts.length) {
      return NextResponse.json(
        { error: "texts harus array string tidak kosong" },
        { status: 400 },
      );
    }
    const { apiKey } = openRouterConfig(typeof apiKeyField === "string" ? apiKeyField : undefined);
    if (provider === "openrouter" && !apiKey) {
      return NextResponse.json(
        { error: "Masukkan API key OpenRouter di UI atau atur OPENROUTER_API_KEY di .env." },
        { status: 400 },
      );
    }
    const sourceLang = normalizeAppLang(sourceRaw ?? "en", "en");
    const targetLang = normalizeAppLang(targetRaw ?? "id", "id");
    if (sourceLang === targetLang) {
      return NextResponse.json(
        { error: "Bahasa sumber dan target sama — pilih pasangan berbeda." },
        { status: 400 },
      );
    }
    const out = await translateBatch(
      texts.map(String),
      typeof provider === "string" ? provider : "auto",
      undefined,
      apiKey,
      sourceLang,
      targetLang,
    );
    return NextResponse.json({ translations: out, sourceLang, targetLang });
  } catch (e) {
    return NextResponse.json(
      { error: String((e as Error).message || e) },
      { status: 500 },
    );
  }
}
