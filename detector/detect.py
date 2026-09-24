#!/usr/bin/env python3
"""Deteksi speech bubble komik dengan YOLOv8.

Model: ogkalu/comic-speech-bubble-detector-yolov8m (Apache-2.0),
YOLOv8m, training imgsz=1024, cocok untuk manga / webtoon / manhua /
komik barat.

Dipanggil dari Node (lib/bubble.ts) SEKALI per job dengan banyak gambar
agar load model PyTorch hanya terjadi 1x:

    python detector/detect.py --images a.png b.png [--conf 0.3] [--imgsz 1024]

Output: SATU baris JSON ke stdout, urutan sama dengan input:

    [{"image": "a.png", "boxes": [{"x0":..,"y0":..,"x1":..,"y1":..,"conf":..}]}]

Koordinat dalam piksel gambar ASLI (ultralytics mengembalikan skala penuh).
Kalau model / ultralytics belum ada, cetak {"error": ...} dan exit != 0
supaya sisi Node bisa fallback ke OCR full-page.
"""

import argparse
import json
import os
import sys

MODEL_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "models",
    "comic-speech-bubble-detector.pt",
)


def parse_args():
    p = argparse.ArgumentParser(description="YOLO comic bubble detector")
    p.add_argument("--images", nargs="+", required=True, help="path gambar")
    p.add_argument("--model", default=MODEL_PATH, help="path file .pt")
    p.add_argument("--conf", type=float, default=0.3, help="threshold confidence")
    p.add_argument("--imgsz", type=int, default=1024, help="inference size")
    p.add_argument("--iou", type=float, default=0.5, help="threshold NMS IoU")
    return p.parse_args()


def fail(code, **payload):
    print(json.dumps(payload))
    return code


def main():
    args = parse_args()

    if not os.path.exists(args.model):
        return fail(
            2,
            error="model_not_found",
            model=args.model,
            hint="jalankan: python detector/download_model.py",
        )

    try:
        from ultralytics import YOLO
    except ImportError:
        return fail(
            3,
            error="no_ultralytics",
            hint="pip install -r detector/requirements.txt",
        )

    model = YOLO(args.model)
    results = model.predict(
        source=args.images, imgsz=args.imgsz, conf=args.conf, iou=args.iou,
        verbose=False,
    )

    out = []
    for img_path, r in zip(args.images, results):
        boxes = []
        if r.boxes is not None and len(r.boxes) > 0:
            xyxy = r.boxes.xyxy.tolist()
            conf = r.boxes.conf.tolist()
            for (x0, y0, x1, y1), c in zip(xyxy, conf):
                if isinstance(c, (list, tuple)):
                    c = c[0] if c else 0.0
                boxes.append(
                    {
                        "x0": float(x0),
                        "y0": float(y0),
                        "x1": float(x1),
                        "y1": float(y1),
                        "conf": float(c),
                    }
                )
        out.append({"image": os.path.basename(img_path), "boxes": boxes})

    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
