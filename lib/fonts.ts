// Pilihan font terjemahan. Dipakai UI (client) dan render overlay (server),
// jadi daftar ini adalah satu-satunya sumber kebenaran (whitelist).
export const FONT_FAMILIES = [
  "Comic Sans MS",
  "Arial",
  "Verdana",
  "Trebuchet MS",
  "Georgia",
  "Times New Roman",
  "Noto Sans CJK SC",
] as const;

export interface FontChoice {
  family: string;
  bold: boolean;
  scale: number;
}

export const DEFAULT_FONT: FontChoice = {
  family: FONT_FAMILIES[0],
  bold: true,
  scale: 100,
};

export function isFontFamily(value: unknown): value is string {
  return typeof value === "string" && (FONT_FAMILIES as readonly string[]).includes(value);
}

export function normalizeFont(value: unknown): FontChoice {
  if (!value || typeof value !== "object") return { ...DEFAULT_FONT };
  const raw = value as { family?: unknown; bold?: unknown; scale?: unknown };
  const scaleRaw = typeof raw.scale === "number" ? raw.scale : Number(raw.scale);
  return {
    family: isFontFamily(raw.family) ? raw.family : DEFAULT_FONT.family,
    bold: raw.bold !== false,
    scale: Number.isFinite(scaleRaw)
      ? Math.max(70, Math.min(130, Math.round(scaleRaw)))
      : DEFAULT_FONT.scale,
  };
}

// Font pilihan + fallback CJK & font Linux/Windows/macOS agar teks tidak
// berubah jadi kotak (tofu) saat font pilihan tidak tersedia di server.
export function fontStack(family: string): string {
  const safe = isFontFamily(family) ? family : DEFAULT_FONT.family;
  return `'${safe}', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif`;
}
