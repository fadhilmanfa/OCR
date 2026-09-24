# Bubble detector (Python sidecar, opsional)

Deteksi speech bubble dengan YOLOv8. Dua model tersedia, dipilih via
dropdown form (`bubble=`) atau env `BUBBLE_MODEL`:

| ID | Model HF | Cocok untuk | Lisensi | Ukuran |
|---|---|---|---|---|
| `ogkalu` (default) | `ogkalu/comic-speech-bubble-detector-yolov8m` | komik barat + manga + webtoon | Apache-2.0 | ~52MB |
| `psimera` | `PSImera/manga_bubbles_detect` | manga (mAP50 0.977) | MIT | ~23MB |
Next.js memanggil `detect.py` **sekali per job**; kalau Python / model
tidak ada, app otomatis fallback ke OCR full-page (fitur mati total
hanya bila `BUBBLE_ENABLED=0`).

## Setup (Windows)

Butuh Python 3.10+ dari python.org (centang "Add to PATH" saat install).

```bat
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r detector\requirements.txt
python detector\download_model.py
```

Cek manual:

```bat
python detector\detect.py --images <satu-komik.png>
```

Output = 1 baris JSON `[{image, boxes:[{x0,y0,x1,y1,conf}]}]`.

## Env (lihat `.env.example`)

| Variabel | Default | Keterangan |
|---|---|---|
| `BUBBLE_ENABLED` | `1` | `0` = matikan total |
| `BUBBLE_PYTHON` | (otomatis) | Coba `python` → `py` → `python3` |
| `BUBBLE_CONF` | `0.3` | Threshold confidence YOLO |
| `BUBBLE_IMGSZ` | `1024` | Inference size (sama dengan training) |
| `BUBBLE_MAX` | `40` | Maks bubble per halaman |
| `BUBBLE_TIMEOUT_MS` | `300000` | Timeout 1 panggilan per job |
