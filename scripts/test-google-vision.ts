// Uji parser Google Vision tanpa network (offline, tanpa spend kuota).
// Pakai:  npx tsx scripts/test-google-vision.ts
// Menguji: visionCropText, visionBoxesFromResponse (vertices +
// normalizedVertices + filter confidence), dan requireKey kosong -> throw.
import {
  visionBoxesFromResponse,
  visionCropText,
  ocrGoogleBubbleCrops,
  visionBlocksFromResponse,
  mergeVisionBlocks,
  findRegionForBox,
} from "../lib/ocrGoogleVision";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++;
    console.log(`OK   ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

async function main() {
  // 1) Teks crop dari fullTextAnnotation.
  check(
    "crop-text",
    visionCropText({ fullTextAnnotation: { text: "HELLO\nWORLD\n" } }) === "HELLO WORLD",
  );
  // 2) Cadangan textAnnotations[0] bila fullTextAnnotation kosong.
  check(
    "crop-text-fallback",
    visionCropText({ textAnnotations: [{ description: "Hi  there" }] }) === "Hi there",
  );
  // 3) Kosong -> "" (pemanggil mengubah jadi null, bukan error).
  check("crop-empty", visionCropText({}) === "");

  // 4) Box full-page dari vertices piksel + filter confidence.
  const boxes = visionBoxesFromResponse(
    {
      fullTextAnnotation: {
        pages: [
          {
            blocks: [
              {
                confidence: 0.9,
                paragraphs: [
                  {
                    confidence: 0.95,
                    boundingBox: { vertices: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 60 }, { x: 10, y: 60 }] },
                    words: [
                      { symbols: [{ text: "H" }, { text: "i" }] },
                      { symbols: [{ text: "!" }] },
                    ],
                  },
                  {
                    // confidence rendah -> dibuang
                    confidence: 0.2,
                    boundingBox: { vertices: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 20 }, { x: 0, y: 20 }] },
                    words: [{ symbols: [{ text: "x" }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    200,
    100,
  );
  check("boxes-count", boxes.length === 1, JSON.stringify(boxes));
  check("boxes-text", boxes[0]?.text === "Hi !");
  check(
    "boxes-bbox",
    boxes[0]?.bbox.x0 === 10 && boxes[0]?.bbox.y0 === 20 && boxes[0]?.bbox.x1 === 110 && boxes[0]?.bbox.y1 === 60,
    JSON.stringify(boxes[0]?.bbox),
  );
  check("boxes-conf", boxes[0]?.conf === 95, String(boxes[0]?.conf));

  // 5) normalizedVertices (0..1) dikali W/H.
  const norm = visionBoxesFromResponse(
    {
      fullTextAnnotation: {
        pages: [
          {
            blocks: [
              {
                paragraphs: [
                  {
                    confidence: 0.8,
                    boundingBox: {
                      normalizedVertices: [{ x: 0.1, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.6, y: 0.5 }, { x: 0.1, y: 0.5 }],
                    },
                    words: [{ symbols: [{ text: "A" }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    200,
    100,
  );
  check(
    "boxes-normalized",
    norm.length === 1 && norm[0].bbox.x0 === 20 && norm[0].bbox.y0 === 20 && norm[0].bbox.x1 === 120 && norm[0].bbox.y1 === 50,
    JSON.stringify(norm[0]?.bbox),
  );

  // 6) Key kosong -> throw (kontrak no-fallback), TANPA network call.
  const saved = process.env.GOOGLE_VISION_API_KEY;
  delete process.env.GOOGLE_VISION_API_KEY;
  try {
    await ocrGoogleBubbleCrops([Buffer.from("x")], undefined, "");
    check("empty-key-throws", false, "tidak throw");
  } catch (e) {
    check(
      "empty-key-throws",
      /GOOGLE_VISION_API_KEY/.test(e instanceof Error ? e.message : String(e)),
      String(e),
    );
  } finally {
    if (saved !== undefined) process.env.GOOGLE_VISION_API_KEY = saved;
  }

  // 7) Region blok: merge + margin + pemetaan (offline).
  testMerge();

  console.log(`\n${pass} OK, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

function vbox(x0: number, y0: number, x1: number, y1: number) {
  return {
    boundingBox: {
      vertices: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
    },
  };
}

function testMerge() {
  // Blok berdekatan (gap 10 <= 24) menyatu; yang jauh tetap sendiri.
  const resp = {
    fullTextAnnotation: {
      pages: [
        {
          blocks: [
            { confidence: 0.9, ...vbox(10, 10, 100, 50) },
            { confidence: 0.9, ...vbox(10, 60, 100, 100) }, // gap 10 -> gabung
            { confidence: 0.9, ...vbox(300, 300, 400, 350) }, // jauh -> sendiri
          ],
        },
      ],
    },
  };
  const W = 500;
  const H = 500;
  const blocks = visionBlocksFromResponse(resp, W, H);
  check("blocks-count", blocks.length === 3, JSON.stringify(blocks.length));
  const regions = mergeVisionBlocks(blocks, W, H);
  check("merge-count", regions.length === 2, JSON.stringify(regions));
  // Region gabungan = union + margin 12, clamp. (Diurut besar-dulu.)
  const big = regions[0];
  check(
    "merge-union",
    big.x0 === 0 && big.y0 === 0 && big.x1 === 112 && big.y1 === 112,
    JSON.stringify(big),
  );
  const small = regions[1];
  check(
    "merge-margin",
    small.x0 === 288 && small.y0 === 288 && small.x1 === 412 && small.y1 === 362,
    JSON.stringify(small),
  );
  // Gap > ambang tidak digabung (gap eksplisit 5).
  const split = mergeVisionBlocks(blocks.slice(0, 2), W, H, 5);
  check("merge-gap", split.length === 2, JSON.stringify(split.length));

  // Pemetaan paragraf -> region: titik tengah di dalam.
  check("map-inside", findRegionForBox({ x0: 20, y0: 20, x1: 40, y1: 40 }, regions) === 0, "");
  check("map-outside", findRegionForBox({ x0: 200, y0: 200, x1: 250, y1: 250 }, regions) === -1, "");
  // Kosong -> [] (bukan throw).
  check("merge-empty", mergeVisionBlocks([], W, H).length === 0, "");
}

main().catch((e) => {
  console.error("FAIL(exc):", e);
  process.exit(1);
});
