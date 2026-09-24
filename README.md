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
  bubble.ts     # YOLO bubble via Python sidecar (sekali per job, fallback aman)
  translate.ts  # Google gratis → MyMemory, opsional OpenCode
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

## Cara pakai

1. Pilih JPG/PNG (boleh banyak, maks 50) atau ZIP.
2. Provider `auto` untuk default gratis.
3. Klik Proses → tunggu → preview Before/After → Download ZIP/PDF.

## API

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/api/health` | status + config OpenCode |
| POST | `/api/translate-text` | body `{ texts: string[], provider? }` |
| POST | `/api/process?provider=auto&bubble=1` | multipart `files` (+ field `provider`/`bubble` opsional) |
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

## OpenCode (provider opsional)

Default `auto` memakai Google gratis + fallback MyMemory. `provider=opencode`
memakai server OpenCode lokal: `POST {OPENCODE_URL}/api/experimental/generate`.

Isi `.env` (lihat `.env.example`):

| Variabel | Isi |
|---|---|
| `OPENCODE_URL` | URL `opencode serve`, default `http://127.0.0.1:4096` |
| `OPENCODE_MODEL` | Opsional, kosongkan = default model |
| `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | Hanya kalau serve diproteksi password |

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

- Pembersihan = rect putih (bukan inpaint AI). Bagus untuk bubble putih komik barat.
- OCR = Tesseract.js. Kandidat bentuk/confidence buruk dilewati. Huruf stilasi / SFX
  masih bisa terlewat — cek preview.
- Translate Google gratis bisa rate-limit (sudah ada jeda + fallback).
