import sharp from "sharp";
import { overlayTranslations } from "../lib/overlay";

async function main() {
  const img = await sharp({
    create: { width: 200, height: 120, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
  const r1 = await overlayTranslations(img, []);
  console.log("empty:", ((await sharp(r1).metadata()).width === 200 ? "OK" : "FAIL"));
  const r2 = await overlayTranslations(img, [
    { text: "Halo dunia", bbox: { x0: 10, y0: 10, x1: 190, y1: 110 }, polygon: [{ x: NaN, y: 0 }] },
  ]);
  console.log("bad-poly:", ((await sharp(r2).raw().toBuffer()).length > 0 ? "OK" : "FAIL"));
  const r3 = await overlayTranslations(img, [
    {
      text: "Halo dunia tes",
      bbox: { x0: 10, y0: 10, x1: 190, y1: 110 },
      polygon: [
        { x: 10, y: 10 },
        { x: 190, y: 10 },
        { x: 190, y: 110 },
        { x: 10, y: 110 },
      ],
      kind: "rect",
    },
  ]);
  const raw = await sharp(r3).raw().toBuffer();
  let dark = 0;
  for (const v of raw) if (v < 128) dark++;
  console.log("rect-poly:", dark > 100 ? `OK(dark=${dark})` : `FAIL(dark=${dark})`);
}

main().catch((e) => {
  console.error("FAIL(exc):", e);
  process.exit(1);
});
