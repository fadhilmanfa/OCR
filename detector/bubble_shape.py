#!/usr/bin/env python3
"""Ekstraksi bentuk bubble dari crop bounding box YOLO.

Dipanggil dari Node (lib/bubbleShape.ts) SEKALI per halaman dengan banyak
crop agar import cv2 hanya terjadi 1x:

    python detector/bubble_shape.py --images crop0.png crop1.png [--epsilon 0.01]

Output: SATU baris JSON ke stdout, urutan sama dengan input:

    [{"image": "crop0.png", "polygon": [[x, y], ...],
      "bbox": {"x0":..,"y0":..,"x1":..,"y1":..},
      "shape": "contour", "kind": "ellipse", "conf": 0.9, "area_ratio": 0.6,
      "solidity": 0.97, "defects": 0, "max_defect_px": 0.0}]

"solidity" = contourArea / convexHullArea dari kontur ASLI (sebelum
approxPolyDP) — stabil terhadap parameter epsilon. "defects" = jumlah
convexity defect signifikan (depth > DEFECT_FRAC * diagonal bbox,
scale-invariant), "max_defect_px" = depth terbesar dalam piksel.
Keduanya untuk kalibrasi threshold di scripts/debug-shapes.ts.

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

# Ambang klasifikasi bentuk (bisa dioverride via CLI/env untuk kalibrasi):
#  - solidity > SOLIDITY_SMOOTH -> halus (ellipse/rect, dibedakan lagi
#    via rectangularity di bawah),
#  - solidity < SOLIDITY_FREE -> bergerigi (freeform),
#  - di antaranya (zona abu-abu) -> convexity defects jadi penentu.
SOLIDITY_SMOOTH = 0.92
SOLIDITY_FREE = 0.85
# Defect signifikan = depth > DEFECT_FRAC * diagonal bbox (scale-invariant).
# OpenCV menyimpan depth dalam fixed-point (*256), jadi threshold
# dikali 256 saat dibandingkan dengan nilai mentah.
DEFECT_FRAC = 0.02
DEFECT_MIN_COUNT = 3


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
    # Knob kalibrasi klasifikasi (default = konstanta di atas).
    p.add_argument(
        "--solidity",
        type=float,
        default=float(os.environ.get("BUBBLE_SHAPE_SOLIDITY", str(SOLIDITY_SMOOTH))),
        help="ambang solidity untuk bentuk halus",
    )
    p.add_argument(
        "--solidity-free",
        type=float,
        default=float(os.environ.get("BUBBLE_SHAPE_SOLIDITY_FREE", str(SOLIDITY_FREE))),
        help="ambang solidity bawah untuk freeform",
    )
    p.add_argument(
        "--defect-frac",
        type=float,
        default=float(os.environ.get("BUBBLE_SHAPE_DEFECT_FRAC", str(DEFECT_FRAC))),
        help="fraksi diagonal bbox untuk depth defect signifikan",
    )
    p.add_argument(
        "--defect-min",
        type=int,
        default=int(os.environ.get("BUBBLE_SHAPE_DEFECT_MIN", str(DEFECT_MIN_COUNT))),
        help="jumlah defect signifikan minimum untuk freeform di zona abu-abu",
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


def shape_metrics(cv2, contour, defect_frac):
    """Solidity + convexity defects dari kontur ASLI (sebelum approxPolyDP).

    approxPolyDP bisa menggeser rasio area, jadi metrik dihitung di sini
    agar stabil terhadap parameter --epsilon. Return
    (solidity, defect_count, max_depth_px). Gagal hitung -> (1.0, 0, 0.0)
    (netral: tidak memaksa freeform maupun fallback).
    """
    try:
        area = float(cv2.contourArea(contour))
        hull = cv2.convexHull(contour)
        hull_area = float(cv2.contourArea(hull))
        solidity = min(1.0, area / hull_area) if hull_area > 0 else 1.0
    except Exception:
        return 1.0, 0, 0.0
    # convexityDefects butuh hull berupa INDEX, bukan koordinat — maka
    # convexHull dipanggil ulang dengan returnPoints=False. Bungkus
    # try/except karena OpenCV melempar cv2.error untuk kontur degenerat
    # (terlalu sedikit titik / kolinear) dan mengembalikan None bila
    # kontur sudah konveks penuh.
    try:
        _x, _y, bw, bh = cv2.boundingRect(contour)
        diag = math.hypot(bw, bh) or 1.0
        hull_idx = cv2.convexHull(contour, returnPoints=False)
        raw = cv2.convexityDefects(contour, hull_idx)
        if raw is None:
            return solidity, 0, 0.0
        # Bentuk return berbeda antar versi OpenCV: (N,1,4) atau (N,4).
        # reshape(-1,4) menangani keduanya (sumber IndexError umum).
        depth_thr = defect_frac * diag * 256.0  # unit mentah OpenCV (*256)
        count, mx = 0, 0.0
        for _s, _e, _f, d in raw.reshape(-1, 4):
            depth_px = float(d) / 256.0
            mx = max(mx, depth_px)
            if float(d) > depth_thr:
                count += 1
        return solidity, count, mx
    except Exception:
        return solidity, 0, 0.0


def classify_kind(solidity, defect_count, rectangularity,
                  smooth_thr, free_thr, defect_min):
    """ellipse / rect / freeform dari solidity + defects (skor gabungan).

    - solidity > smooth_thr -> halus, KECUALI banyak defect signifikan
      (gerigi dalam seperti lekukan awan: spike/thought-cloud yang
      tertutup morph-close tetap menyisakan cekungan dalam) -> freeform;
      jika tidak, rect vs ellipse via rectangularity (kotak memenuhi
      bbox-nya ~penuh, oval ~pi/4). Ekor bubble biasa hanya menghasilkan
      1-2 defect (< defect_min) sehingga oval berekor tetap ellipse.
    - solidity < free_thr -> jelas bergerigi -> freeform.
    - zona abu-abu di antaranya -> defect_count signifikan yang
      memutuskan (banyak lekukan dalam = freeform).
    """
    if solidity > smooth_thr:
        if defect_count >= defect_min:
            return "freeform"
        return "rect" if rectangularity > 0.90 else "ellipse"
    if solidity < free_thr:
        return "freeform"
    if defect_count >= defect_min:
        return "freeform"
    return "rect" if rectangularity > 0.90 else "ellipse"


def extract_one(cv2, np, img_path, epsilon, min_area_ratio,
                smooth_thr=SOLIDITY_SMOOTH, free_thr=SOLIDITY_FREE,
                defect_frac=DEFECT_FRAC, defect_min=DEFECT_MIN_COUNT):
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
    # Outline komik nyata tipis (2-3px): kernel kecil (3/5) dulu agar
    # outline tidak terhapus (closing besar menyatukan interior dengan
    # background putih -> background_only). Kernel membesar hanya bila
    # kontur terpecah (awan pikiran) sampai dapat kandidat valid.
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

    def touches_all_borders(bounding_rect):
        x, y, bw, bh = bounding_rect
        return (x <= 1 and y <= 1 and (x + bw) >= w - 1 and (y + bh) >= h - 1)

    def is_background(contour_area, bounding_rect):
        return (touches_all_borders(bounding_rect)
                and contour_area / crop_area > 0.90)

    k0 = int(min(w, h) * 0.02)
    base_k = max(3, min(15, k0 | 1))  # ganjil; floor 3 (bukan 7) demi outline tipis
    kernels = sorted({3, 5, base_k, min(31, base_k * 2 + 1), min(41, base_k * 3 + 1)})
    crop_area = float(w * h)
    # Kumpulkan SEMUA kandidat valid (bukan background) dari tiap skala,
    # lalu pilih yang TERLUAS (= bubble paling utuh). "Pertama valid"
    # saja tidak cukup: di kernel kecil, awan bisa lolos sebagai 1 sel
    # lingkaran (parsial) padahal kernel besar memberi gabungan utuh.
    valid = []  # (area, closed_img, contour)
    touched = None  # closed kernel terkecil yang background-like (untuk inversi)
    for k in kernels:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
        cand, cand_area = largest(closed)
        if cand is None:
            continue
        if cand_area / crop_area < min_area_ratio:
            continue
        rect = cv2.boundingRect(cand)
        if is_background(cand_area, rect):
            if touched is None:
                touched = closed
            continue
        valid.append((cand_area, closed, cand))
    best = None
    area = 0.0
    closed = binary
    if valid:
        area, closed, best = max(valid, key=lambda t: t[0])
    elif touched is not None:
        # Semua skala = background -> coba binary terbalik sekali (bubble
        # gelap/berwarna). Guard: hasil inversi yang JUGA background-like
        # ditolak -> fallback (mencegah kontur sampah dari noise field
        # seperti screentone yang batasnya menyentuh tepi crop).
        inv = cv2.bitwise_not(touched)
        alt, alt_area = largest(inv)
        if (alt is not None and alt_area / crop_area >= min_area_ratio
                and not is_background(alt_area, cv2.boundingRect(alt))):
            best, area = alt, alt_area
            closed = inv
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

    # Metrik dari kontur ASLI (sebelum approxPolyDP) agar stabil
    # terhadap --epsilon. Lihat shape_metrics().
    solidity, defect_count, max_defect_px = shape_metrics(cv2, best, defect_frac)
    # Solidity rendah = bentuk aneh/terpotong -> tidak dipercaya.
    if solidity < 0.5:
        row = empty_row(basename, w, h, "low_solidity")
        row["area_ratio"] = round(area / crop_area, 4)
        row["solidity"] = round(solidity, 4)
        row["defects"] = defect_count
        return row

    # rectangularity dari kontur ASLI (lebih stabil daripada dari approx).
    _bx, _by, _bw, _bh = cv2.boundingRect(best)
    rectangularity = area / max(float(_bw * _bh), 1.0)
    kind = classify_kind(solidity, defect_count, rectangularity,
                         smooth_thr, free_thr, defect_min)
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
        "solidity": round(solidity, 4),
        "defects": defect_count,
        "max_defect_px": round(max_defect_px, 1),
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
            out.append(extract_one(cv2, np, img_path, args.epsilon,
                                   args.min_area_ratio, args.solidity,
                                   args.solidity_free, args.defect_frac,
                                   args.defect_min))
        except Exception as e:  # 1 crop gagal != job gagal
            base = os.path.basename(img_path)
            row = empty_row(base, 0, 0, "exception")
            row["note"] = str(e)[:200]
            out.append(row)

    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
