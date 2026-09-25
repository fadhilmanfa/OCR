#!/usr/bin/env python3
"""Buat 9 crop bubble sintetik untuk validasi bubble_shape.py.

Pakai:  python scripts/make-shape-fixtures.py
Hasil:  outputs/fixtures/shape-<nama>.png (crop 300x220, bubble + teks dummy)

Variasi: oval, kotak, rounded, awan pikiran (bergerigi), bubble gelap
(fallback), kotak kecil ber-noise, oval-rough (noise tepi -> zona abu-abu
solidity), cloud-soft (awan halus -> uji defects), screentone (pola titik
ala manga di background -> uji Otsu di background tidak polos).
Bubble putih diberi teks dummy agar mirip crop asli.
"""

import math
import os
import sys

try:
    import cv2
    import numpy as np
except ImportError:
    sys.exit("butuh opencv-python: pip install opencv-python")

OUT = os.path.join("outputs", "fixtures")
os.makedirs(OUT, exist_ok=True)

W, H = 300, 220


def base(bg=(128, 128, 128)):
    return np.full((H, W, 3), bg, dtype=np.uint8)


def add_text(img):
    cv2.putText(img, "HELLO", (80, 95), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)
    cv2.putText(img, "WORLD", (80, 135), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)


def save(name, img):
    p = os.path.join(OUT, f"shape-{name}.png")
    cv2.imwrite(p, img)
    print("tulis", p)


# 1) oval putih outline hitam
img = base()
cv2.ellipse(img, (150, 110), (120, 85), 0, 0, 360, (255, 255, 255), -1)
cv2.ellipse(img, (150, 110), (120, 85), 0, 0, 360, (0, 0, 0), 4)
add_text(img)
save("oval", img)

# 2) kotak putih outline hitam
img = base()
cv2.rectangle(img, (30, 25), (270, 195), (255, 255, 255), -1)
cv2.rectangle(img, (30, 25), (270, 195), (0, 0, 0), 4)
add_text(img)
save("rect", img)

# 3) rounded rect (kotak dialog modern)
img = base()
x0, y0, x1, y1, r = 30, 25, 270, 195, 28
cv2.rectangle(img, (x0 + r, y0), (x1 - r, y1), (255, 255, 255), -1)
cv2.rectangle(img, (x0, y0 + r), (x1, y1 - r), (255, 255, 255), -1)
for cx, cy in [(x0 + r, y0 + r), (x1 - r, y0 + r), (x0 + r, y1 - r), (x1 - r, y1 - r)]:
    cv2.circle(img, (cx, cy), r, (255, 255, 255), -1)
cv2.rectangle(img, (x0 + r, y0), (x1 - r, y1), (0, 0, 0), 3)
cv2.rectangle(img, (x0, y0 + r), (x1, y1 - r), (0, 0, 0), 3)
for cx, cy in [(x0 + r, y0 + r), (x1 - r, y0 + r), (x0 + r, y1 - r), (x1 - r, y1 - r)]:
    cv2.circle(img, (cx, cy), r, (0, 0, 0), 3)
add_text(img)
save("rounded", img)

# 4) awan pikiran: gabungan lingkaran bergerigi
img = base()
for cx, cy, rr in [(90, 80, 42), (140, 65, 50), (195, 75, 44),
                   (110, 125, 48), (165, 120, 52), (215, 125, 40),
                   (130, 165, 40), (185, 165, 42)]:
    cv2.circle(img, (cx, cy), rr, (255, 255, 255), -1)
for cx, cy, rr in [(90, 80, 42), (140, 65, 50), (195, 75, 44),
                   (110, 125, 48), (165, 120, 52), (215, 125, 40),
                   (130, 165, 40), (185, 165, 42)]:
    cv2.circle(img, (cx, cy), rr, (0, 0, 0), 3)
add_text(img)
save("cloud", img)

# 5) bubble GELAP (teks putih) -> diharapkan ellipse_fallback, bukan crash
img = base((200, 200, 200))
cv2.ellipse(img, (150, 110), (120, 85), 0, 0, 360, (30, 30, 30), -1)
cv2.ellipse(img, (150, 110), (120, 85), 0, 0, 360, (0, 0, 0), 4)
cv2.putText(img, "HELLO", (80, 95), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
cv2.putText(img, "WORLD", (80, 135), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
save("dark", img)

# 6) kotak kecil ber-noise (uji ketahanan)
img = base()
cv2.rectangle(img, (40, 35), (260, 185), (255, 255, 255), -1)
cv2.rectangle(img, (40, 35), (260, 185), (0, 0, 0), 4)
add_text(img)
noise = np.random.default_rng(7).integers(0, 40, img.shape, dtype=np.uint8)
img = cv2.add(img, noise)
save("noisy", img)

# 7) oval-rough: oval dengan outline bergelombang terstruktur (cetakan
# rusak / scan kasar). Radius dimodulasi gelombang + jitter sehingga tepi
# bergerigi tapi bentuk global tetap oval. Menguji ZONA ABU-ABU solidity
# (target kisaran 0.8x-0.9x): defects di zona ini yang memutuskan
# freeform vs ellipse — kalibrasi ambang 0.92.
img = base()
rng = np.random.default_rng(21)
ths = np.linspace(0, 2 * math.pi, 400, endpoint=False)
wave = 7 * np.sin(20 * ths) + 3 * np.sin(47 * ths + 1.3) + rng.normal(0, 1.5, ths.shape)
rr = 1 + wave / 100.0
cx, cy, ax, ay = 150, 110, 120, 85
pts = np.stack([cx + ax * rr * np.cos(ths), cy + ay * rr * np.sin(ths)]).T.astype(np.int32)
cv2.fillPoly(img, [pts], (255, 255, 255))
cv2.polylines(img, [pts], True, (0, 0, 0), 4)
add_text(img)
save("oval-rough", img)

# 8) cloud-soft: awan dari 4 lingkaran besar bertumpuk (lebih halus dari
# cloud biasa). Menguji apakah defects menangkap lekukan yang tersisa:
# harapan solidity zona abu-abu + defects >= 3 -> freeform.
img = base()
for cx, cy, rr in [(115, 100, 62), (190, 95, 66), (140, 145, 60), (190, 150, 56)]:
    cv2.circle(img, (cx, cy), rr, (255, 255, 255), -1)
for cx, cy, rr in [(115, 100, 62), (190, 95, 66), (140, 145, 60), (190, 150, 56)]:
    cv2.circle(img, (cx, cy), rr, (0, 0, 0), 3)
add_text(img)
save("cloud-soft", img)

# 9) screentone: pola titik ala manga di background (bukan solid-color).
# Menguji apakah Otsu masih menangkap outline bubble dengan bersih saat
# background tidak polos. Titik abu-abu (150) di atas putih (255):
# Otsu harusnya tetap memisahkan interior bubble (255 solid) dari
# background bertitik.
img = np.full((H, W, 3), 255, dtype=np.uint8)
for yy in range(3, H, 7):
    for xx in range(3 + (yy % 14 == 3) * 3, W, 7):
        cv2.circle(img, (xx, yy), 2, (150, 150, 150), -1)
cv2.ellipse(img, (150, 110), (115, 80), 0, 0, 360, (255, 255, 255), -1)
cv2.ellipse(img, (150, 110), (115, 80), 0, 0, 360, (0, 0, 0), 4)
add_text(img)
save("screentone", img)

print("Selesai. Jalankan: python detector/bubble_shape.py --images outputs/fixtures/shape-*.png")
