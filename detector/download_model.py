#!/usr/bin/env python3
"""Download model .pt bubble ke detector/models/ (stdlib saja, tanpa pip).

    python detector/download_model.py             # download yg belum ada
    python detector/download_model.py --only psimera
"""

import argparse
import os
import sys
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
MODELS = {
    # YOLOv8m, komik barat + manga + webtoon (Apache-2.0, ~52MB)
    "ogkalu": (
        "https://huggingface.co/ogkalu/comic-speech-bubble-detector-yolov8m"
        "/resolve/main/comic-speech-bubble-detector.pt",
        "comic-speech-bubble-detector.pt",
    ),
    # YOLOv8, khusus manga, mAP50 0.977 (MIT, ~23MB)
    "psimera": (
        "https://huggingface.co/PSImera/manga_bubbles_detect"
        "/resolve/main/bubbles_detect.pt",
        "bubbles_detect.pt",
    ),
}


def download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 10_000_000:
        print("Sudah ada:", dest)
        return True
    print("Download", url)
    try:
        with urllib.request.urlopen(url) as r, open(dest, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            while True:
                chunk = r.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if total:
                    print(f"  {done/1e6:.1f}/{total/1e6:.1f} MB", end="\r")
            print()
    except Exception as e:
        if os.path.exists(dest):
            os.remove(dest)
        print("Gagal download:", e)
        return False
    print("OK:", dest, f"({os.path.getsize(dest)/1e6:.1f} MB)")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=list(MODELS), help="hanya model ini")
    args = ap.parse_args()
    os.makedirs(os.path.join(BASE, "models"), exist_ok=True)
    ok = True
    for name, (url, fname) in MODELS.items():
        if args.only and name != args.only:
            continue
        if not download(url, os.path.join(BASE, "models", fname)):
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
