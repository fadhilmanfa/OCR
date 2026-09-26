#!/usr/bin/env python3
"""Uji kontur tanpa YOLO/Google API: bentuk dan pemilihan seed lokal."""

import os
import sys
import tempfile

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "detector"))
from bubble_shape import extract_one  # noqa: E402


def run(img, seed=None, minimum=0.08):
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "crop.png")
        cv2.imwrite(path, img)
        return extract_one(cv2, np, path, 0.01, minimum, seed=seed)


bg = np.full((260, 500, 3), 125, dtype=np.uint8)
cv2.rectangle(bg, (20, 20), (250, 240), (255, 255, 255), -1)
cv2.rectangle(bg, (20, 20), (250, 240), (0, 0, 0), 3)
cv2.rectangle(bg, (330, 50), (470, 200), (255, 255, 255), -1)
cv2.rectangle(bg, (330, 50), (470, 200), (0, 0, 0), 3)

left = run(bg, (100.0, 120.0))
right = run(bg, (400.0, 120.0))
assert left["shape"] == "contour" and left["bbox"]["x1"] < 300, left
assert right["shape"] == "contour" and right["bbox"]["x0"] > 300, right

def canvas(color=128):
    return np.full((220, 300, 3), color, dtype=np.uint8)


oval = canvas()
cv2.ellipse(oval, (150, 110), (120, 85), 0, 0, 360, (255, 255, 255), -1)
cv2.ellipse(oval, (150, 110), (120, 85), 0, 0, 360, (0, 0, 0), 4)
rect = canvas()
cv2.rectangle(rect, (30, 25), (270, 195), (255, 255, 255), -1)
cv2.rectangle(rect, (30, 25), (270, 195), (0, 0, 0), 4)
cloud = canvas()
circles = [(90, 80, 42), (140, 65, 50), (195, 75, 44),
           (110, 125, 48), (165, 120, 52), (215, 125, 40),
           (130, 165, 40), (185, 165, 42)]
for color, thickness in (((255, 255, 255), -1), ((0, 0, 0), 3)):
    for x, y, radius in circles:
        cv2.circle(cloud, (x, y), radius, color, thickness)
dark = canvas(200)
cv2.ellipse(dark, (150, 110), (120, 85), 0, 0, 360, (30, 30, 30), -1)
cv2.ellipse(dark, (150, 110), (120, 85), 0, 0, 360, (0, 0, 0), 4)

for name, image, expected in (("oval", oval, "ellipse"),
                              ("rect", rect, "rect"),
                              ("cloud", cloud, "freeform"),
                              ("dark", dark, "ellipse")):
    row = run(image, minimum=0.15)
    assert row["shape"] == "contour" and row["kind"] == expected, (name, row)

# Reproduksi masalah halaman komik: panel berwarna menyentuh batas crop,
# sedangkan bubble putih berada di dalamnya. Kontur panel lebih luas,
# tetapi tidak boleh terpilih sebagai bubble.
panel = np.full((250, 340, 3), 255, dtype=np.uint8)
cv2.rectangle(panel, (0, 20), (319, 249), (110, 170, 225), -1)
cv2.rectangle(panel, (0, 20), (319, 249), (0, 0, 0), 3)
cv2.ellipse(panel, (190, 95), (105, 62), 0, 0, 360, (255, 255, 255), -1)
cv2.ellipse(panel, (190, 95), (105, 62), 0, 0, 360, (0, 0, 0), 3)
picked = run(panel, (190.0, 95.0))
assert picked["shape"] == "contour", picked
assert picked["bbox"]["x0"] > 50 and picked["bbox"]["x1"] < 320, picked
assert picked["bbox"]["y0"] > 20 and picked["bbox"]["y1"] < 240, picked

print("OK: 4 bentuk + 2 seed bubble berdekatan + panel berwarna")
