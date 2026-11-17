// Pindai ulang satu halaman dari dalam editor mask/teks.
//
// Alur: hitung kandidat (tidak menyentuh hasil) -> render preview -> user
// membandingkan & memilih per item -> apply. Logika OCR per halaman di sini
// sengaja dipisah dari processJob.ts agar pipeline awal tidak berubah.
//
// Region (lasso) membatasi perubahan ke area yang dilingkari. Kandidat tetap
// menyimpan state halaman PENUH: item/mask di luar area disalin dari state
// lama, jadi "Terapkan semua" tidak menghapus bagian lain halaman.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { cropBubble, detectBubbles } from "./bubble";
import { extractBubbleShapes, type BubbleShapeResult } from "./bubbleShape";
import {
  detectBubbleLines,
  ocrBubbleCrops,
  ocrEnglish,
  type BBox,
  type OcrBox,
} from "./ocr";
import { ocrVisionBubbleCrops, ocrVisionLLM } from "./ocrVisionLLM";
import {
  findRegionForBox,
  mergeVisionBlocks,
  ocrGoogleBubbleCrops,
  ocrGoogleFullPage,
  ocrGooglePageDetail,
} from "./ocrGoogleVision";
import { translateBatch } from "./translate";
import type {
  AutoMaskEdit,
  CleanArea,
  OverlayItem,
  TextBoxOverride,
} from "./overlay";
import { normalizeAppLang, type AppLang } from "./languages";
import { resolveOcrEngine, type OcrEngine } from "./ocrEngine";
import { renderStoredPage } from "./renderPage";
import {
  readRenderStore,
  sourceFilePath,
  writeRenderStore,
  type StoredPage,
} from "./renderStore";
import { buildJobArchives } from "./jobFiles";
import { getJob, updateJobResultPage } from "./jobs";
import type { ProcessPage } from "@/components/types";

export type RescanAction = "mask" | "translate" | "ocr_translate";

export interface RescanSettings {
  bubble: string;
  ocrEngine: OcrEngine;
  provider: string;
  sourceLang: AppLang;
  targetLang: AppLang;
}

export interface RescanRegionPoint {
  x: number;
  y: number;
}

export interface RescanRegion {
  points: RescanRegionPoint[];
  bbox: BBox;
}

export interface RescanTextDiff {
  id: string;
  kind: "added" | "removed" | "changed";
  oldIndex: number | null;
  newIndex: number | null;
  source: string;
  oldText: string;
  newText: string;
}

export interface RescanMaskDiff {
  id: string;
  kind: "added" | "removed" | "changed";
  oldIndex: number | null;
  newIndex: number | null;
  bbox: BBox;
}

export interface RescanCandidate {
  token: string;
  action: RescanAction;
  file: string;
  createdAt: number;
  settings: RescanSettings;
  /** Area lasso (koordinat halaman), undefined = seluruh halaman. */
  region?: RescanRegion;
  oldItems: OverlayItem[];
  oldCleanAreas: CleanArea[];
  oldOverrides: TextBoxOverride[];
  oldAutoMaskEdits: AutoMaskEdit[];
  items: OverlayItem[];
  cleanAreas: CleanArea[];
  overrides: TextBoxOverride[];
  autoMaskEdits: AutoMaskEdit[];
  diff: {
    texts: RescanTextDiff[];
    masks: RescanMaskDiff[];
  };
  via: string;
  bubbleCount: number;
  undetected: number;
}

const CANDIDATE_DIR = ".rescan";
const TOKEN_RE = /^[a-f0-9]{32}$/;
const BUBBLE_VALUES = new Set(["ogkalu", "psimera", "google", "0"]);
const PROVIDER_VALUES = new Set(["auto", "openrouter", "opencode"]);
const MAX_REGION_POINTS = 240;
const MIN_REGION_SIDE = 8;

function jobDirFor(jobId: string): string {
  return path.join(process.cwd(), "outputs", jobId);
}

function candidatePath(jobDir: string, token: string): string {
  return path.join(jobDir, CANDIDATE_DIR, `${token}.json`);
}

function previewPath(jobDir: string, token: string): string {
  return path.join(jobDir, CANDIDATE_DIR, `${token}.png`);
}

export function normalizeRescanSettings(raw: unknown): RescanSettings {
  const value = (raw ?? {}) as Record<string, unknown>;
  const bubble = typeof value.bubble === "string" && BUBBLE_VALUES.has(value.bubble)
    ? value.bubble
    : "ogkalu";
  const provider = typeof value.provider === "string" && PROVIDER_VALUES.has(value.provider)
    ? value.provider
    : "auto";
  return {
    bubble,
    ocrEngine: resolveOcrEngine(typeof value.ocrEngine === "string" ? value.ocrEngine : undefined),
    provider,
    sourceLang: normalizeAppLang(value.sourceLang, "en"),
    targetLang: normalizeAppLang(value.targetLang, "id"),
  };
}

// Titik lasso dari client -> polygon yang aman. Poin terlalu dekat / di luar
// halaman dibuang; area terlalu kecil dianggap tidak ada.
export function normalizeRescanRegion(
  raw: unknown,
  width: number,
  height: number,
): RescanRegion | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const pointsRaw = (raw as { points?: unknown }).points;
  if (!Array.isArray(pointsRaw)) return undefined;
  const points: RescanRegionPoint[] = [];
  for (const entry of pointsRaw) {
    if (points.length >= MAX_REGION_POINTS) break;
    if (!entry || typeof entry !== "object") continue;
    const x = Number((entry as { x?: unknown }).x);
    const y = Number((entry as { y?: unknown }).y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const next = {
      x: Math.max(0, Math.min(width, x)),
      y: Math.max(0, Math.min(height, y)),
    };
    const prev = points[points.length - 1];
    if (prev && Math.hypot(prev.x - next.x, prev.y - next.y) < 1.5) continue;
    points.push(next);
  }
  if (points.length < 3) return undefined;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const bbox = {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
  if (bbox.x1 - bbox.x0 < MIN_REGION_SIDE || bbox.y1 - bbox.y0 < MIN_REGION_SIDE) {
    return undefined;
  }
  return { points, bbox };
}

function iou(a: BBox, b: BBox): number {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  const iw = Math.max(0, x1 - x0);
  const ih = Math.max(0, y1 - y0);
  const inter = iw * ih;
  if (!inter) return 0;
  const areaA = Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0));
  const areaB = Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
  return inter / (areaA + areaB - inter);
}

// Pasangkan item lama↔baru berdasarkan overlap kotak, bukan urutan index:
// OCR ulang bisa mengubah urutan teks.
function pairByIoU(oldBoxes: BBox[], newBoxes: BBox[], threshold = 0.15): Map<number, number> {
  const candidates: Array<{ oldIndex: number; newIndex: number; score: number }> = [];
  oldBoxes.forEach((a, oi) => {
    newBoxes.forEach((b, ni) => {
      const score = iou(a, b);
      if (score >= threshold) candidates.push({ oldIndex: oi, newIndex: ni, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score);
  const pairs = new Map<number, number>();
  const usedOld = new Set<number>();
  for (const c of candidates) {
    if (pairs.has(c.newIndex) || usedOld.has(c.oldIndex)) continue;
    pairs.set(c.newIndex, c.oldIndex);
    usedOld.add(c.oldIndex);
  }
  return pairs;
}

function rectsIntersect(a: BBox, b: BBox): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function bboxTouchesAny(bbox: BBox, boxes: BBox[]): boolean {
  return boxes.some((box) => rectsIntersect(bbox, box));
}

function pointInPolygon(x: number, y: number, points: RescanRegionPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function orient(a: RescanRegionPoint, b: RescanRegionPoint, c: RescanRegionPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: RescanRegionPoint, b: RescanRegionPoint, c: RescanRegionPoint): boolean {
  return (
    Math.min(a.x, b.x) - 1e-6 <= c.x &&
    c.x <= Math.max(a.x, b.x) + 1e-6 &&
    Math.min(a.y, b.y) - 1e-6 <= c.y &&
    c.y <= Math.max(a.y, b.y) + 1e-6
  );
}

function segmentsIntersect(
  p1: RescanRegionPoint,
  q1: RescanRegionPoint,
  p2: RescanRegionPoint,
  q2: RescanRegionPoint,
): boolean {
  const o1 = orient(p1, q1, p2);
  const o2 = orient(p1, q1, q2);
  const o3 = orient(p2, q2, p1);
  const o4 = orient(p2, q2, q1);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }
  if (Math.abs(o1) < 1e-6 && onSegment(p1, q1, p2)) return true;
  if (Math.abs(o2) < 1e-6 && onSegment(p1, q1, q2)) return true;
  if (Math.abs(o3) < 1e-6 && onSegment(p2, q2, p1)) return true;
  if (Math.abs(o4) < 1e-6 && onSegment(p2, q2, q1)) return true;
  return false;
}

// Apakah kotak (bbox teks/mask/bubble) menyentuh polygon lasso?
function rectIntersectsPolygon(rect: BBox, points: RescanRegionPoint[]): boolean {
  if (!points.length) return true;
  if (points.some((p) => p.x >= rect.x0 && p.x <= rect.x1 && p.y >= rect.y0 && p.y <= rect.y1)) {
    return true;
  }
  const corners: RescanRegionPoint[] = [
    { x: rect.x0, y: rect.y0 },
    { x: rect.x1, y: rect.y0 },
    { x: rect.x1, y: rect.y1 },
    { x: rect.x0, y: rect.y1 },
  ];
  if (corners.some((c) => pointInPolygon(c.x, c.y, points))) return true;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    for (let k = 0; k < 4; k++) {
      if (segmentsIntersect(a, b, corners[k], corners[(k + 1) % 4])) return true;
    }
  }
  return false;
}

function areaInRegion(area: CleanArea, region: RescanRegion): boolean {
  return rectIntersectsPolygon(area.bbox, region.points);
}

function sameArea(a: CleanArea, b: CleanArea): boolean {
  return (
    a.fallbackShape === b.fallbackShape &&
    a.kind === b.kind &&
    a.bbox.x0 === b.bbox.x0 &&
    a.bbox.y0 === b.bbox.y0 &&
    a.bbox.x1 === b.bbox.x1 &&
    a.bbox.y1 === b.bbox.y1
  );
}

function computeDiff(
  oldItems: OverlayItem[],
  newItems: OverlayItem[],
  oldAreas: CleanArea[],
  newAreas: CleanArea[],
  oldOverrides: TextBoxOverride[],
  newOverrides: TextBoxOverride[],
  includeText: boolean,
  includeMask: boolean,
): RescanCandidate["diff"] {
  const texts: RescanTextDiff[] = [];
  if (includeText) {
    const oldOverrideMap = new Map(oldOverrides.map((o) => [o.index, o]));
    const newOverrideMap = new Map(newOverrides.map((o) => [o.index, o]));
    const pairs = pairByIoU(oldItems.map((it) => it.bbox), newItems.map((it) => it.bbox));
    const pairedOld = new Set(pairs.values());
    newItems.forEach((item, ni) => {
      const oi = pairs.get(ni);
      if (oi === undefined) {
        const newText = newOverrideMap.get(ni)?.text ?? item.text;
        if (newText.trim() || item.sourceText?.trim()) {
          texts.push({
            id: `t:${ni}:-1`,
            kind: "added",
            oldIndex: null,
            newIndex: ni,
            source: item.sourceText ?? item.text,
            oldText: "",
            newText,
          });
        }
        return;
      }
      const old = oldItems[oi];
      const oldText = oldOverrideMap.get(oi)?.text ?? old.text;
      const newText = newOverrideMap.get(ni)?.text ?? item.text;
      if (oldText === newText && (old.sourceText ?? "") === (item.sourceText ?? "")) return;
      texts.push({
        id: `t:${ni}:${oi}`,
        kind: "changed",
        oldIndex: oi,
        newIndex: ni,
        source: item.sourceText ?? old.sourceText ?? oldText,
        oldText,
        newText,
      });
    });
    oldItems.forEach((item, oi) => {
      if (pairedOld.has(oi)) return;
      const oldText = oldOverrideMap.get(oi)?.text ?? item.text;
      texts.push({
        id: `t:-1:${oi}`,
        kind: "removed",
        oldIndex: oi,
        newIndex: null,
        source: item.sourceText ?? item.text,
        oldText,
        newText: "",
      });
    });
  }

  const masks: RescanMaskDiff[] = [];
  if (includeMask) {
    const pairs = pairByIoU(oldAreas.map((a) => a.bbox), newAreas.map((a) => a.bbox), 0.2);
    const pairedOld = new Set(pairs.values());
    newAreas.forEach((area, ni) => {
      const oi = pairs.get(ni);
      if (oi === undefined) {
        masks.push({
          id: `m:${ni}:-1`,
          kind: "added",
          oldIndex: null,
          newIndex: ni,
          bbox: area.bbox,
        });
        return;
      }
      if (sameArea(oldAreas[oi], area)) return;
      masks.push({
        id: `m:${ni}:${oi}`,
        kind: "changed",
        oldIndex: oi,
        newIndex: ni,
        bbox: area.bbox,
      });
    });
    oldAreas.forEach((area, oi) => {
      if (pairedOld.has(oi)) return;
      masks.push({
        id: `m:-1:${oi}`,
        kind: "removed",
        oldIndex: oi,
        newIndex: null,
        bbox: area.bbox,
      });
    });
  }

  // Perubahan skala font per kotak tetap muncul sebagai diff teks.
  if (includeText) {
    const oldMap = new Map(oldOverrides.map((o) => [o.index, o]));
    const newMap = new Map(newOverrides.map((o) => [o.index, o]));
    for (const [index, next] of newMap) {
      const prev = oldMap.get(index);
      if (!prev) continue;
      if ((prev.scale ?? 100) === (next.scale ?? 100)) continue;
      const item = newItems[index];
      if (!item) continue;
      if (texts.some((t) => t.newIndex === index)) continue;
      texts.push({
        id: `t:${index}:${index}`,
        kind: "changed",
        oldIndex: index,
        newIndex: index,
        source: item.sourceText ?? item.text,
        oldText: prev.text ?? oldItems[index]?.text ?? "",
        newText: next.text ?? item.text,
      });
    }
  }

  return { texts, masks };
}

interface ReadBox extends OcrBox {
  bubbleIdx?: number;
  shape?: BubbleShapeResult;
  fallbackShape?: "rect" | "round" | "line" | "manual";
}

type ReadMode = "full" | "bubbles" | "crop";

interface ReadPageResult {
  boxes: ReadBox[];
  cleanAreas: CleanArea[];
  via: string;
  bubbleCount: number;
  undetected: number;
  /** Bbox yang diganti UTUH (bubble/region Google) di mode lasso. */
  replaceBoxes: BBox[];
  mode: ReadMode;
}

function fullResult(result: Omit<ReadPageResult, "replaceBoxes" | "mode">): ReadPageResult {
  return { ...result, replaceBoxes: [], mode: "full" };
}

function mapCropLines(lines: BBox[], cropPageBox: BBox): BBox[] {
  const out: BBox[] = [];
  for (const line of lines) {
    const x0 = cropPageBox.x0 + line.x0 / 2;
    const y0 = cropPageBox.y0 + line.y0 / 2;
    const x1 = cropPageBox.x0 + line.x1 / 2;
    const y1 = cropPageBox.y0 + line.y1 / 2;
    if (x1 - x0 < 8 || y1 - y0 < 6) continue;
    out.push({ x0, y0, x1, y1 });
  }
  return out;
}

function insetBoxPolygon(b: BBox, inset = 4): Array<{ x: number; y: number }> {
  return [
    { x: b.x0 + inset, y: b.y0 + inset },
    { x: b.x1 - inset, y: b.y0 + inset },
    { x: b.x1 - inset, y: b.y1 - inset },
    { x: b.x0 + inset, y: b.y1 - inset },
  ];
}

async function readFullPage(
  source: Buffer,
  settings: RescanSettings,
  googleApiKey: string | undefined,
): Promise<ReadPageResult> {
  const google = settings.ocrEngine === "google_vision";
  const boxes = google
    ? await ocrGoogleFullPage(source, undefined, googleApiKey)
    : await ocrEnglish(source, undefined, settings.sourceLang);
  return fullResult({
    boxes: boxes.map((b) => ({ ...b, fallbackShape: "line" as const })),
    cleanAreas: [],
    via: google ? "google-vision" : "ocr-full",
    bubbleCount: 0,
    undetected: 0,
  });
}

// OCR crop area lasso (dipakai saat area tidak menyentuh bubble / mode full-page).
async function readRegionCrop(
  source: Buffer,
  region: RescanRegion,
  cleanMode: string,
  settings: RescanSettings,
  apiKey: string | undefined,
  googleApiKey: string | undefined,
): Promise<ReadPageResult> {
  const left = Math.max(0, Math.floor(region.bbox.x0));
  const top = Math.max(0, Math.floor(region.bbox.y0));
  const width = Math.max(1, Math.ceil(region.bbox.x1) - left);
  const height = Math.max(1, Math.ceil(region.bbox.y1) - top);
  const crop = await sharp(source)
    .extract({ left, top, width, height })
    .png()
    .toBuffer();
  const google = settings.ocrEngine === "google_vision";
  const vision = settings.ocrEngine === "vision_llm";
  let boxes: ReadBox[] = [];
  if (vision) {
    const text = await ocrVisionLLM(crop, apiKey);
    if (text.trim()) {
      boxes = [
        {
          text,
          conf: 99,
          bbox: { x0: region.bbox.x0, y0: region.bbox.y0, x1: region.bbox.x1, y1: region.bbox.y1 },
          fallbackShape: cleanMode === "text" ? "line" : undefined,
        },
      ];
    }
  } else {
    const raw = google
      ? await ocrGoogleFullPage(crop, undefined, googleApiKey)
      : await ocrEnglish(crop, undefined, settings.sourceLang);
    boxes = raw.map((box) => ({
      ...box,
      bbox: {
        x0: box.bbox.x0 + left,
        y0: box.bbox.y0 + top,
        x1: box.bbox.x1 + left,
        y1: box.bbox.y1 + top,
      },
      fallbackShape: cleanMode === "text" ? ("line" as const) : undefined,
    }));
  }
  return {
    boxes,
    // Teks di luar bubble tetap butuh area mask sendiri; kalau tidak, halaman
    // yang sudah punya cleanAreas bubble tidak akan menimpa teks SFX ini.
    cleanAreas: boxes.map((box) => ({
      bbox: { ...box.bbox },
      fallbackShape: "line" as const,
    })),
    via: google ? "google-vision-area" : vision ? "vision-llm-area" : "ocr-area",
    bubbleCount: 0,
    undetected: 0,
    replaceBoxes: [],
    mode: "crop",
  };
}

async function readGoogleRegions(
  source: Buffer,
  width: number,
  height: number,
  cleanMode: string,
  googleApiKey: string | undefined,
  region: RescanRegion | undefined,
): Promise<ReadPageResult> {
  const detail = await ocrGooglePageDetail(source, googleApiKey);
  const regions = mergeVisionBlocks(detail.blocks, width, height);
  const shapes = await extractBubbleShapes(source, regions, "google");
  const grouped = new Map<number, typeof detail.paras>();
  const ungrouped: typeof detail.paras = [];
  for (const para of detail.paras) {
    const ri = findRegionForBox(para.bbox, regions);
    if (ri < 0) ungrouped.push(para);
    else grouped.set(ri, [...(grouped.get(ri) || []), para]);
  }
  const entries = [...grouped.entries()].map(([ri, paras]) => {
    paras.sort((a, b) => a.bbox.y0 - b.bbox.y0 || b.bbox.x0 - a.bbox.x0);
    const bbox = paras.reduce(
      (acc, p) => ({
        x0: Math.min(acc.x0, p.bbox.x0),
        y0: Math.min(acc.y0, p.bbox.y0),
        x1: Math.max(acc.x1, p.bbox.x1),
        y1: Math.max(acc.y1, p.bbox.y1),
      }),
      { ...paras[0].bbox },
    );
    return {
      box: {
        text: paras.map((p) => p.text).join(" "),
        conf: Math.min(...paras.map((p) => p.conf)),
        bbox,
        shape: shapes[ri] ?? null,
        fallbackShape: "rect" as const,
      },
      regionIndex: ri,
    };
  });
  entries.push(
    ...ungrouped.map((p) => ({
      box: {
        text: p.text,
        conf: p.conf,
        bbox: p.bbox,
        shape: null,
        fallbackShape: "rect" as const,
      },
      regionIndex: -1,
    })),
  );
  entries.sort((a, b) => a.box.bbox.y0 - b.box.bbox.y0 || b.box.bbox.x0 - a.box.bbox.x0);

  const selectedRegionIdx = region
    ? regions
        .map((box, index) => ({ box, index }))
        .filter(
          (entry) =>
            rectIntersectsPolygon(entry.box, region.points) ||
            pointInPolygon(
              (entry.box.x0 + entry.box.x1) / 2,
              (entry.box.y0 + entry.box.y1) / 2,
              region.points,
            ),
        )
        .map((entry) => entry.index)
    : regions.map((_, index) => index);
  const selectedRegionSet = new Set(selectedRegionIdx);
  const selectedRegions = selectedRegionIdx.map((index) => regions[index]);

  const selectedEntries = region
    ? entries.filter((entry) =>
        entry.regionIndex >= 0
          ? selectedRegionSet.has(entry.regionIndex)
          : rectIntersectsPolygon(entry.box.bbox, region.points),
      )
    : entries;

  const selectedParas = region
    ? detail.paras.filter((para) => {
        const ri = findRegionForBox(para.bbox, regions);
        return (
          (ri >= 0 && selectedRegionSet.has(ri)) ||
          rectIntersectsPolygon(para.bbox, region.points)
        );
      })
    : detail.paras;

  let cleanAreas: CleanArea[];
  if (cleanMode === "text") {
    cleanAreas = selectedParas.map((p) => {
      const ri = findRegionForBox(p.bbox, regions);
      return {
        bbox: p.bbox,
        fallbackShape: "line" as const,
        clipPolygon:
          ri >= 0
            ? shapes[ri]?.points?.length
              ? shapes[ri]!.points
              : insetBoxPolygon(regions[ri])
            : undefined,
      };
    });
  } else {
    cleanAreas = selectedRegionIdx.map((index) => ({
      bbox: regions[index],
      polygon: shapes[index]?.points,
      kind: shapes[index]?.kind,
      fallbackShape: "rect" as const,
    }));
  }

  return {
    boxes: selectedEntries.map((e) => e.box),
    cleanAreas,
    via: "google-vision-regions",
    bubbleCount: selectedRegions.length,
    undetected: region ? 0 : Math.max(0, regions.length - grouped.size),
    replaceBoxes: region ? selectedRegions : [],
    mode: region ? "bubbles" : "full",
  };
}

async function readBubblePage(
  source: Buffer,
  width: number,
  height: number,
  cleanMode: string,
  settings: RescanSettings,
  apiKey: string | undefined,
  googleApiKey: string | undefined,
  region: RescanRegion | undefined,
): Promise<ReadPageResult> {
  const detected = await detectBubbles([source], settings.bubble);
  const allBubbles = detected.lists[0] ?? [];
  const model = detected.model;
  const bubbles = region
    ? allBubbles.filter(
        (b) =>
          rectIntersectsPolygon(b, region.points) ||
          pointInPolygon((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, region.points),
      )
    : allBubbles;

  if (region && !bubbles.length) {
    return readRegionCrop(source, region, cleanMode, settings, apiKey, googleApiKey);
  }
  if (!region && !bubbles.length) {
    return readFullPage(source, settings, googleApiKey);
  }

  const crops = await Promise.all(bubbles.map((b) => cropBubble(source, b, width, height)));
  const validWithIdx = crops
    .map((crop, idx) => ({ crop, idx }))
    .filter((v): v is { crop: NonNullable<typeof crops[number]>; idx: number } => v.crop !== null);
  const valid = validWithIdx.map((v) => v.crop);

  const useGoogle = settings.ocrEngine === "google_vision";
  const useVision = settings.ocrEngine === "vision_llm";
  const texts = useGoogle
    ? await ocrGoogleBubbleCrops(valid.map((c) => c.buffer), undefined, googleApiKey)
    : useVision
      ? await ocrVisionBubbleCrops(valid.map((c) => c.buffer), undefined, apiKey)
      : await ocrBubbleCrops(valid.map((c) => c.buffer), undefined, settings.sourceLang);

  const lineMap = new Map<number, BBox[]>();
  if (cleanMode === "text") {
    if (!useVision && !useGoogle) {
      (texts as Array<{ text: string; conf: number; lines?: OcrBox[] } | null>).forEach((t, k) => {
        if (!t || !t.lines?.length) return;
        const mapped = mapCropLines(t.lines.map((l) => l.bbox), valid[k].bbox);
        if (mapped.length) lineMap.set(validWithIdx[k].idx, mapped);
      });
    } else {
      try {
        const lines = await detectBubbleLines(
          valid.map((c) => c.buffer),
          undefined,
          settings.sourceLang,
        );
        lines.forEach((list, k) => {
          if (!texts[k] || !list.length) return;
          const mapped = mapCropLines(list.map((l) => l.bbox), valid[k].bbox);
          if (mapped.length) lineMap.set(validWithIdx[k].idx, mapped);
        });
      } catch {
        // Garis gagal = fallback mask bubble penuh.
      }
    }
  }

  let boxes: ReadBox[] = texts.flatMap((t, k) =>
    t
      ? [
          {
            text: t.text,
            conf: t.conf,
            bbox: bubbles[validWithIdx[k].idx],
            bubbleIdx: validWithIdx[k].idx,
          },
        ]
      : [],
  );
  boxes.sort((a, b) => a.bbox.y0 - b.bbox.y0 || b.bbox.x0 - a.bbox.x0);

  const viaBase = useGoogle
    ? `yolo-${model}+google-vision`
    : useVision
      ? `yolo-${model}+vision-llm`
      : `yolo-${model}`;
  let via = viaBase;

  if (!boxes.length && !useGoogle && !region) {
    boxes = (await ocrEnglish(source, undefined, settings.sourceLang)).map((b) => ({
      ...b,
      fallbackShape: "line" as const,
    }));
    via = "ocr-full";
  }

  const bubbleShapes = await extractBubbleShapes(source, bubbles, "yolo");
  const perLine = cleanMode === "text";
  const detectedIdx = new Set(
    boxes.map((b) => b.bubbleIdx).filter((v): v is number => typeof v === "number"),
  );
  const areas: CleanArea[] = [];
  bubbles.forEach((b, k) => {
    const lines = perLine ? lineMap.get(k) : undefined;
    if (lines?.length) {
      for (const lb of lines) {
        areas.push({
          bbox: lb,
          fallbackShape: "line",
          clipPolygon: bubbleShapes[k]?.points?.length
            ? bubbleShapes[k]!.points
            : insetBoxPolygon(b),
        });
      }
    } else if (!perLine || detectedIdx.has(k)) {
      areas.push({
        bbox: b,
        polygon: bubbleShapes[k]?.points,
        kind: bubbleShapes[k]?.kind,
        fallbackShape: "round",
      });
    }
  });
  if (perLine) {
    const lineCount = areas.filter((a) => a.fallbackShape === "line").length;
    if (lineCount > 0) via = `${via}+baris-${lineCount}`;
  }

  const shaped = boxes.map((b) => ({
    ...b,
    shape: b.bubbleIdx !== undefined ? bubbleShapes[b.bubbleIdx] ?? null : null,
    fallbackShape:
      b.bubbleIdx !== undefined
        ? bubbleShapes[b.bubbleIdx]
          ? undefined
          : "round"
        : b.fallbackShape,
  }));

  return {
    boxes: shaped,
    cleanAreas: areas,
    via,
    bubbleCount: bubbles.length,
    undetected: Math.max(0, bubbles.length - detectedIdx.size),
    replaceBoxes: region ? bubbles.map((b) => ({ ...b })) : [],
    mode: region ? "bubbles" : "full",
  };
}

async function readPageText(
  source: Buffer,
  width: number,
  height: number,
  cleanMode: string,
  settings: RescanSettings,
  apiKey: string | undefined,
  googleApiKey: string | undefined,
  region: RescanRegion | undefined,
): Promise<ReadPageResult> {
  let result: ReadPageResult;
  if (settings.bubble === "google") {
    result = await readGoogleRegions(source, width, height, cleanMode, googleApiKey, region);
  } else if (settings.bubble !== "0") {
    result = await readBubblePage(
      source,
      width,
      height,
      cleanMode,
      settings,
      apiKey,
      googleApiKey,
      region,
    );
  } else {
    result = region
      ? await readRegionCrop(source, region, cleanMode, settings, apiKey, googleApiKey)
      : await readFullPage(source, settings, googleApiKey);
  }

  // Area lasso yang tidak menyentuh bubble/region Google: OCR crop area.
  if (
    region &&
    result.mode !== "crop" &&
    result.boxes.length === 0 &&
    result.cleanAreas.length === 0
  ) {
    return readRegionCrop(source, region, cleanMode, settings, apiKey, googleApiKey);
  }
  return result;
}

interface MaskReadResult {
  cleanAreas: CleanArea[];
  bubbleCount: number;
  via: string;
  replaceBoxes: BBox[];
}

// Deteksi mask saja (tanpa OCR teks): bubble YOLO/Google + mask per baris
// bila cleanMode "text" (garis dari Tesseract lokal / paragraf Google).
async function detectPageMasks(
  source: Buffer,
  width: number,
  height: number,
  cleanMode: string,
  settings: RescanSettings,
  googleApiKey: string | undefined,
  region: RescanRegion | undefined,
): Promise<MaskReadResult> {
  if (settings.bubble === "0") {
    throw new Error("Deteksi mask butuh deteksi bubble (Ogkalu/Psimera/Google).");
  }
  if (settings.bubble === "google") {
    const detail = await ocrGooglePageDetail(source, googleApiKey);
    const regions = mergeVisionBlocks(detail.blocks, width, height);
    const selectedRegionIdx = region
      ? regions
          .map((box, index) => ({ box, index }))
          .filter(
            (entry) =>
              rectIntersectsPolygon(entry.box, region.points) ||
              pointInPolygon(
                (entry.box.x0 + entry.box.x1) / 2,
                (entry.box.y0 + entry.box.y1) / 2,
                region.points,
              ),
          )
          .map((entry) => entry.index)
      : regions.map((_, index) => index);
    const selectedRegionSet = new Set(selectedRegionIdx);
    const selectedRegions = selectedRegionIdx.map((index) => regions[index]);
    if (region && !selectedRegions.length) {
      return { cleanAreas: [], bubbleCount: 0, via: "google-vision-regions", replaceBoxes: [] };
    }
    const shapes = await extractBubbleShapes(source, selectedRegions, "google");
    const selectedParas = region
      ? detail.paras.filter((para) => {
          const ri = findRegionForBox(para.bbox, regions);
          return (
            (ri >= 0 && selectedRegionSet.has(ri)) ||
            rectIntersectsPolygon(para.bbox, region.points)
          );
        })
      : detail.paras;
    const areas: CleanArea[] =
      cleanMode === "text"
        ? selectedParas.map((p) => {
            const ri = findRegionForBox(p.bbox, regions);
            return {
              bbox: p.bbox,
              fallbackShape: "line" as const,
              clipPolygon:
                ri >= 0
                  ? shapes[selectedRegionIdx.indexOf(ri)]?.points?.length
                    ? shapes[selectedRegionIdx.indexOf(ri)]!.points
                    : insetBoxPolygon(regions[ri])
                  : undefined,
            };
          })
        : selectedRegions.map((b, k) => ({
            bbox: b,
            polygon: shapes[k]?.points,
            kind: shapes[k]?.kind,
            fallbackShape: "rect" as const,
          }));
    return {
      cleanAreas: areas,
      bubbleCount: selectedRegions.length,
      via: "google-vision-regions",
      replaceBoxes: selectedRegions,
    };
  }

  const detected = await detectBubbles([source], settings.bubble);
  const allBubbles = detected.lists[0] ?? [];
  const model = detected.model;
  const bubbles = region
    ? allBubbles.filter(
        (b) =>
          rectIntersectsPolygon(b, region.points) ||
          pointInPolygon((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, region.points),
      )
    : allBubbles;
  if (region && !bubbles.length) {
    return { cleanAreas: [], bubbleCount: 0, via: `yolo-${model}`, replaceBoxes: [] };
  }
  const shapes = await extractBubbleShapes(source, bubbles, "yolo");
  if (cleanMode !== "text") {
    return {
      cleanAreas: bubbles.map((b, k) => ({
        bbox: b,
        polygon: shapes[k]?.points,
        kind: shapes[k]?.kind,
        fallbackShape: "round" as const,
      })),
      bubbleCount: bubbles.length,
      via: `yolo-${model}`,
      replaceBoxes: bubbles,
    };
  }

  const crops = await Promise.all(bubbles.map((b) => cropBubble(source, b, width, height)));
  const validWithIdx = crops
    .map((crop, idx) => ({ crop, idx }))
    .filter((v): v is { crop: NonNullable<typeof crops[number]>; idx: number } => v.crop !== null);
  let lines: OcrBox[][] = [];
  try {
    lines = await detectBubbleLines(
      validWithIdx.map((v) => v.crop.buffer),
      undefined,
      settings.sourceLang,
    );
  } catch {
    lines = validWithIdx.map(() => []);
  }
  const lineMap = new Map<number, BBox[]>();
  lines.forEach((list, k) => {
    if (!list.length) return;
    const mapped = mapCropLines(list.map((l) => l.bbox), validWithIdx[k].crop.bbox);
    if (mapped.length) lineMap.set(validWithIdx[k].idx, mapped);
  });

  const areas: CleanArea[] = [];
  bubbles.forEach((b, k) => {
    const found = lineMap.get(k);
    if (found?.length) {
      for (const lb of found) {
        areas.push({
          bbox: lb,
          fallbackShape: "line",
          clipPolygon: shapes[k]?.points?.length ? shapes[k]!.points : insetBoxPolygon(b),
        });
      }
    } else {
      areas.push({
        bbox: b,
        polygon: shapes[k]?.points,
        kind: shapes[k]?.kind,
        fallbackShape: "round",
      });
    }
  });
  const lineCount = areas.filter((a) => a.fallbackShape === "line").length;
  return {
    cleanAreas: areas,
    bubbleCount: bubbles.length,
    via: lineCount > 0 ? `yolo-${model}+baris-${lineCount}` : `yolo-${model}`,
    replaceBoxes: bubbles,
  };
}

function oldSourceTexts(page: StoredPage, jobPage: ProcessPage | undefined): string[] {
  return page.items.map((item, i) => {
    if (item.sourceText?.trim()) return item.sourceText;
    return jobPage?.boxes[i]?.en ?? "";
  });
}

function remapEditsForKept(
  oldEdits: AutoMaskEdit[],
  keptOldIndices: number[],
): AutoMaskEdit[] {
  const map = new Map(keptOldIndices.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  return oldEdits.flatMap((edit) => {
    const index = map.get(edit.index);
    return index === undefined ? [] : [{ ...edit, index }];
  });
}

async function buildCandidate(opts: {
  jobId: string;
  file: string;
  action: RescanAction;
  settings: RescanSettings;
  region?: RescanRegion;
  apiKey?: string;
  googleApiKey?: string;
}): Promise<RescanCandidate> {
  const jobDir = jobDirFor(opts.jobId);
  const store = readRenderStore(jobDir);
  const page = store?.pages[opts.file];
  const job = getJob(opts.jobId);
  if (!store || !page || !job) throw new Error("Halaman tidak ditemukan.");
  const sourceAbs = sourceFilePath(jobDir, page.sourceFile);
  if (!fs.existsSync(sourceAbs)) throw new Error("Sumber halaman sudah tidak tersedia.");
  const source = fs.readFileSync(sourceAbs);
  const jobPage = job.result?.pages.find((p) => p.file === opts.file);
  const region = opts.region;

  let items: OverlayItem[] = page.items;
  let cleanAreas: CleanArea[] = page.cleanAreas;
  let overrides: TextBoxOverride[] = page.textOverrides ?? [];
  let autoMaskEdits: AutoMaskEdit[] = page.autoMaskEdits ?? [];
  let via = jobPage?.via ?? "ocr-full";
  let bubbleCount = jobPage?.bubbleCount ?? page.cleanAreas.length;
  let undetected = page.undetected;
  let includeText = false;
  let includeMask = false;

  if (opts.action === "mask") {
    const detected = await detectPageMasks(
      source,
      page.width,
      page.height,
      page.cleanMode,
      opts.settings,
      opts.googleApiKey,
      region,
    );
    if (!region) {
      cleanAreas = detected.cleanAreas;
      autoMaskEdits = [];
      bubbleCount = detected.bubbleCount;
    } else if (detected.cleanAreas.length > 0) {
      const removeMask = (area: CleanArea) =>
        detected.replaceBoxes.length
          ? bboxTouchesAny(area.bbox, detected.replaceBoxes)
          : areaInRegion(area, region);
      const kept = page.cleanAreas
        .map((area, index) => ({ area, index }))
        .filter((entry) => !removeMask(entry.area));
      cleanAreas = [...kept.map((entry) => entry.area), ...detected.cleanAreas];
      autoMaskEdits = remapEditsForKept(
        page.autoMaskEdits ?? [],
        kept.map((entry) => entry.index),
      );
    }
    includeMask = true;
  } else if (opts.action === "translate") {
    const sources = oldSourceTexts(page, jobPage);
    const targetIndices = page.items
      .map((item, index) => ({ item, index }))
      .filter((entry) => !region || rectIntersectsPolygon(entry.item.bbox, region.points))
      .map((entry) => entry.index);
    if (!targetIndices.length) {
      includeText = true;
    } else {
      if (!sources.some((s) => s.trim())) {
        throw new Error(
          "Teks sumber OCR tidak tersimpan untuk halaman ini. Jalankan 'OCR + terjemah ulang'.",
        );
      }
      const translated = await translateBatch(
        targetIndices.map((index) => sources[index]),
        opts.settings.provider,
        undefined,
        opts.apiKey,
        opts.settings.sourceLang,
        opts.settings.targetLang,
      );
      const translatedMap = new Map(targetIndices.map((index, k) => [index, translated[k]]));
      items = page.items.map((item, index) => {
        if (!translatedMap.has(index)) return item;
        return {
          ...item,
          sourceText: sources[index] || item.sourceText,
          text: translatedMap.get(index) ?? item.text,
        };
      });
      overrides = (page.textOverrides ?? []).map((override) => {
        if (!translatedMap.has(override.index)) return override;
        const next = { ...override };
        delete next.text;
        return next;
      });
      includeText = true;
    }
  } else {
    // ocr_translate
    const read = await readPageText(
      source,
      page.width,
      page.height,
      page.cleanMode,
      opts.settings,
      opts.apiKey,
      opts.googleApiKey,
      region,
    );
    const sources = read.boxes.map((b) => b.text);
    const translated = sources.length
      ? await translateBatch(
          sources,
          opts.settings.provider,
          undefined,
          opts.apiKey,
          opts.settings.sourceLang,
          opts.settings.targetLang,
        )
      : [];
    const newItems: OverlayItem[] = read.boxes.map((box, k) => ({
      text: translated[k] ?? "",
      sourceText: box.text,
      bbox: box.bbox,
      polygon: box.shape?.points,
      kind: box.shape?.kind,
      fallbackShape: box.fallbackShape,
    }));

    if (!region) {
      items = newItems;
      cleanAreas = read.cleanAreas;
      overrides = [];
      autoMaskEdits = [];
      via = read.via;
      bubbleCount = read.bubbleCount;
      undetected = read.undetected;
    } else if (newItems.length || read.cleanAreas.length) {
      const replaceBoxes = read.replaceBoxes;
      const removeItem = (bbox: BBox) =>
        replaceBoxes.length
          ? bboxTouchesAny(bbox, replaceBoxes)
          : rectIntersectsPolygon(bbox, region.points);
      const removeMask = (area: CleanArea) =>
        replaceBoxes.length
          ? bboxTouchesAny(area.bbox, replaceBoxes)
          : areaInRegion(area, region);

      if (newItems.length) {
        const kept = page.items
          .map((item, index) => ({ item, index }))
          .filter((entry) => !removeItem(entry.item.bbox));
        const entries = [
          ...kept.map((entry) => ({ item: entry.item, oldIndex: entry.index })),
          ...newItems.map((item) => ({ item, oldIndex: null as number | null })),
        ].sort((a, b) => a.item.bbox.y0 - b.item.bbox.y0 || a.item.bbox.x0 - b.item.bbox.x0);
        items = entries.map((entry) => entry.item);
        const oldToNew = new Map<number, number>();
        entries.forEach((entry, index) => {
          if (entry.oldIndex !== null) oldToNew.set(entry.oldIndex, index);
        });
        overrides = (page.textOverrides ?? []).flatMap((override) => {
          const index = oldToNew.get(override.index);
          return index === undefined ? [] : [{ ...override, index }];
        });
      }

      if (read.cleanAreas.length || read.mode === "crop") {
        const keptMasks = page.cleanAreas
          .map((area, index) => ({ area, index }))
          .filter((entry) => !removeMask(entry.area));
        cleanAreas = [...keptMasks.map((entry) => entry.area), ...read.cleanAreas];
        autoMaskEdits = remapEditsForKept(
          page.autoMaskEdits ?? [],
          keptMasks.map((entry) => entry.index),
        );
      }

      via = jobPage?.via ?? read.via;
      bubbleCount = jobPage?.bubbleCount ?? page.cleanAreas.length;
      undetected = page.undetected;
    }
    includeText = true;
    includeMask = true;
  }

  const diff = computeDiff(
    page.items,
    items,
    page.cleanAreas,
    cleanAreas,
    page.textOverrides ?? [],
    overrides,
    includeText,
    includeMask,
  );

  const token = crypto.randomBytes(16).toString("hex");
  const candidate: RescanCandidate = {
    token,
    action: opts.action,
    file: opts.file,
    createdAt: Date.now(),
    settings: opts.settings,
    region,
    oldItems: page.items,
    oldCleanAreas: page.cleanAreas,
    oldOverrides: page.textOverrides ?? [],
    oldAutoMaskEdits: page.autoMaskEdits ?? [],
    items,
    cleanAreas,
    overrides,
    autoMaskEdits,
    diff,
    via,
    bubbleCount,
    undetected,
  };

  const dir = path.join(jobDir, CANDIDATE_DIR);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(candidatePath(jobDir, token), JSON.stringify(candidate));

  // Preview dirender dari state kandidat tanpa menyentuh halaman hasil.
  const previewPage: StoredPage = {
    ...page,
    items,
    cleanAreas,
    autoMaskEdits,
    textOverrides: overrides,
    font: page.font,
  };
  try {
    const preview = await renderStoredPage(jobDir, previewPage, store, { write: false });
    fs.writeFileSync(previewPath(jobDir, token), preview);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }

  return candidate;
}

export async function createRescanCandidate(opts: {
  jobId: string;
  file: string;
  action: RescanAction;
  settings: unknown;
  region?: unknown;
  apiKey?: string;
  googleApiKey?: string;
}): Promise<RescanCandidate> {
  if (!["mask", "translate", "ocr_translate"].includes(opts.action)) {
    throw new Error("Aksi pindai ulang tidak valid.");
  }
  const store = readRenderStore(jobDirFor(opts.jobId));
  const page = store?.pages[opts.file];
  if (!store || !page) throw new Error("Halaman tidak ditemukan.");
  const region = normalizeRescanRegion(opts.region, page.width, page.height);
  return buildCandidate({
    ...opts,
    region,
    settings: normalizeRescanSettings(opts.settings),
  });
}

export function readRescanCandidate(jobId: string, token: string): RescanCandidate | null {
  if (!TOKEN_RE.test(token)) return null;
  try {
    const raw = fs.readFileSync(candidatePath(jobDirFor(jobId), token), "utf8");
    const parsed = JSON.parse(raw) as RescanCandidate;
    return parsed?.token === token ? parsed : null;
  } catch {
    return null;
  }
}

export function deleteRescanCandidate(jobId: string, token: string): void {
  if (!TOKEN_RE.test(token)) return;
  const jobDir = jobDirFor(jobId);
  fs.rmSync(candidatePath(jobDir, token), { force: true });
  fs.rmSync(previewPath(jobDir, token), { force: true });
}

export function rescanPreviewPath(jobId: string, token: string): string | null {
  if (!TOKEN_RE.test(token)) return null;
  const file = previewPath(jobDirFor(jobId), token);
  return fs.existsSync(file) ? file : null;
}

interface MergedItem {
  item: OverlayItem;
  /** Index item lama yang dipertahankan (null = item baru / hasil kandidat). */
  oldIndex: number | null;
}

function mergeItemEntries(
  candidate: RescanCandidate,
  selected: Set<string>,
): MergedItem[] {
  const rows = candidate.diff.texts;
  if (!rows.length) {
    const pairs = pairByIoU(
      candidate.oldItems.map((it) => it.bbox),
      candidate.items.map((it) => it.bbox),
    );
    return candidate.items.map((item, index) => ({
      item,
      oldIndex: pairs.get(index) ?? null,
    }));
  }
  const rowByNew = new Map<number, RescanTextDiff>();
  for (const row of rows) {
    if (row.newIndex !== null) rowByNew.set(row.newIndex, row);
  }
  const allPairs = pairByIoU(
    candidate.oldItems.map((it) => it.bbox),
    candidate.items.map((it) => it.bbox),
  );
  const out: MergedItem[] = [];
  candidate.items.forEach((item, index) => {
    const row = rowByNew.get(index);
    if (!row) {
      out.push({ item, oldIndex: allPairs.get(index) ?? null });
      return;
    }
    if (selected.has(row.id)) {
      out.push({ item, oldIndex: null });
      return;
    }
    if (row.oldIndex !== null) {
      const prev = candidate.oldItems[row.oldIndex];
      if (prev) {
        const oldOverride = candidate.oldOverrides.find((o) => o.index === row.oldIndex);
        const prevText = oldOverride?.text ?? prev.text;
        out.push({
          item: candidate.action === "translate" ? { ...item, text: prevText } : prev,
          oldIndex: row.oldIndex,
        });
      }
    }
  });
  for (const row of rows) {
    if (row.newIndex !== null || row.oldIndex === null) continue;
    if (selected.has(row.id)) continue;
    const prev = candidate.oldItems[row.oldIndex];
    if (prev) out.push({ item: prev, oldIndex: row.oldIndex });
  }
  if (candidate.action === "ocr_translate") {
    out.sort((a, b) => a.item.bbox.y0 - b.item.bbox.y0 || a.item.bbox.x0 - b.item.bbox.x0);
  }
  return out;
}

function mergeItems(candidate: RescanCandidate, selected: Set<string>): OverlayItem[] {
  return mergeItemEntries(candidate, selected).map((entry) => entry.item);
}

interface MergedMask {
  area: CleanArea;
  oldIndex: number | null;
}

function mergeMaskEntries(
  candidate: RescanCandidate,
  selected: Set<string>,
): MergedMask[] {
  const rows = candidate.diff.masks;
  if (!rows.length) {
    const pairs = pairByIoU(
      candidate.oldCleanAreas.map((a) => a.bbox),
      candidate.cleanAreas.map((a) => a.bbox),
      0.2,
    );
    return candidate.cleanAreas.map((area, index) => ({
      area,
      oldIndex: pairs.get(index) ?? null,
    }));
  }
  const rowByNew = new Map<number, RescanMaskDiff>();
  for (const row of rows) {
    if (row.newIndex !== null) rowByNew.set(row.newIndex, row);
  }
  const allPairs = pairByIoU(
    candidate.oldCleanAreas.map((a) => a.bbox),
    candidate.cleanAreas.map((a) => a.bbox),
    0.2,
  );
  const out: MergedMask[] = [];
  candidate.cleanAreas.forEach((area, index) => {
    const row = rowByNew.get(index);
    if (!row) {
      out.push({ area, oldIndex: allPairs.get(index) ?? null });
      return;
    }
    if (selected.has(row.id)) {
      out.push({ area, oldIndex: null });
      return;
    }
    if (row.oldIndex !== null) {
      const prev = candidate.oldCleanAreas[row.oldIndex];
      if (prev) out.push({ area: prev, oldIndex: row.oldIndex });
    }
  });
  for (const row of rows) {
    if (row.newIndex !== null || row.oldIndex === null) continue;
    if (selected.has(row.id)) continue;
    const prev = candidate.oldCleanAreas[row.oldIndex];
    if (prev) out.push({ area: prev, oldIndex: row.oldIndex });
  }
  return out;
}

// Koreksi geser/hapus mask otomatis dipertahankan untuk mask lama yang tidak
// diganti hasil baru; index di-remap ke urutan final.
function remapOldMaskEdits(
  candidate: RescanCandidate,
  merged: MergedMask[],
): AutoMaskEdit[] {
  const oldEditMap = new Map(candidate.oldAutoMaskEdits.map((edit) => [edit.index, edit]));
  return merged.flatMap((entry, index) => {
    if (entry.oldIndex === null) return [];
    const edit = oldEditMap.get(entry.oldIndex);
    return edit ? [{ ...edit, index }] : [];
  });
}

export interface ApplyRescanResult {
  version: number;
  pagesUpdated: number;
  archivesUpdated: boolean;
  page: ProcessPage;
}

export async function applyRescan(opts: {
  jobId: string;
  token: string;
  selectedText?: string[];
  selectedMask?: string[];
}): Promise<ApplyRescanResult> {
  const candidate = readRescanCandidate(opts.jobId, opts.token);
  if (!candidate) throw new Error("Pembanding sudah kedaluwarsa. Jalankan pindai ulang lagi.");
  const jobDir = jobDirFor(opts.jobId);
  const store = readRenderStore(jobDir);
  const page = store?.pages[candidate.file];
  const job = getJob(opts.jobId);
  if (!store || !page || !job) throw new Error("Halaman tidak ditemukan.");

  const textIds = new Set(
    Array.isArray(opts.selectedText)
      ? opts.selectedText.filter((id) => typeof id === "string")
      : candidate.diff.texts.map((row) => row.id),
  );
  const maskIds = new Set(
    Array.isArray(opts.selectedMask)
      ? opts.selectedMask.filter((id) => typeof id === "string")
      : candidate.diff.masks.map((row) => row.id),
  );
  const allTextSelected =
    candidate.diff.texts.length === 0 ||
    candidate.diff.texts.every((row) => textIds.has(row.id));
  const allMaskSelected =
    candidate.diff.masks.length === 0 ||
    candidate.diff.masks.every((row) => maskIds.has(row.id));

  if (candidate.action === "mask") {
    if (allMaskSelected) {
      page.cleanAreas = candidate.cleanAreas;
      page.autoMaskEdits = candidate.autoMaskEdits;
    } else {
      const merged = mergeMaskEntries(candidate, maskIds);
      page.cleanAreas = merged.map((entry) => entry.area);
      page.autoMaskEdits = remapOldMaskEdits(candidate, merged);
    }
  } else if (candidate.action === "translate") {
    if (allTextSelected) {
      page.items = candidate.items;
      page.textOverrides = candidate.overrides;
    } else {
      page.items = mergeItems(candidate, textIds);
      page.textOverrides = candidate.overrides;
    }
  } else {
    if (allTextSelected) {
      page.items = candidate.items;
      page.textOverrides = candidate.overrides;
    } else {
      const merged = mergeItemEntries(candidate, textIds);
      page.items = merged.map((entry) => entry.item);
      const oldOverrideMap = new Map(candidate.oldOverrides.map((o) => [o.index, o]));
      page.textOverrides = merged.flatMap((entry, index) => {
        if (entry.oldIndex === null) return [];
        const override = oldOverrideMap.get(entry.oldIndex);
        return override ? [{ ...override, index }] : [];
      });
    }
    if (allMaskSelected) {
      page.cleanAreas = candidate.cleanAreas;
      page.autoMaskEdits = candidate.autoMaskEdits;
    } else {
      const mergedMasks = mergeMaskEntries(candidate, maskIds);
      page.cleanAreas = mergedMasks.map((entry) => entry.area);
      page.autoMaskEdits = remapOldMaskEdits(candidate, mergedMasks);
    }
  }

  const sourceAbs = sourceFilePath(jobDir, page.sourceFile);
  if (!fs.existsSync(sourceAbs)) throw new Error("Sumber halaman sudah tidak tersedia.");

  await renderStoredPage(jobDir, page, store);
  writeRenderStore(jobDir, store);

  let archivesUpdated = true;
  try {
    const files = job.result?.pages?.length
      ? job.result.pages.map((p) => p.file)
      : Object.values(store.pages).map((p) => p.file);
    await buildJobArchives(jobDir, files);
  } catch (e) {
    archivesUpdated = false;
    console.error(`[rescan] gagal memperbarui ZIP/PDF job ${opts.jobId}:`, e);
  }

  const jobPage = job.result?.pages.find((p) => p.file === candidate.file);
  const summary: ProcessPage = {
    file: page.file,
    url: `/api/outputs/${opts.jobId}/${encodeURIComponent(page.file)}`,
    via: candidate.via,
    bubbleCount: candidate.bubbleCount,
    undetected: candidate.undetected,
    boxes: page.items.map((item, i) => ({
      en: item.sourceText ?? jobPage?.boxes[i]?.en ?? "",
      id: item.text,
      bbox: item.bbox,
    })),
  };
  updateJobResultPage(opts.jobId, summary);
  deleteRescanCandidate(opts.jobId, opts.token);

  return {
    version: Date.now(),
    pagesUpdated: 1,
    archivesUpdated,
    page: summary,
  };
}
