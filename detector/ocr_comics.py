#!/usr/bin/env python3
"""OCR komik Inggris end-to-end: FCENet (deteksi teks) -> MASTER (rekognisi).

Model: gsoykan/comics_text_plus (paper "COMICS Text+"), dipakai lewat
library pip "comics-ocr" (paket `comics_ocr`, MIT). Cocok untuk huruf
komik barat/manga yang sering gagal dibaca Tesseract.

Dipanggil dari Node (lib/ocrComicsPlus.ts) SEKALI per job dengan banyak
gambar agar load model PyTorch hanya terjadi 1x:

    python detector/ocr_comics.py --images a.png b.png [--conf 0.3]

Output: SATU baris JSON ke stdout, urutan sama dengan input:

    [{"image": "a.png", "boxes": [{"text": "...", "bbox": [x, y, w, h],
      "confidence": 0.xx}]}]

`bbox` = [x, y, w, h] dalam piksel gambar ASLI (x,y = pojok kiri-atas).
Kalau library / checkpoint belum ada, cetak {"error": ...} ke stdout
dan exit != 0 supaya sisi Node bisa fallback ke Tesseract.
"""

import argparse
import contextlib
import io
import json
import os
import sys

# Folder default tempat checkpoint ditaruh (boleh dioverride via CLI/env).
# File-file ini diunduh manual dari Google Drive di repo
# gsoykan/comics_text_plus (lihat hint di bawah):
#   - deteksi  : fcenet_r50dcnv2_fpn_1500e_ctw1500_custom.py + .pth
#   - rekognisi: master_custom_dataset.py + .pth
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL_DIR = os.path.join(BASE_DIR, "models", "comics_text_plus")

# CATATAN Windows: nama file asli di Drive memakai titik-dua, misal
# "best_0_hmean-iou:hmean_epoch_5.pth" — titik-dua ILEGAL di Windows,
# jadi simpan sebagai "best_0_hmean-iou_hmean_epoch_5.pth" (titik-dua
# diganti underscore). Script menerima path apa pun via --det-ckpt.
#
# Config .py WAJIB yang di dalam subfolder configs/ (bukan yang flat di
# folder ini), karena config mmcv memakai referensi relatif _base_
# (../../_base_/...). File flat di folder ini hanya arsip referensi.
DEFAULTS = {
    "det_config": os.path.join(
        "configs", "textdet", "fcenet",
        "fcenet_r50dcnv2_fpn_1500e_ctw1500_custom.py"),
    "det_ckpt": "best_0_hmean-iou_hmean_epoch_5.pth",
    "recog_config": os.path.join(
        "configs", "textrecog", "master", "master_custom_dataset.py"),
    "recog_ckpt": "best_0_1-N.E.D_epoch_4.pth",
}

HINT_DOWNLOAD = (
    "download checkpoint FCENet+MASTER dari "
    "github.com/gsoykan/comics_text_plus (folder Google Drive di README "
    "repo itu), lalu taruh di detector/models/comics_text_plus/ "
    "atau set env COMICS_DET_CKPT / COMICS_RECOG_CKPT. "
    "CATATAN: kalau Drive-nya terkunci, repo ini sudah berisi bobot dasar "
    "publik (*_base-*.pth, bukan fine-tune komik) - arahkan 2 env tadi ke "
    "file tersebut"
)


def parse_args():
    p = argparse.ArgumentParser(description="comics_text_plus OCR (FCENet+MASTER)")
    p.add_argument("--images", nargs="+", required=True, help="path gambar")
    # Threshold confidence 0..1: box dengan text_score di bawah ini dibuang.
    # Bisa juga via env COMICS_CONF. Default 0.3 (longgar, mirip filter
    # MIN_CONFIDENCE di lib/ocr.ts tapi skala 0-1).
    default_conf = float(os.environ.get("COMICS_CONF", "0.3"))
    p.add_argument("--conf", type=float, default=default_conf)
    p.add_argument("--det-config",
                   default=os.environ.get("COMICS_DET_CONFIG", ""),
                   help="path .py config FCENet")
    p.add_argument("--det-ckpt",
                   default=os.environ.get("COMICS_DET_CKPT", ""),
                   help="path .pth checkpoint FCENet")
    p.add_argument("--recog-config",
                   default=os.environ.get("COMICS_RECOG_CONFIG", ""),
                   help="path .py config MASTER")
    p.add_argument("--recog-ckpt",
                   default=os.environ.get("COMICS_RECOG_CKPT", ""),
                   help="path .pth checkpoint MASTER")
    # "cpu" = paksa CPU (CUDA_VISIBLE_DEVICES dikosongkan sebelum torch
    # diimpor). "cuda" = biarkan GPU dipakai kalau ada.
    p.add_argument("--device", choices=["cpu", "cuda"],
                   default=os.environ.get("COMICS_DEVICE", "cpu"))
    return p.parse_args()


def fail(code, **payload):
    # Kontrak dengan Node: SELALU 1 baris JSON ke stdout, walau error.
    print(json.dumps(payload, ensure_ascii=False))
    return code


def resolve_ckpt(args):
    """Lengkapi path checkpoint yang kosong dengan default di models/."""
    out = {}
    for key in ("det_config", "det_ckpt", "recog_config", "recog_ckpt"):
        val = getattr(args, key) or os.path.join(DEFAULT_MODEL_DIR, DEFAULTS[key])
        out[key] = val
    return out


def polygon_to_xywh(poly):
    """FCENet mengembalikan kontur Fourier yang DIPADATKAN (bisa 20-40+
    titik, bukan cuma 8). Ambil min/max dari SEMUA titik agar kotak tidak
    jadi sliver kecil. Hasil [x, y, w, h] (axis-aligned)."""
    xs = [float(poly[i]) for i in range(0, len(poly), 2)]
    ys = [float(poly[i]) for i in range(1, len(poly), 2)]
    x0, y0 = min(xs), min(ys)
    x1, y1 = max(xs), max(ys)
    return [int(round(x0)), int(round(y0)),
            int(round(x1 - x0)), int(round(y1 - y0))]


def main():
    args = parse_args()

    if args.device == "cpu":
        # Harus diset SEBELUM torch diimpor supaya GPU tidak dipakai.
        os.environ["CUDA_VISIBLE_DEVICES"] = ""

    # 1) Cek library dulu (pesan error paling umum: belum pip install).
    try:
        from comics_ocr import ComicsOCR  # noqa: F401  (dipakai di bawah)
        import comics_ocr  # noqa: F401
    except ImportError:
        return fail(3, error="no_comics_ocr",
                    hint="pip install -r detector/requirements.txt "
                         "(paket comics-ocr + torch CPU)")

    # 2) Cek checkpoint (4 file wajib ada).
    ckpt = resolve_ckpt(args)
    missing = [k for k, v in ckpt.items() if not os.path.exists(v)]
    if missing:
        return fail(2, error="model_not_found", missing=missing,
                    paths={k: ckpt[k] for k in missing},
                    hint=HINT_DOWNLOAD)

    # 3) Load model SEKALI untuk semua gambar (berat: FCENet + MASTER).
    #    Semua print/info berisik dari mmocr dialihkan ke "tong sampah"
    #    supaya stdout tetap bersih = cuma 1 baris JSON (kontrak Node).
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            model = comics_ocr.ComicsOCR(
                ocr_detector_config=ckpt["det_config"],
                ocr_detector_checkpoint=ckpt["det_ckpt"],
                recog_config=ckpt["recog_config"],
                ocr_recognition_checkpoint=ckpt["recog_ckpt"],
                det="FCE_CTW_DCNv2",
                recog="MASTER",
            )
        # Objek MMOCR di dalamnya yang bisa memberi DETAIL box per kata/baris.
        # Struktur asli (comics_ocr/comics_ocr.py + text_extractor.py):
        #   ComicsOCR.text_extractor  -> TextExtractor
        #   TextExtractor.ocr         -> MMOCR (punya .readtext(details=True))
        te = getattr(model, "text_extractor", None)
        mmocr = getattr(te, "ocr", None) or getattr(model, "ocr", None)
    except Exception as e:
        return fail(4, error="model_load_failed", detail=str(e)[:500],
                    hint=HINT_DOWNLOAD)

    out = []
    for img_path in args.images:
        boxes = []
        warning = None
        if os.path.exists(img_path):
            try:
                boxes = infer_one(model, mmocr, img_path, args.conf)
            except Exception as e:
                # 1 gambar gagal != job gagal: beri list kosong + catatan.
                warning = str(e)[:200]
        # File tidak ada -> boxes kosong (jangan gagalkan 1 job).
        row = {"image": os.path.basename(img_path), "boxes": boxes}
        if warning:
            row["warning"] = warning
        out.append(row)

    print(json.dumps(out, ensure_ascii=False))
    return 0


def infer_one(model, mmocr, img_path, conf_thr):
    """OCR 1 gambar -> list {text, bbox[x,y,w,h], confidence}."""
    # Jalur utama: info box detail (polygon + text_score) dari MMOCR.
    if mmocr is not None and hasattr(mmocr, "readtext"):
        with contextlib.redirect_stdout(io.StringIO()):
            results = mmocr.readtext(img_path, print_result=False,
                                     imshow=False, details=True,
                                     merge=False, batch_mode=True)
        items = results[0].get("result", []) if results else []
        boxes = []
        for it in items:
            text = str(it.get("text", "") or "").strip()
            # box_score (0..1) = confidence DETEKSI — ini yang dipakai
            # sebagai "confidence" + filter --conf (skala 0..1).
            # text_score milik MASTER skalanya arbitrer (mis. 27.8), jadi
            # hanya disimpan sebagai info debug "recog_score".
            score = float(it.get("box_score", 0) or 0)
            poly = it.get("box") or it.get("bbox") or []
            if not text or score < conf_thr or len(poly) < 6:
                continue
            x, y, w, h = polygon_to_xywh(poly)
            if w < 4 or h < 4:
                continue
            boxes.append({"text": text, "bbox": [x, y, w, h],
                          "confidence": round(score, 4),
                          "recog_score": round(float(it.get("text_score", 0) or 0), 4)})
        # Urutan baca = sama seperti ocrEnglish(): atas->bawah, kanan->kiri.
        boxes.sort(key=lambda b: (b["bbox"][1], -b["bbox"][0]))
        return boxes

    # Jalur cadangan: ComicsOCR hanya mengembalikan teks gabungan
    # (tanpa koordinat). Tetap kembalikan sesuatu yang valid, biar
    # tidak crash — tapi tanpa bbox presisi, jadi TS akan memfilter.
    with contextlib.redirect_stdout(io.StringIO()):
        res = model.extract_text(img_path)
    text = res[0] if isinstance(res, (list, tuple)) else str(res)
    text = str(text or "").strip()
    if not text:
        return []
    return [{"text": text, "bbox": [0, 0, 0, 0], "confidence": 0.0,
             "note": "no_box_detail"}]


if __name__ == "__main__":
    sys.exit(main())
