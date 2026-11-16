// Uji mode "Per baris teks": OCR melacak baris, mask hanya di baris itu.
// Cek: (1) huruf asli tertutup, (2) outline bubble tetap gelap, (3) piksel
// di luar bubble tidak berubah.
import sharp from "sharp";
import { cropBubble } from "../lib/bubble";
import { ocrBubbleCrops } from "../lib/ocr";
import { overlayTranslations } from "../lib/overlay";

const W = 420;
const H = 260;
const BUBBLE = { x0: 30, y0: 25, x1: 390, y1: 205 };
const CX = (BUBBLE.x0 + BUBBLE.x1) / 2;
const CY = (BUBBLE.y0 + BUBBLE.y1) / 2;
const RX = (BUBBLE.x1 - BUBBLE.x0) / 2;
const RY = (BUBBLE.y1 - BUBBLE.y0) / 2;

async function makePage(): Promise<Buffer> {
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#7a8a99"/>
    <ellipse cx="${CX}" cy="${CY}" rx="${RX}" ry="${RY}" fill="#ffffff" stroke="#111111" stroke-width="6"/>
    <text x="${CX}" y="105" font-family="Arial" font-size="30" font-weight="bold" text-anchor="middle" fill="#111111">HELLO THERE</text>
    <text x="${CX}" y="155" font-family="Arial" font-size="30" font-weight="bold" text-anchor="middle" fill="#111111">HOW ARE YOU</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function pixel(raw: Buffer, channels: number, x: number, y: number): [number, number, number] {
  const i = (y * W + x) * channels;
  return [raw[i], raw[i + 1], raw[i + 2]];
}

function isDark([r, g, b]: [number, number, number]): boolean {
  return r + g + b < 240;
}

async function main() {
  const page = await makePage();
  const crop = await cropBubble(page, BUBBLE, W, H);
  if (!crop) throw new Error("crop gagal");
  const ocr = await ocrBubbleCrops([crop.buffer]);
  const result = ocr[0];
  if (!result || !result.lines.length) {
    console.log("FAIL: OCR tidak menemukan baris");
    process.exit(1);
  }
  // Baris dari crop (buffer 2x) -> koordinat halaman.
  const pageLines = result.lines.map((l) => ({
    x0: crop.bbox.x0 + l.bbox.x0 / 2,
    y0: crop.bbox.y0 + l.bbox.y0 / 2,
    x1: crop.bbox.x0 + l.bbox.x1 / 2,
    y1: crop.bbox.y0 + l.bbox.y1 / 2,
  }));
  console.log(`OCR baris=${pageLines.length} teks="${result.text}"`);
  for (const l of pageLines) {
    console.log(`  baris x=${l.x0.toFixed(0)}..${l.x1.toFixed(0)} y=${l.y0.toFixed(0)}..${l.y1.toFixed(0)}`);
  }

  // Bersihkan saja dulu (tanpa teks baru) agar hitungan tidak tercemar
  // huruf terjemahan yang juga gelap.
  const cleanedOnly = await overlayTranslations(page, [], {
    cleanMode: "text",
    cleanAreas: pageLines.map((bbox) => ({ bbox, fallbackShape: "line" as const })),
  });
  const afterClean = await sharp(cleanedOnly).raw().toBuffer({ resolveWithObject: true });
  const before = await sharp(page).raw().toBuffer({ resolveWithObject: true });
  const ch = before.info.channels;

  // 1) Di area tiap baris: huruf asli harus tertutup.
  let textCovered = true;
  for (const l of pageLines) {
    let lineBefore = 0;
    let lineAfter = 0;
    for (let y = Math.floor(l.y0); y < Math.ceil(l.y1); y++) {
      for (let x = Math.floor(l.x0); x < Math.ceil(l.x1); x++) {
        if (before.data[(y * W + x) * ch] < 90) lineBefore++;
        if (afterClean.data[(y * W + x) * ch] < 90) lineAfter++;
      }
    }
    console.log(`  baris y=${l.y0.toFixed(0)}: gelap ${lineBefore} -> ${lineAfter}`);
    if (lineAfter > lineBefore * 0.05) textCovered = false;
  }
  if (!textCovered) console.log("FAIL: masih ada huruf asli di area baris");

  // Teks terjemahan ditaruh di tengah bubble (item), mask per baris asli.
  const out = await overlayTranslations(
    page,
    [{ text: "HALO SEMUA", bbox: BUBBLE }],
    {
      cleanMode: "text",
      cleanAreas: pageLines.map((bbox) => ({ bbox, fallbackShape: "line" as const })),
    },
  );
  const after = await sharp(out).raw().toBuffer({ resolveWithObject: true });

  // 2) Tanpa deteksi bubble (full-page/comics): items sendiri jadi mask
  //    "line" dan harus tight juga.
  const fallback = await overlayTranslations(
    page,
    pageLines.map((bbox) => ({ text: "", bbox, fallbackShape: "line" as const })),
    { cleanMode: "text" },
  );
  const afterFallback = await sharp(fallback).raw().toBuffer({ resolveWithObject: true });
  let fallbackLeft = 0;
  for (const l of pageLines) {
    for (let y = Math.floor(l.y0); y < Math.ceil(l.y1); y++) {
      for (let x = Math.floor(l.x0); x < Math.ceil(l.x1); x++) {
        if (afterFallback.data[(y * W + x) * ch] < 90) fallbackLeft++;
      }
    }
  }
  console.log(`fallback full-page sisa gelap=${fallbackLeft}`);
  if (fallbackLeft > 50) {
    textCovered = false;
    console.log("FAIL: mask item full-page tidak menutup huruf");
  }

  // 3) Outline kiri-tengah bubble harus tetap gelap.
  const edge = pixel(after.data, ch, BUBBLE.x0 + 2, Math.round(CY));
  console.log(`outline kiri rgb=${edge.join(",")}`);
  const outlineKept = isDark(edge);

  // 4) Mask "manual" mengisi PERSIS kotak user (tanpa inset/expand).
  const manualRect = { x0: 26, y0: 110, x1: 42, y1: 132 };
  const manualOut = await overlayTranslations(page, [], {
    cleanMode: "text",
    cleanAreas: [{ bbox: manualRect, fallbackShape: "manual" }],
  });
  const manualRaw = await sharp(manualOut).raw().toBuffer({ resolveWithObject: true });
  const insideAfter = pixel(manualRaw.data, ch, 34, 121);
  const outsidePoint = pixel(manualRaw.data, ch, 20, 121);
  const outsidePointBefore = pixel(before.data, ch, 20, 121);
  const manualOk =
    !isDark(insideAfter) &&
    outsidePoint.every((v, i) => v === outsidePointBefore[i]);
  console.log(`manual inside=${insideAfter.join(",")} luar-sama=${manualOk}`);
  if (!manualOk) {
    textCovered = false;
    console.log("FAIL: mask manual tidak presisi");
  }

  // 3) Piksel di luar bubble (pojok) tidak berubah.
  const outsideBefore = pixel(before.data, ch, 5, 5);
  const outsideAfter = pixel(after.data, ch, 5, 5);
  const outsideSame = outsideBefore.every((v, i) => v === outsideAfter[i]);
  console.log(`luar bubble sama=${outsideSame}`);

  // 5) Mask baris yang melewati tepi bubble harus DIPOTONG ke kontur:
  //    piksel di luar bubble tidak boleh berubah.
  const clipPolygon = Array.from({ length: 72 }, (_, i) => {
    const a = (i / 72) * Math.PI * 2;
    return { x: CX + Math.cos(a) * RX, y: CY + Math.sin(a) * RY };
  });
  const wideLine = { x0: 10, y0: 130, x1: 350, y1: 160 };
  const clipped = await overlayTranslations(page, [], {
    cleanMode: "text",
    cleanAreas: [{ bbox: wideLine, fallbackShape: "line", clipPolygon }],
  });
  const clippedRaw = await sharp(clipped).raw().toBuffer({ resolveWithObject: true });
  const outsideClipAfter = pixel(clippedRaw.data, ch, 20, 145);
  const outsideClipBefore = pixel(before.data, ch, 20, 145);
  const insideClipAfter = pixel(clippedRaw.data, ch, 210, 145);
  const clipOk =
    outsideClipAfter.every((v, i) => v === outsideClipBefore[i]) &&
    !isDark(insideClipAfter);
  console.log(`clip luar-sama=${clipOk} dalam=${insideClipAfter.join(",")}`);
  if (!clipOk) {
    textCovered = false;
    console.log("FAIL: mask baris bocor keluar kontur bubble");
  }

  // Simpan untuk inspeksi mata.
  await sharp(out).toFile("outputs/debug-line-mask.png");
  console.log(`textCovered=${textCovered} outlineKept=${outlineKept} outsideSame=${outsideSame}`);
  if (!textCovered || !outlineKept || !outsideSame) {
    console.log("FAIL");
    process.exit(1);
  }
  console.log("OK: mode per baris rapi (outline utuh, luar bubble aman)");
}

main().catch((e) => {
  console.error("FAIL(exc):", e);
  process.exit(1);
});
