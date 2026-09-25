// Debug visual + kalibrasi bentuk bubble: YOLO -> kontur OpenCV -> overlay.
// Pakai:  npx tsx scripts/debug-shapes.ts <gambar> [ogkalu|psimera]
// Hasil:  outputs/debug-shape-<nama>.png + tabel metrik per bubble di
//         console (kind, solidity, defects, max depth, pts) untuk kalibrasi
//         ambang solidity. Tidak menyentuh OCR/translate asli.
//
// CATATAN: script ini memanggil detector/bubble_shape.py LANGSUNG via
// execFile (bukan lewat lib/bubbleShape.ts) supaya field mentah
// solidity/defects/max_defect_px dari JSON bisa ditampilkan. Crop yang
// ditulis = extract mentah + pad 8px, sama persis seperti lib/bubbleShape.ts.
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import sharp from "sharp";
import { detectBubbles } from "../lib/bubble";
import { overlayTranslations } from "../lib/overlay";

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(process.cwd(), "detector", "bubble_shape.py");

interface RawRow {
  polygon?: unknown;
  shape?: unknown;
  kind?: unknown;
  conf?: unknown;
  solidity?: unknown;
  defects?: unknown;
  max_defect_px?: unknown;
  note?: unknown;
}

function pythonCandidates(): string[] {
  const explicit = (process.env.BUBBLE_SHAPE_PYTHON || process.env.BUBBLE_PYTHON || "").trim();
  if (explicit) return [explicit];
  return process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
}

function extractJson(stdout: string): unknown {
  const text = String(stdout || "").trim();
  const start = Math.min(
    ...["[", "{"].map((c) => {
      const i = text.indexOf(c);
      return i < 0 ? Infinity : i;
    }),
  );
  if (!isFinite(start)) throw new Error("empty stdout");
  return JSON.parse(text.slice(start));
}

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

  // Tulis crop mentah + pad 8 (sama seperti lib/bubbleShape.ts), panggil
  // sidecar sekali, geser polygon lokal -> halaman.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-shapes-"));
  const items: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; polygon?: Array<{ x: number; y: number }>; kind?: string }> = [];
  try {
    const pad = 8;
    const files: string[] = [];
    const origins: Array<{ left: number; top: number }> = [];
    for (let i = 0; i < regions.length; i++) {
      const b = regions[i];
      const left = Math.max(0, Math.floor(b.x0 - pad));
      const top = Math.max(0, Math.floor(b.y0 - pad));
      const w = Math.min(W - left, Math.ceil(b.x1 + pad) - left);
      const h = Math.min(H - top, Math.ceil(b.y1 + pad) - top);
      if (w < 16 || h < 16) {
        files.push("");
        origins.push({ left, top });
        continue;
      }
      const f = path.join(dir, `s${i}.png`);
      fs.writeFileSync(
        f,
        await sharp(normalized).extract({ left, top, width: w, height: h }).png().toBuffer(),
      );
      files.push(f);
      origins.push({ left, top });
    }
    const validIdx = files.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
    let rows: RawRow[] = validIdx.map(() => ({}));
    if (validIdx.length) {
      let lastErr: unknown = null;
      let parsed: unknown = null;
      for (const bin of pythonCandidates()) {
        try {
          const { stdout } = await execFileAsync(
            bin,
            [SCRIPT, "--images", ...validIdx.map((i) => files[i])],
            { timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
          );
          parsed = extractJson(stdout);
          break;
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
            lastErr = e;
            continue;
          }
          throw e;
        }
      }
      if (!parsed) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      if (!Array.isArray(parsed)) throw new Error("output python bukan array");
      rows = parsed as RawRow[];
    }

    let contourOk = 0;
    const sols: number[] = [];
    rows.forEach((row, k) => {
      const i = validIdx[k];
      const b = regions[i];
      const poly =
        row.shape === "contour" && Array.isArray(row.polygon)
          ? (row.polygon as number[][])
              .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
              .map((p) => ({
                x: Math.max(0, Math.min(W, origins[i].left + p[0])),
                y: Math.max(0, Math.min(H, origins[i].top + p[1])),
              }))
          : undefined;
      if (poly && poly.length >= 3) {
        contourOk++;
        if (Number.isFinite(Number(row.solidity))) sols.push(Number(row.solidity));
        console.log(
          `  [${i}] contour kind=${String(row.kind)} solidity=${row.solidity ?? "-"} ` +
            `defects=${row.defects ?? "-"} maxd=${row.max_defect_px ?? "-"}px ` +
            `pts=${poly.length} conf=${row.conf ?? "-"}`,
        );
        items[i] = {
          text: "Ini contoh terjemahan Indonesia untuk uji bentuk bubble",
          bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 },
          polygon: poly,
          kind: typeof row.kind === "string" ? row.kind : undefined,
        };
      } else {
        console.log(`  [${i}] ellipse_fallback note=${String(row.note ?? "-")}`);
        items[i] = {
          text: "Ini contoh terjemahan Indonesia untuk uji bentuk bubble",
          bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 },
        };
      }
    });
    // Region terlalu kecil untuk crop (tidak dikirim ke python).
    for (let i = 0; i < regions.length; i++) {
      if (!items[i]) {
        const b = regions[i];
        items[i] = {
          text: "Ini contoh terjemahan Indonesia untuk uji bentuk bubble",
          bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 },
        };
        console.log(`  [${i}] ellipse_fallback note=crop_too_small`);
      }
    }
    console.log(
      `model=${used} region=${regions.length} contour=${contourOk} fallback=${regions.length - contourOk}` +
        (sols.length ? ` solidity_min=${Math.min(...sols).toFixed(4)} solidity_max=${Math.max(...sols).toFixed(4)}` : ""),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

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
