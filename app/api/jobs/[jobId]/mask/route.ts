import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getJob } from "@/lib/jobs";
import { buildJobArchives } from "@/lib/jobFiles";
import { FONT_FAMILIES, normalizeFont } from "@/lib/fonts";
import type { AutoMaskEdit, BrushPoint, BrushStroke, TextBoxOverride } from "@/lib/overlay";
import { renderStoredPage } from "@/lib/renderPage";
import { readRenderStore, sourceFilePath, writeRenderStore } from "@/lib/renderStore";

export const runtime = "nodejs";
export const maxDuration = 300;

const OUT_DIR = path.join(process.cwd(), "outputs");
const MAX_STROKES = 300;
const MAX_POINTS_PER_STROKE = 4000;
const MAX_TOTAL_POINTS = 40000;
const MIN_SIZE = 1;
const MAX_SIZE = 500;
const MIN_EDIT_SIDE = 2;
const MIN_TEXT_SIDE = 12;

interface RawStroke {
  mode?: unknown;
  size?: unknown;
  points?: unknown;
}

interface RawEdit {
  index?: unknown;
  deleted?: unknown;
  bbox?: { x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown };
}

interface RawText {
  index?: unknown;
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
  deleted?: unknown;
  text?: unknown;
  scale?: unknown;
  fontFamily?: unknown;
  fontBold?: unknown;
  fontCap?: unknown;
}

function number(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// POST /api/jobs/<jobId>/mask
// Body: {
//   file, strokes, autoMaskEdits?,
//   font?: { family, bold, scale }, fontScope?: "page" | "all",
//   textOverrides?: [{ index, x, y, w, h }]
// }
// Render ulang dari sumber ASLI + mask + goresan + kotak/font teks.
// fontScope "all" merender ulang SEMUA halaman, "page" hanya halaman ini.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  if (!/^[a-z0-9]+$/i.test(jobId)) {
    return NextResponse.json({ error: "jobId tidak valid" }, { status: 400 });
  }
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Hasil tidak ditemukan / sudah kedaluwarsa" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (job.expiresAt && job.expiresAt <= Date.now()) {
    return NextResponse.json({ error: "Hasil sudah kedaluwarsa" }, { status: 410, headers: { "Cache-Control": "no-store" } });
  }

  let body: {
    file?: unknown;
    strokes?: unknown;
    autoMaskEdits?: unknown;
    font?: unknown;
    fontScope?: unknown;
    textOverrides?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body JSON tidak valid" }, { status: 400 });
  }
  const file = typeof body.file === "string" ? body.file : "";
  if (!file || !Array.isArray(body.strokes)) {
    return NextResponse.json({ error: "file dan strokes wajib diisi" }, { status: 400 });
  }

  const jobDir = path.join(OUT_DIR, jobId);
  const store = readRenderStore(jobDir);
  const page = store?.pages[file];
  if (!store || !page) {
    return NextResponse.json({ error: "Halaman tidak ditemukan" }, { status: 404 });
  }
  const sourceAbs = sourceFilePath(jobDir, page.sourceFile);
  if (!fs.existsSync(sourceAbs)) {
    return NextResponse.json({ error: "Sumber halaman sudah tidak tersedia" }, { status: 404 });
  }

  // Validasi + clamp. Goresan kosong / titik invalid dibuang (bukan error)
  // agar klik tak sengaja tidak menggagalkan seluruh simpan.
  const manualStrokes: BrushStroke[] = [];
  let totalPoints = 0;
  for (const raw of body.strokes as RawStroke[]) {
    if (manualStrokes.length >= MAX_STROKES || totalPoints >= MAX_TOTAL_POINTS) break;
    const size = number(raw?.size);
    if (size === null) continue;
    const pointsRaw = Array.isArray(raw?.points) ? raw.points : [];
    const points: BrushPoint[] = [];
    for (const point of pointsRaw) {
      if (!Array.isArray(point)) continue;
      const x = number(point[0]);
      const y = number(point[1]);
      if (x === null || y === null) continue;
      points.push([clamp(x, 0, page.width), clamp(y, 0, page.height)]);
      if (points.length >= MAX_POINTS_PER_STROKE) break;
    }
    if (!points.length) continue;
    manualStrokes.push({
      mode: raw?.mode === "erase" ? "erase" : "paint",
      size: clamp(size, MIN_SIZE, MAX_SIZE),
      points,
    });
    totalPoints += points.length;
  }

  // Edit mask otomatis (garis kuning). Indeks mengacu ke cleanAreas halaman;
  // bbox baru = kotak diganti, deleted = mask dimatikan.
  const autoMaskEdits: AutoMaskEdit[] = [];
  if (Array.isArray(body.autoMaskEdits)) {
    const seen = new Set<number>();
    for (const raw of body.autoMaskEdits as RawEdit[]) {
      const index = number(raw?.index);
      if (index === null || !Number.isInteger(index) || index < 0 || index >= page.cleanAreas.length) continue;
      if (seen.has(index)) continue;
      seen.add(index);
      if (raw?.deleted === true) {
        autoMaskEdits.push({ index, deleted: true });
        continue;
      }
      const x0 = number(raw?.bbox?.x0);
      const y0 = number(raw?.bbox?.y0);
      const x1 = number(raw?.bbox?.x1);
      const y1 = number(raw?.bbox?.y1);
      if (x0 === null || y0 === null || x1 === null || y1 === null) continue;
      const left = Math.max(0, Math.min(x0, x1));
      const top = Math.max(0, Math.min(y0, y1));
      const right = Math.min(page.width, Math.max(x0, x1));
      const bottom = Math.min(page.height, Math.max(y0, y1));
      if (right - left < MIN_EDIT_SIDE || bottom - top < MIN_EDIT_SIDE) continue;
      autoMaskEdits.push({ index, bbox: { x0: left, y0: top, x1: right, y1: bottom } });
    }
  } else {
    autoMaskEdits.push(...(page.autoMaskEdits ?? []));
  }

  // Kotak teks hasil geser/resize (override posisi/ukuran per item).
  if (Array.isArray(body.textOverrides)) {
    const seen = new Set<number>();
    const overrides: TextBoxOverride[] = [];
    for (const raw of body.textOverrides as RawText[]) {
      const index = number(raw?.index);
      if (index === null || !Number.isInteger(index) || index < 0 || index >= page.items.length) continue;
      if (seen.has(index)) continue;
      seen.add(index);
      const x = number(raw?.x);
      const y = number(raw?.y);
      const w = number(raw?.w);
      const h = number(raw?.h);
      if (x === null || y === null || w === null || h === null) continue;
      const left = clamp(x, 0, Math.max(0, page.width - 1));
      const top = clamp(y, 0, Math.max(0, page.height - 1));
      const width = Math.min(Math.max(0, w), page.width - left);
      const height = Math.min(Math.max(0, h), page.height - top);
      if (width < MIN_TEXT_SIDE || height < MIN_TEXT_SIDE) continue;
      const text = typeof raw?.text === "string" ? raw.text.slice(0, 2000) : undefined;
      const scaleRaw = number(raw?.scale);
      const scale =
        scaleRaw !== null && scaleRaw > 0
          ? clamp(Math.round(scaleRaw), 20, 300)
          : undefined;
      const fontFamily =
        typeof raw?.fontFamily === "string" && (FONT_FAMILIES as readonly string[]).includes(raw.fontFamily)
          ? raw.fontFamily
          : undefined;
      const fontBold = typeof raw?.fontBold === "boolean" ? raw.fontBold : undefined;
      const capRaw = number(raw?.fontCap);
      const fontCap =
        capRaw !== null && capRaw > 0 ? clamp(Math.round(capRaw), 1, 500) : undefined;
      overrides.push({
        index,
        x: left,
        y: top,
        w: width,
        h: height,
        ...(text !== undefined ? { text } : {}),
        ...(scale !== undefined && scale !== 100 ? { scale } : {}),
        ...(fontFamily ? { fontFamily } : {}),
        ...(fontBold !== undefined ? { fontBold } : {}),
        ...(fontCap !== undefined ? { fontCap } : {}),
        ...(raw?.deleted === true ? { deleted: true } : {}),
      });
    }
    page.textOverrides = overrides;
  }

  // Font: scope "all" = default job (hapus override halaman lain), "page" =
  // hanya halaman ini. Tanpa font = pakai pengaturan yang sudah ada.
  const fontProvided = body.font !== undefined && body.font !== null;
  const font = fontProvided ? normalizeFont(body.font) : undefined;
  const fontScope: "page" | "all" = body.fontScope === "page" ? "page" : "all";
  let fontNeedsAllPages = false;
  if (font) {
    if (fontScope === "all") {
      const previous = store.font;
      const sameFont =
        !!previous &&
        previous.family === font.family &&
        previous.bold === font.bold &&
        previous.scale === font.scale;
      const hadPageOverrides = Object.values(store.pages).some((stored) => stored.font);
      fontNeedsAllPages = !sameFont || hadPageOverrides;
      store.font = font;
      for (const stored of Object.values(store.pages)) delete stored.font;
    } else {
      page.font = font;
    }
  }

  page.autoMaskEdits = autoMaskEdits;
  page.manualStrokes = manualStrokes;
  page.cleanMode = page.cleanMode === "none" ? "text" : page.cleanMode;

  // fontScope "all" harus memperbarui semua halaman saat font benar-benar
  // berubah; kalau hanya kotak teks yang diubah, cukup halaman ini.
  const renderAll = Boolean(font) && fontScope === "all" && fontNeedsAllPages;
  const targets = renderAll ? Object.values(store.pages) : [page];
  let pagesUpdated = 0;
  for (const target of targets) {
    await renderStoredPage(jobDir, target, store);
    target.cleanMode = target.cleanMode === "none" ? "text" : target.cleanMode;
    pagesUpdated++;
  }

  writeRenderStore(jobDir, store);

  // ZIP/PDF ikut diperbarui agar unduhan berikutnya memakai hasil koreksi.
  // Kalau pembuatan arsip gagal, PNG tetap tersimpan; laporkan agar user
  // tidak mengira ZIP/PDF sudah baru.
  let archivesUpdated = true;
  try {
    const files = (job.result?.pages?.length ? job.result.pages.map((p) => p.file) : Object.values(store.pages).map((p) => p.file));
    await buildJobArchives(jobDir, files);
  } catch (e) {
    archivesUpdated = false;
    console.error(`[mask] gagal memperbarui ZIP/PDF job ${jobId}:`, e);
  }

  return NextResponse.json(
    {
      ok: true,
      file: page.file,
      url: `/api/outputs/${jobId}/${encodeURIComponent(page.file)}`,
      version: Date.now(),
      manualStrokes: manualStrokes.length,
      autoMaskEdits: autoMaskEdits.length,
      textOverrides: page.textOverrides?.length ?? 0,
      font: page.font ?? store.font,
      fontScope,
      pagesUpdated,
      archivesUpdated,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
