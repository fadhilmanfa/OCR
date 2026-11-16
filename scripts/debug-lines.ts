// Debug mode "Per baris teks" pada halaman asli:
// YOLO -> crop -> OCR baris -> mask tight per baris -> overlay.
// Pakai: npx tsx scripts/debug-lines.ts <komik.png> [ogkalu|psimera]
// Simpan: outputs/debug-lines-<nama>.png
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { cropBubble, detectBubbles } from "../lib/bubble";
import { extractBubbleShapes } from "../lib/bubbleShape";
import { ocrBubbleCrops } from "../lib/ocr";
import { overlayTranslations, type CleanArea } from "../lib/overlay";

async function main() {
  const image = process.argv[2];
  const model = process.argv[3] || process.env.BUBBLE_MODEL || "ogkalu";
  if (!image || !fs.existsSync(image)) {
    console.log("Pakai: npx tsx scripts/debug-lines.ts <komik.png> [ogkalu|psimera]");
    process.exit(1);
  }
  const raw = fs.readFileSync(image);
  const normalized = await sharp(raw).png().toBuffer();
  const { width: W = 0, height: H = 0 } = await sharp(normalized).metadata();
  const { lists, model: used } = await detectBubbles([normalized], model);
  const bubbles = lists[0] || [];
  console.log(`model=${used} bubble=${bubbles.length}`);

  const crops = await Promise.all(bubbles.map((b) => cropBubble(normalized, b, W, H)));
  const valid = crops
    .map((crop, idx) => ({ crop, idx }))
    .filter((v): v is { crop: NonNullable<typeof crops[number]>; idx: number } => v.crop !== null);
  const texts = await ocrBubbleCrops(valid.map((v) => v.crop.buffer));

  const lineMap = new Map<number, Array<{ x0: number; y0: number; x1: number; y1: number }>>();
  texts.forEach((t, k) => {
    if (!t?.lines.length) return;
    const box = valid[k].crop.bbox;
    const lines = t.lines.map((l) => ({
      x0: box.x0 + l.bbox.x0 / 2,
      y0: box.y0 + l.bbox.y0 / 2,
      x1: box.x0 + l.bbox.x1 / 2,
      y1: box.y0 + l.bbox.y1 / 2,
    }));
    lineMap.set(valid[k].idx, lines);
  });

  const cleanAreas: CleanArea[] = [];
  const shapes = await extractBubbleShapes(normalized, bubbles, "yolo");
  bubbles.forEach((b, k) => {
    const lines = lineMap.get(k);
    if (lines?.length) {
      for (const bbox of lines) {
        cleanAreas.push({
          bbox,
          fallbackShape: "line",
          clipPolygon: shapes[k]?.points,
        });
      }
      console.log(`  bubble ${k}: ${lines.length} baris "${texts.find((_, i) => valid[i].idx === k)?.text ?? ""}"`);
    } else {
      cleanAreas.push({ bbox: b, fallbackShape: "round" });
      console.log(`  bubble ${k}: fallback bubble penuh`);
    }
  });

  const items = bubbles.map((b, k) => ({
    text: `Terjemahan uji ${k + 1} untuk bubble ini`,
    bbox: b,
    fallbackShape: "round" as const,
  }));
  const out = await overlayTranslations(normalized, items, { cleanMode: "text", cleanAreas });
  fs.mkdirSync("outputs", { recursive: true });
  const name = `debug-lines-${path.parse(image).name}.png`;
  fs.writeFileSync(path.join("outputs", name), out);
  console.log(`baris=${cleanAreas.filter((a) => a.fallbackShape === "line").length} penuh=${cleanAreas.filter((a) => a.fallbackShape === "round").length}`);
  console.log("Tersimpan: outputs/" + name);
}

main().catch((e) => {
  console.error("Gagal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
