// Debug visual: gambar kotak bubble YOLO di atas kopian gambar.
// Pakai:  npx tsx scripts/debug-bubbles.ts <gambar> [ogkalu|psimera]
// Hasil:  outputs/debug-<model>-<nama>.png  (+ tabel koordinat di console)
import fs from "fs";
import path from "path";
import { detectBubbles, drawBubbleBoxes } from "../lib/bubble";

async function main() {
  const image = process.argv[2];
  const model = process.argv[3] || process.env.BUBBLE_MODEL || "ogkalu";
  if (!image || !fs.existsSync(image)) {
    console.log("Pakai: npx tsx scripts/debug-bubbles.ts <gambar> [ogkalu|psimera]");
    process.exit(1);
  }
  const buf = fs.readFileSync(image);
  const { lists, model: used } = await detectBubbles([buf], model);
  const boxes = lists[0] || [];
  console.log(`model=${used} bubble=${boxes.length}`);
  boxes.forEach((b, i) =>
    console.log(
      `  [${i}] x0=${b.x0} y0=${b.y0} x1=${b.x1} y1=${b.y1} w=${b.x1 - b.x0} h=${b.y1 - b.y0} conf=${b.conf.toFixed(2)}`,
    ),
  );

  const out = await drawBubbleBoxes(buf, boxes);

  fs.mkdirSync("outputs", { recursive: true });
  const name = `debug-${used}-${path.parse(image).name}.png`;
  fs.writeFileSync(path.join("outputs", name), out);
  console.log("Tersimpan: outputs/" + name);
}

main().catch((e) => {
  console.error("Gagal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
