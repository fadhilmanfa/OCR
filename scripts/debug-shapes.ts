// Debug visual bentuk bubble: YOLO -> kontur OpenCV -> overlay ID dummy.
// Pakai:  npx tsx scripts/debug-shapes.ts <gambar> [ogkalu|psimera]
// Hasil:  outputs/debug-shape-<nama>.png (mask path vs elips) + stat polygon
//         di console. Tidak menyentuh OCR/translate asli.
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { detectBubbles } from "../lib/bubble";
import { extractBubbleShapes } from "../lib/bubbleShape";
import { overlayTranslations } from "../lib/overlay";

async function main() {
  const image = process.argv[2];
  const model = process.argv[3] || process.env.BUBBLE_MODEL || "ogkalu";
  if (!image || !fs.existsSync(image)) {
    console.log("Pakai: npx tsx scripts/debug-shapes.ts <gambar> [ogkalu|psimera]");
    console.log("  atau tanpa gambar komik: python scripts/make-shape-fixtures.py dulu,");
    console.log("  lalu npx tsx scripts/debug-shapes.ts outputs/fixtures/shape-oval.png");
    process.exit(1);
  }
  const raw = fs.readFileSync(image);
  const normalized = await sharp(raw).png().toBuffer();
  const meta = await sharp(normalized).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;

  const { lists, model: used } = await detectBubbles([normalized], model);
  let regions = lists[0] || [];
  // Kalau YOLO tidak menemukan bubble (mis. gambar fixture sintetik yang
  // bukan halaman komik), pakai seluruh gambar sebagai 1 region agar kontur
  // dan overlay tetap bisa dinilai visualnya.
  if (!regions.length) {
    console.log("YOLO tidak menemukan bubble -> pakai seluruh gambar sebagai 1 region.");
    regions = [{ x0: 0, y0: 0, x1: W, y1: H, conf: 0 }];
  }

  const shapes = await extractBubbleShapes(
    normalized,
    regions.map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 })),
  );
  let contourOk = 0;
  shapes.forEach((s, i) => {
    if (s) {
      contourOk++;
      console.log(
        `  [${i}] contour kind=${s.kind} conf=${s.conf} pts=${s.points.length} ` +
          `bbox=(${Math.round(s.bbox.x0)},${Math.round(s.bbox.y0)}-${Math.round(s.bbox.x1)},${Math.round(s.bbox.y1)})`,
      );
    } else {
      console.log(`  [${i}] ellipse_fallback`);
    }
  });
  console.log(`model=${used} region=${regions.length} contour=${contourOk} fallback=${regions.length - contourOk}`);

  const items = regions.map((b, i) => ({
    text: "Ini contoh terjemahan Indonesia untuk uji bentuk bubble",
    bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 },
    polygon: shapes[i]?.points,
    kind: shapes[i]?.kind,
  }));
  const out = await overlayTranslations(normalized, items);

  fs.mkdirSync("outputs", { recursive: true });
  const name = `debug-shape-${path.parse(image).name}.png`;
  fs.writeFileSync(path.join("outputs", name), out);
  console.log("Tersimpan: outputs/" + name);
}

main().catch((e) => {
  console.error("Gagal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
