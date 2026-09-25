#!/usr/bin/env python3
"""Ekstraksi bentuk bubble dari crop bounding box YOLO.

Dipanggil dari Node (lib/bubbleShape.ts) SEKALI per halaman dengan banyak
crop agar import cv2 hanya terjadi 1x:

    python detector/bubble_shape.py --images crop0.png crop1.png [--epsilon 0.01]

Output: SATU baris JSON ke stdout, urutan sama dengan input:

    [{"image": "crop0.png", "polygon": [[x, y], ...],
      "bbox": {"x0":..,"y0":..,"x1":..,"y1":..},
      "shape": "contour", "kind": "ellipse", "conf": 0.9, "area_ratio": 0.6}]

Koordinat polygon = piksel LOKAL crop (0,0 = pojok kiri-atas crop).
Sisi Node yang menggeser ke koordinat halaman (+left/+top).

Kontrak fallback (JANGAN exit != 0 untuk crop yang gagal):
  - crop yang tidak terbaca / kontur tidak valid -> baris dengan
    "shape": "ellipse_fallback", "polygon": [], bbox = seluruh crop,
    "conf": 0.0. Sisi Node lalu memakai elips seperti dulu.
  - Hanya keluar != 0 kalau argumen / IO fatal (pattern sama dengan
    detector/detect.py: cetak {"error": ...} supaya Node bisa log hint).

Pendekatan: bubble biasanya area terang (putih) dengan outline gelap.
  gray -> blur -> Otsu threshold -> morph close (menutup teks di dalam
  bubble) -> findContours EXTERNAL -> kontur terbesar -> approxPolyDP.
Kalau kontur terbesar = background (menyentuh semua sisi + area > 90%),
coba binary terbalik sekali (untuk bubble gelap/berwarna). Kalau masih
gagal -> ellipse_fallback.

Dependensi: opencv-python + numpy (sudah ikut via ultralytics, lihat
detector/requirements.txt). TIDAK butuh torch — ringan & cepat.
"""

import argparse
import json
import math
import os
import sys

# Batas titik polygon agar SVG tetap kecil (approxPolyDP biasanya sudah
# di bawah ini; kalau lebih, sub-sampling merata).
MAX_POINTS = 96


def parse_args():
    p = argparse.ArgumentParser(description="bubble contour -> polygon")
    p.add_argument("--images", nargs="+", required=True, help="path crop bubble")
    p.add_argument(
        "--epsilon",
        type=float,
        default=float(os.environ.get("BUBBLE_SHAPE_EPSILON", "0.01")),
        help="faktor approxPolyDP (fraksi perimeter)",
    )
    p.add_argument(
        "--min-area-ratio",
        type=float,
        default=float(os.environ.get("BUBBLE_SHAPE_MIN_AREA", "0.15")),
        help="luas kontur minimum (fraksi luas crop)",
    )
    return p.parse_args()


def fail(code, **payload):
    print(json.dumps(payload))
    return code


def empty_row(basename, w, h, reason="fallback"):
    return {
        "image": basename,
        "polygon": [],
        "bbox": {"x0": 0, "y0": 0, "x1": int(w), "y1": int(h)},
        "shape": "ellipse_fallback",
        "kind": "unknown",
        "conf": 0.0,
        "area_ratio": 0.0,
        "note": reason,
    }


def classify(contour_area, peri, approx, bbox_w, bbox_h):
    """Kasarkan bentuk jadi rect / ellipse / freeform (awan/kotak)."""
    n = len(approx)
    bbox_area = max(bbox_w * bbox_h, 1)
    rectangularity = contour_area / bbox_area
    circularity = (
        4.0 * math.pi * contour_area / (peri * peri) if peri > 0 else 0.0
    )
    if n == 4 and rectangularity > 0.85:
        return "rect"
    if circularity > 0.72 and n >= 6:
        return "ellipse"
    return "freeform"


def extract_one(cv2, np, img_path, epsilon, min_area_ratio):
    import numpy as _np  # noqa: F401 (alias konsisten)

    basename = os.path.basename(img_path)
    img = cv2.imread(img_path, cv2.IMREAD_COLOR)
    if img is None:
        return empty_row(basename, 0, 0, "unreadable")
    h, w = img.shape[:2]
    if w < 8 or h < 8:
        return empty_row(basename, w, h, "too_small")

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    _, binary = cv2.threshold(
        blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )

    # Tutup teks/garis tipis di dalam bubble supaya interior jadi solid.
    # Kernel ~2% dari sisi terkecil (min 7, max 21) — cukup menutup huruf
    # tanpa menghilangkan lekuk awan pikiran. Untuk awan pikiran, outline
    # hitam yang saling memotong bisa memecah interior jadi sel-sel kecil;
    # coba kernel progresif (kecil dulu agar oval/kotak tetap presisi,
    # membesar hanya bila kontur terpecah) sampai dapat kandidat valid.
    def largest(binary_img):
        cnts = cv2.findContours(
            binary_img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        # API 4.x -> (contours, hierarchy); 3.x -> (img, contours, hier).
        contours = cnts[0] if len(cnts) == 2 else cnts[1]
        if not contours:
            return None, 0.0
        top = max(contours, key=cv2.contourArea)
        return top, float(cv2.contourArea(top))

    k0 = int(min(w, h) * 0.02)
    base_k = max(7, min(21, k0 | 1))  # ganjil
    kernels = sorted({base_k, min(31, base_k * 2 + 1), min(41, base_k * 3 + 1)})
    crop_area = float(w * h)
    best = None
    area = 0.0
    closed = binary
    for k in kernels:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
        cand, cand_area = largest(closed)
        if cand is None:
            continue
        if cand_area / crop_area >= min_area_ratio:
            best, area = cand, cand_area
            break
        # Simpan kandidat terbesar bila semua skala gagal (untuk pesan note).
        if cand_area > area:
            best, area = cand, cand_area

    # Bubble gelap/berwarna: interior gelap -> binary terbalik bisa lebih benar.
    # Coba sekali kalau kandidat pertama terlihat seperti background.
    if best is not None:
        x, y, bw, bh = cv2.boundingRect(best)
        touches_all = x <= 1 and y <= 1 and (x + bw) >= w - 1 and (y + bh) >= h - 1
        if touches_all and area / crop_area > 0.90:
            inv = cv2.bitwise_not(closed)
            alt, alt_area = largest(inv)
            if alt is not None and alt_area / crop_area >= min_area_ratio:
                best, area = alt, alt_area
            else:
                return empty_row(basename, w, h, "background_only")

    if best is None or area / crop_area < min_area_ratio:
        return empty_row(basename, w, h, "area_too_small")

    peri = float(cv2.arcLength(best, True))
    if peri <= 0:
        return empty_row(basename, w, h, "degenerate")

    approx = cv2.approxPolyDP(best, epsilon * peri, True).reshape(-1, 2)
    if len(approx) < 3:
        return empty_row(basename, w, h, "too_few_points")

    # Sub-sampling merata kalau titik terlalu banyak (SVG tetap ringan).
    if len(approx) > MAX_POINTS:
        idx = _np.linspace(0, len(approx) - 1, MAX_POINTS).astype(int)
        approx = approx[idx]

    xs = approx[:, 0].astype(float)
    ys = approx[:, 1].astype(float)
    x0, y0 = float(xs.min()), float(ys.min())
    x1, y1 = float(xs.max()), float(ys.max())
    bw, bh = x1 - x0, y1 - y0
    if bw < 8 or bh < 8:
        return empty_row(basename, w, h, "bbox_too_small")

    hull = cv2.convexHull(best)
    hull_area = float(cv2.contourArea(hull)) or 1.0
    solidity = min(1.0, area / hull_area)
    # Solidity rendah = bentuk aneh/terpotong -> tidak dipercaya.
    if solidity < 0.5:
        row = empty_row(basename, w, h, "low_solidity")
        row["area_ratio"] = round(area / crop_area, 4)
        return row

    kind = classify(area, peri, approx, bw, bh)
    polygon = [[round(float(px), 1), round(float(py), 1)] for px, py in approx]
    return {
        "image": basename,
        "polygon": polygon,
        "bbox": {
            "x0": int(round(x0)),
            "y0": int(round(y0)),
            "x1": int(round(x1)),
            "y1": int(round(y1)),
        },
        "shape": "contour",
        "kind": kind,
        "conf": round(solidity, 4),
        "area_ratio": round(area / crop_area, 4),
    }


def main():
    args = parse_args()
    try:
        import cv2
        import numpy as np
    except ImportError:
        return fail(
            3,
            error="no_opencv",
            hint="pip install -r detector/requirements.txt (opencv-python)",
        )

    out = []
    for img_path in args.images:
        try:
            out.append(extract_one(cv2, np, img_path, args.epsilon, args.min_area_ratio))
        except Exception as e:  # 1 crop gagal != job gagal
            base = os.path.basename(img_path)
            row = empty_row(base, 0, 0, "exception")
            row["note"] = str(e)[:200]
            out.append(row)

    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
