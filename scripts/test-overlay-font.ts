// Uji render font & kotak teks: skala mengubah ukuran huruf, bold menambah
// piksel tinta, dan override box memindahkan/mengubah ukuran teks.
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { overlayTranslations, type OverlayItem } from "../lib/overlay";

const W = 420;
const H = 240;
const PAGE = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="#ececec"/>
  <rect x="30" y="30" width="${W - 60}" height="${H - 60}" fill="#ffffff" stroke="#111111" stroke-width="4"/>
</svg>`;

const item: OverlayItem = {
  text: "HALO DUNIA INI CONTOH TEKS PANJANG",
  bbox: { x0: 60, y0: 60, x1: W - 60, y1: H - 60 },
};

async function render(
  font: { family: string; bold: boolean; scale: number },
  textOverrides?: NonNullable<Parameters<typeof overlayTranslations>[2]>["textOverrides"],
) {
  const page = await sharp(Buffer.from(PAGE)).png().toBuffer();
  return overlayTranslations(page, [item], { cleanMode: "none", font, textOverrides });
}

async function darkPixels(buffer: Buffer, box: { x0: number; y0: number; x1: number; y1: number }): Promise<number> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let count = 0;
  for (let y = Math.max(0, box.y0); y < Math.min(H, box.y1); y++) {
    for (let x = Math.max(0, box.x0); x < Math.min(W, box.x1); x++) {
      const i = (y * W + x) * ch;
      if (data[i] + data[i + 1] + data[i + 2] < 240) count++;
    }
  }
  return count;
}

async function main() {
  const small = await render({ family: "Comic Sans MS", bold: true, scale: 70 });
  const large = await render({ family: "Comic Sans MS", bold: true, scale: 130 });
  const normal = await render({ family: "Comic Sans MS", bold: false, scale: 100 });
  const bold = await render({ family: "Comic Sans MS", bold: true, scale: 100 });
  const arial = await render({ family: "Arial", bold: true, scale: 100 });

  const area = { x0: 40, y0: 40, x1: W - 40, y1: H - 40 };
  const smallDark = await darkPixels(small, area);
  const largeDark = await darkPixels(large, area);
  const normalDark = await darkPixels(normal, area);
  const boldDark = await darkPixels(bold, area);
  console.log(`skala 70=${smallDark} skala 130=${largeDark}`);
  console.log(`normal=${normalDark} bold=${boldDark}`);
  const scaleOk = largeDark > smallDark * 1.1;
  const boldOk = boldDark > normalDark;
  const familyDifferent = !small.equals(arial);
  console.log(`family berbeda (Comic vs Arial)=${familyDifferent}`);

  // Override box: teks dipindah ke kotak kecil di kiri atas.
  const movedBox = { index: 0, x: 60, y: 50, w: 120, h: 60 };
  const moved = await render({ family: "Comic Sans MS", bold: true, scale: 100 }, [movedBox]);
  const movedDark = await darkPixels(moved, { x0: movedBox.x, y0: movedBox.y, x1: movedBox.x + movedBox.w, y1: movedBox.y + movedBox.h });
  const centerDark = await darkPixels(moved, { x0: 250, y0: 100, x1: 350, y1: 160 });
  console.log(`override: dalam kotak=${movedDark} area lama=${centerDark}`);
  const overrideOk = movedDark > 0 && centerDark === 0;

  // Teks dihapus: tidak ada teks yang digambar (area tetap bersih).
  const removed = await render({ family: "Comic Sans MS", bold: true, scale: 100 }, [
    { ...movedBox, deleted: true },
  ]);
  const removedDark = await darkPixels(removed, area);
  console.log(`teks dihapus: sisa tinta=${removedDark}`);
  const deleteOk = removedDark === 0;

  // Isi teks diedit: teks pengganti yang digambar, bukan teks asli.
  const edited = await render({ family: "Comic Sans MS", bold: true, scale: 100 }, [
    { ...movedBox, text: "X" },
  ]);
  const editedDark = await darkPixels(edited, {
    x0: movedBox.x,
    y0: movedBox.y,
    x1: movedBox.x + movedBox.w,
    y1: movedBox.y + movedBox.h,
  });
  console.log(`teks diedit: tinta=${editedDark} (asli=${movedDark})`);
  const textEditOk = editedDark > 0 && editedDark < movedDark;

  const dir = path.join(process.cwd(), "outputs");
  fs.mkdirSync(dir, { recursive: true });
  await sharp(bold).toFile(path.join(dir, "debug-font-bold.png"));
  await sharp(moved).toFile(path.join(dir, "debug-font-box.png"));

  const ok = scaleOk && boldOk && overrideOk && deleteOk && textEditOk;
  console.log(
    `scaleOk=${scaleOk} boldOk=${boldOk} overrideOk=${overrideOk} deleteOk=${deleteOk} textEditOk=${textEditOk}`,
  );
  if (!ok) {
    console.log("FAIL");
    process.exit(1);
  }
  console.log("OK: font, skala, bold, kotak teks, edit isi, dan hapus teks bekerja");
}

main().catch((e) => {
  console.error("FAIL(exc):", e);
  process.exit(1);
});
