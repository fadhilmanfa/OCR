#!/usr/bin/env python3
"""Buat 6 crop bubble sintetik untuk validasi bubble_shape.py.

Pakai:  python scripts/make-shape-fixtures.py
Hasil:  outputs/fixtures/shape-<nama>.png (crop 300x220, bubble + teks dummy)

Variasi: oval, kotak, rounded, awan pikiran (bergerigi), bubble gelap
(fallback), kotak kecil ber-noise. Bubble putih diberi teks dummy agar
mirip crop asli (morph close harus menutupnya).
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

print("Selesai. Jalankan: python detector/bubble_shape.py --images outputs/fixtures/shape-*.png")
