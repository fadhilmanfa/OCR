import { NextResponse } from "next/server";
import { opencodeConfig, openRouterConfig } from "@/lib/translate";

export const runtime = "nodejs";

export async function GET() {
  const oc = opencodeConfig();
  const or = openRouterConfig();
  return NextResponse.json({
    ok: true,
    openrouter: {
      model: or.model,
      apiKey: or.apiKey ? "terpasang" : "BELUM diisi (isi OPENROUTER_API_KEY di .env)",
    },
    opencode: {
      url: oc.url,
      model: oc.model || "(default model opencode)",
      auth: oc.password ? "password terpasang" : "tanpa password",
    },
    note: "provider=auto memakai Google gratis + fallback MyMemory (kaku). provider=openrouter memakai LLM OpenRouter (natural, butuh API key).",
  });
}
