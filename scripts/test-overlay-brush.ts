// Uji koreksi brush manual: urutan paint → erase → paint harus sama dengan
// kanvas editor, warna isi mengikuti warna kertas, dan area di luar goresan
// tidak boleh berubah.
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { applyAutoMaskEdits, overlayTranslations, type BrushStroke } from "../lib/overlay";

const W = 400;
const H = 200;
const BUBBLE = { x0: 40, y0: 40, x1: 360, y1: 160 };
const TEXT = { x0: 120, y0: 80, x1: 280, y1: 120 };

interface RawImage {
  data: Buffer;
  channels: number;
}

async function makePage(): Promise<Buffer> {
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#7a8a99"/>
    <rect x="${BUBBLE.x0}" y="${BUBBLE.y0}" width="${BUBBLE.x1 - BUBBLE.x0}" height="${BUBBLE.y1 - BUBBLE.y0}" fill="#ffffff" stroke="#111111" stroke-width="4"/>
    <rect x="${TEXT.x0}" y="${TEXT.y0}" width="${TEXT.x1 - TEXT.x0}" height="${TEXT.y1 - TEXT.y0}" fill="#111111"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function readImage(buffer: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  return { data, channels: info.channels };
}

function pixel(image: RawImage, x: number, y: number): [number, number, number] {
  const i = (y * W + x) * image.channels;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

function isDark([r, g, b]: [number, number, number]): boolean {
  return r + g + b < 240;
}

function isPaper([r, g, b]: [number, number, number]): boolean {
  return r > 235 && g > 235 && b > 235;
}

async function main() {
  const page = await makePage();
  const before = await readImage(page);

  const paint: BrushStroke = {
    mode: "paint",
    size: 50,
    points: [
      [70, 100],
      [330, 100],
    ],
  };
  const erase: BrushStroke = {
    mode: "erase",
    size: 50,
    points: [
      [180, 100],
      [220, 100],
    ],
  };
  const repaint: BrushStroke = {
    mode: "paint",
    size: 50,
    points: [
      [180, 100],
      [220, 100],
    ],
  };

  const afterPaint = await readImage(
    await overlayTranslations(page, [], { cleanMode: "text", manualStrokes: [paint] }),
  );

  let darkLeft = 0;
  for (let y = TEXT.y0; y < TEXT.y1; y++) {
    for (let x = 70; x < 330; x++) {
      if (isDark(pixel(afterPaint, x, y))) darkLeft++;
    }
  }
  const painted = pixel(afterPaint, 200, 100);
  console.log(`paint: sisa gelap=${darkLeft} warna=${painted.join(",")}`);
  const paintOk = darkLeft === 0 && isPaper(painted);

  const afterErase = await readImage(
    await overlayTranslations(page, [], { cleanMode: "text", manualStrokes: [paint, erase] }),
  );
  const hole = pixel(afterErase, 200, 100);
  const kept = pixel(afterErase, 100, 100);
  console.log(`erase: lubang=${hole.join(",")} sisa-paint=${kept.join(",")}`);
  const eraseOk = isDark(hole) && isPaper(kept);

  const afterRepaint = await readImage(
    await overlayTranslations(page, [], {
      cleanMode: "text",
      manualStrokes: [paint, erase, repaint],
    }),
  );
  const again = pixel(afterRepaint, 200, 100);
  console.log(`repaint: warna=${again.join(",")}`);
  const repaintOk = isPaper(again);

  const outside = pixel(afterRepaint, 5, 5);
  const outsideBefore = pixel(before, 5, 5);
  const outsideOk = outside.every((v, i) => v === outsideBefore[i]);
  console.log(`luar goresan sama=${outsideOk}`);

  // Mode putih: brush juga harus putih walau kertas berwarna.
  const whiteMode = await readImage(
    await overlayTranslations(page, [], {
      cleanMode: "white",
      manualStrokes: [{ mode: "paint", size: 30, points: [[70, 145], [330, 145]] }],
    }),
  );
  const whitePixel = pixel(whiteMode, 200, 145);
  const whiteOk = whitePixel.every((v) => v >= 250);
  console.log(`mode putih: warna=${whitePixel.join(",")}`);

  // Mask otomatis yang DIHAPUS: area tidak dibersihkan lagi, dan overlay
  // tidak boleh jatuh ke perilaku "tiap kotak teks ditimpa".
  const autoArea = {
    bbox: { x0: TEXT.x0, y0: TEXT.y0, x1: TEXT.x1, y1: TEXT.y1 },
    fallbackShape: "manual" as const,
  };
  const autoItem = {
    text: "",
    bbox: { x0: TEXT.x0, y0: TEXT.y0, x1: TEXT.x1, y1: TEXT.y1 },
  };
  const deletedMask = await readImage(
    await overlayTranslations(page, [autoItem], {
      cleanMode: "text",
      cleanAreas: applyAutoMaskEdits([autoArea], [{ index: 0, deleted: true }]),
    }),
  );
  const deletedPixel = pixel(deletedMask, 200, 100);
  const deletedOk = isDark(deletedPixel);
  console.log(`mask dihapus: teks asli tetap=${deletedPixel.join(",")}`);

  // Mask otomatis yang DIGESER/DIUBAH UKURAN: hanya kotak baru yang ditimpa.
  const movedBox = { x0: 60, y0: 60, x1: 110, y1: 90 };
  const movedMask = await readImage(
    await overlayTranslations(page, [], {
      cleanMode: "text",
      cleanAreas: applyAutoMaskEdits([autoArea], [{ index: 0, bbox: movedBox }]),
    }),
  );
  const movedOld = pixel(movedMask, 200, 100);
  const movedNew = pixel(movedMask, 85, 75);
  const movedOk = isDark(movedOld) && isPaper(movedNew);
  console.log(`mask dipindah: lama=${movedOld.join(",")} baru=${movedNew.join(",")}`);

  const dir = path.join(process.cwd(), "outputs");
  fs.mkdirSync(dir, { recursive: true });
  await sharp(
    await overlayTranslations(page, [], {
      cleanMode: "text",
      manualStrokes: [paint, erase, repaint],
    }),
  ).toFile(path.join(dir, "debug-brush-mask.png"));

  const ok = paintOk && eraseOk && repaintOk && outsideOk && whiteOk && deletedOk && movedOk;
  console.log(
    `paintOk=${paintOk} eraseOk=${eraseOk} repaintOk=${repaintOk} outsideOk=${outsideOk} whiteOk=${whiteOk} deletedOk=${deletedOk} movedOk=${movedOk}`,
  );
  if (!ok) {
    console.log("FAIL");
    process.exit(1);
  }
  console.log("OK: brush + eraser mengikuti urutan goresan, edit mask otomatis presisi");
}

main().catch((e) => {
  console.error("FAIL(exc):", e);
  process.exit(1);
});
