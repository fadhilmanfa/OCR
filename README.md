# Komik OCR EN → ID (Next.js)

Upload JPG/PNG/ZIP → OCR Inggris → auto-translate Indonesia → hapus teks asli → timpa teks ID.

Hasil migrasi dari project Express vanilla (`D:\fadhil_nitip\ocr`) ke **Next.js 16 App Router + TypeScript + Tailwind**, satu project (frontend + API).

## Struktur

```
app/
  page.tsx                    # UI utama (client component)
  layout.tsx
  api/
    health/route.ts           # GET /api/health
    translate-text/route.ts   # POST /api/translate-text
    process/route.ts          # POST /api/process (multipart FormData)
    outputs/[jobId]/[file]/route.ts  # GET file hasil (pengganti express.static)
lib/
  ocr.ts        # sharp + tesseract.js
  ocrComicsPlus.ts  # engine alternatif FCENet+MASTER via Python (opsional)
  ocrVisionLLM.ts   # engine alternatif Vision LLM via OpenRouter (opsional)
  bubble.ts     # YOLO bubble via Python sidecar (sekali per job, fallback aman)
  translate.ts  # auto (Google gratis → MyMemory), openrouter, opencode
  overlay.ts    # sharp composite SVG
components/
  UploadForm.tsx  PageCard.tsx  Downloads.tsx  types.ts
detector/       # sidecar Python YOLO (detect.py, requirements, README)
outputs/        # hasil per job (git-ignored, dibuat otomatis)
```

## Cara jalan (Windows, tanpa Python)

Butuh: Node.js 18+.

```bat
npm install
copy .env.example .env
npm run dev
```

Buka: http://localhost:3000

> File `.env` boleh dikosongkan total — default semua fitur jalan tanpa
> key (translate gratis, OCR tesseract, bubble fallback aman). Isi hanya
> variabel yang fiturnya dipakai; lihat tabel di bawah.

## Konfigurasi env (`.env`)

Salin dulu `copy .env.example .env`. Yang **wajib** hanya 1, sisanya
opsional (ada default di kode). Cek status key di `/api/health`.

| Variabel | Wajib? | Default | Keterangan |
|---|---|---|---|
| `OPENROUTER_API_KEY` | Ya, kalau provider `openrouter` / engine `vision_llm` | — | Ambil di openrouter.ai/keys |
| `OPENROUTER_MODEL` | Tidak | `google/gemini-2.5-flash` | Model translate LLM (konten dewasa: lihat bawah) |
| `OPENROUTER_VISION_MODEL` | Tidak | `google/gemini-2.0-flash-001` | Model baca teks gambar |
| `BUBBLE_ENABLED` | Tidak | `1` | `0` = matikan deteksi bubble total |
| `BUBBLE_MODEL` | Tidak | `ogkalu` | `ogkalu` (barat+manga) / `psimera` (manga) |
| `BUBBLE_PYTHON` | Tidak | otomatis `python`→`py`→`python3` | Path Python khusus bila perlu |
| `BUBBLE_CONF` / `BUBBLE_IMGSZ` / `BUBBLE_MAX` | Tidak | `0.3` / `1024` / `40` | Tuning YOLO |
| `OCR_ENGINE` | Tidak | `tesseract` | Default server-side; pilihan form per-request selalu menang |
| `OPENCODE_URL` dkk | Ya, kalau provider `opencode` | `http://127.0.0.1:4096` | Butuh `opencode serve` jalan (legacy) |
| `COMICS_*` | Ya, kalau engine `comics_text_plus` | lihat `.env.example` | Butuh venv Python 3.9 + checkpoint |

Prioritas nilai per-request: **form → query URL (`?provider=&bubble=&ocrEngine=`) → env → default kode**.

### Konten dewasa

Sebagian model LLM menolak atau menyensor konten dewasa (hasil kosong /
ditolak). Untuk komik dewasa, ganti modelnya ke `z-ai/glm-5.3-flash`:

```bat
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=z-ai/glm-5.3-flash
```

Kalau memakai engine `vision_llm`, samakan juga model vision-nya:

```bat
OPENROUTER_VISION_MODEL=z-ai/glm-5.3-flash
```

## Cara pakai

1. Pilih JPG/PNG (boleh banyak, maks 50) atau ZIP.
2. Provider `auto` untuk default gratis.
3. Klik Proses → tunggu → preview Before/After → Download ZIP/PDF.

## API

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/api/health` | status + config OpenRouter/OpenCode (apakah key terpasang) |
| POST | `/api/translate-text` | body `{ texts: string[], provider? }` |
| POST | `/api/process?provider=auto&bubble=1&ocrEngine=tesseract` | multipart `files` (+ field `provider`/`bubble`/`ocrEngine` opsional, menang atas env) |
| GET | `/api/outputs/<jobId>/<file>` | file hasil (png/zip/pdf) |

Respons `pages[]` memuat `via` (`yolo-ogkalu` / `yolo-psimera` /
`ocr-full`) dan `bubbleCount` selain `boxes`.

## Bubble YOLO (opsional, default aktif + fallback aman)

Dropdown "Bubble YOLO" di form: `ogkalu` (barat + manga, default),
`psimera` (manga), atau mati (`bubble=0` untuk OCR full-page). Kalau bubble ketemu: OCR hanya di dalam bubble (1 pass
cepat), overlay membersihkan + menulis tepat di area bubble — mengurangi
false positive dari ilustrasi/SFX. Kalau tidak ketemu / Python belum
diinstall: otomatis jalur lama (OCR full-page).

Setup sekali (Windows, Python 3.10+):

```bat
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r detector\requirements.txt
python detector\download_model.py
```

Preview "Asli" ikut digambari kotak bubble (nomor + confidence) agar
terlihat apa yang terdeteksi; gambar "Hasil ID" tetap bersih.

Model: `ogkalu/comic-speech-bubble-detector-yolov8m` (Apache-2.0, ~52MB,
di-download ke `detector/models/`, git-ignored). Detail env: lihat
`detector/README.md`.

## OCR comics_text_plus (opsional, setup manual)

Engine alternatif FCENet (deteksi) + MASTER (rekognisi) untuk huruf komik
yang gagal dibaca Tesseract. Dipilih via dropdown "OCR engine" di form.
Kalau gagal (venv/checkpoint belum ada), otomatis fallback ke Tesseract.

Berbeda dengan model bubble (satu script download), engine ini **tidak
bisa one-click install**: butuh venv Python 3.9 terpisah (comics-ocr pin
`torch==1.9` yang tidak kompatibel dengan Python 3.12 / torch modern
milik YOLO — jangan dicampur satu env).

Langkah (Windows, sekali saja):

```bat
py -3.9 -m venv C:\venvs\comics
C:\venvs\comics\Scripts\activate
pip install torch==1.9.0+cpu torchvision==0.10.0+cpu -f https://download.pytorch.org/whl/torch_stable.html
pip install comics-ocr Pillow
```

> Daftar versi yang terbukti jalan ada di
> `detector/requirements-comics-py39.txt` (hasil `pip freeze`, bukan file
> install — baca header-nya dulu karena ada pin yang harus dipasang manual).

Download checkpoint dari folder Google Drive di README repo
`github.com/gsoykan/comics_text_plus`, taruh di
`detector/models/comics_text_plus/` dengan nama file fine-tune aslinya.
Kalau Drive-nya terkunci, pakai bobot dasar publik (`*_base-*.pth`) +
arahkan 2 env ini ke file tersebut. Lalu isi `.env`:

```bat
COMICS_PYTHON=C:\venvs\comics\Scripts\python.exe
COMICS_DET_CKPT=detector/models/comics_text_plus/fcenet_r50dcnv2_fpn_1500e_ctw1500_base-e326d7ec.pth
COMICS_RECOG_CKPT=detector/models/comics_text_plus/master_r31_12e_ST_MJ_SA_base-787edd36.pth
```

Semua file di `detector/models/` git-ignored — tiap mesin download sendiri.

## OpenCode (provider opsional)

Default `auto` memakai Google gratis + fallback MyMemory. `provider=opencode`
memakai server OpenCode lokal: `POST {OPENCODE_URL}/api/experimental/generate`.
Variabel env-nya lihat tabel di "Konfigurasi env" di atas
(`OPENCODE_URL`, `OPENCODE_MODEL`, `OPENCODE_SERVER_USERNAME` /
`OPENCODE_SERVER_PASSWORD` — password hanya kalau serve diproteksi).

```bat
opencode auth login
opencode serve
npm run dev
```

Cek: http://localhost:3000/api/health

## Catatan produksi

- Route `POST /api/process` memakai `runtime = "nodejs"` + `maxDuration = 300`
  (OCR 10–60 detik/halaman). Jangan deploy ke serverless dengan timeout kecil;
  disarankan VPS/Docker dengan `npm run build && npm start`.
- Hasil tersimpan di folder lokal `outputs/` dan diserve lewat
  `/api/outputs/...`. Di lingkungan ephemeral (serverless) pindahkan ke Blob/S3.
- `sharp` didaftarkan di `serverExternalPackages` di `next.config.ts`.

## Batasan v1 (sama seperti project lama)

- Pembersihan = elips putih (bukan inpaint AI). Bagus untuk bubble putih komik barat.
- OCR = Tesseract.js. Kandidat bentuk/confidence buruk dilewati. Huruf stilasi / SFX
  masih bisa terlewat — cek preview.
- Translate Google gratis bisa rate-limit (sudah ada jeda + fallback).
