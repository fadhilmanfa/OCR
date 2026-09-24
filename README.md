# Komik OCR EN → ID (Next.js)

Upload JPG/PNG/ZIP → OCR Inggris → auto-translate Indonesia → hapus teks asli → timpa teks ID.

Satu project (frontend + API) memakai **Next.js 16 App Router + TypeScript + Tailwind**.

---

## 1. Instalasi

### 1.1 Wajib (5 menit, tanpa Python)

Butuh: Node.js 18+.

```bat
npm install
copy .env.example .env
```

Selesai. File `.env` boleh dikosongkan total — default semua fitur jalan
tanpa key (translate gratis, OCR tesseract, bubble fallback aman). Isi hanya
variabel yang fiturnya dipakai (lihat 2.3).

### 1.2 Opsional — Translate natural (OpenRouter)

Default `auto` memakai Google gratis + fallback MyMemory (kaku/literal).
Untuk hasil natural seperti komik terbitan:

1. Daftar + ambil key di https://openrouter.ai/keys
2. Isi `.env`:

```bat
OPENROUTER_API_KEY=sk-or-v1-...
```

3. Pilih provider `openrouter` di form. Cek status key di `/api/health`.

> Konten dewasa: sebagian model menolak/menyensor. Untuk komik dewasa,
> set `OPENROUTER_MODEL=z-ai/glm-5.3-flash`
> (dan `OPENROUTER_VISION_MODEL=z-ai/glm-5.3-flash` bila memakai engine
> `vision_llm`). Lihat 2.3.

### 1.3 Opsional — Deteksi bubble YOLO

Tanpa ini app tetap jalan (otomatis fallback ke OCR full-page). Dengan ini:
OCR hanya di dalam bubble (1 pass cepat), overlay menulis tepat di area
bubble — mengurangi false positive dari ilustrasi/SFX.

Butuh Python 3.10+, setup sekali (Windows):

```bat
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r detector\requirements.txt
python detector\download_model.py
```

Dropdown "Bubble YOLO" di form: `ogkalu` (barat + manga, default),
`psimera` (manga), atau mati (`bubble=0` = OCR full-page).
Model (~52MB) di-download ke `detector/models/` (git-ignored).
Preview "Asli" ikut digambari kotak bubble (nomor + confidence); gambar
"Hasil ID" tetap bersih.

### 1.4 Opsional — Engine OCR comics_text_plus

Engine alternatif FCENet (deteksi) + MASTER (rekognisi) untuk huruf komik
yang gagal dibaca Tesseract. Dipilih via dropdown "OCR engine" di form.
Kalau gagal (venv/checkpoint belum ada), otomatis fallback ke Tesseract.

Berbeda dengan model bubble, engine ini **tidak bisa one-click install**:
butuh venv Python 3.9 terpisah (comics-ocr pin `torch==1.9` yang tidak
kompatibel dengan Python 3.12 / torch modern milik YOLO — jangan dicampur
satu env).

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

### 1.5 Opsional — Server OpenCode lokal (legacy)

Hanya bila memakai provider `opencode`:

```bat
opencode auth login
opencode serve
```

Env-nya (`OPENCODE_URL` dkk) lihat tabel di 2.3.

---

## 2. Cara jalan

### 2.1 Menjalankan

```bat
npm run dev
```

Buka http://localhost:3000.
Cek kesehatan + status key: http://localhost:3000/api/health

### 2.2 Cara pakai

1. Pilih JPG/PNG (boleh banyak, maks 50) atau ZIP berisi gambar.
2. Provider `auto` untuk default gratis (atau `openrouter` bila sudah isi key).
3. Klik Proses → tunggu (OCR 10–60 detik/halaman) → preview Before/After → Download ZIP/PDF.

### 2.3 Konfigurasi env (`.env`)

Yang **wajib** hanya 1 variabel per fitur opsional yang dipakai, sisanya
ada default di kode.

| Variabel | Wajib? | Default | Keterangan |
|---|---|---|---|
| `OPENROUTER_API_KEY` | Ya, kalau provider `openrouter` / engine `vision_llm` | — | Ambil di openrouter.ai/keys |
| `OPENROUTER_MODEL` | Tidak | `google/gemini-2.5-flash` | Model translate LLM (konten dewasa: `z-ai/glm-5.3-flash`) |
| `OPENROUTER_VISION_MODEL` | Tidak | `google/gemini-2.0-flash-001` | Model baca teks gambar |
| `BUBBLE_ENABLED` | Tidak | `1` | `0` = matikan deteksi bubble total |
| `BUBBLE_MODEL` | Tidak | `ogkalu` | `ogkalu` (barat+manga) / `psimera` (manga) |
| `BUBBLE_PYTHON` | Tidak | otomatis `python`→`py`→`python3` | Path Python khusus bila perlu |
| `BUBBLE_CONF` / `BUBBLE_IMGSZ` / `BUBBLE_MAX` | Tidak | `0.3` / `1024` / `40` | Tuning YOLO |
| `OCR_ENGINE` | Tidak | `tesseract` | Default server-side; pilihan form per-request selalu menang |
| `OPENCODE_URL` dkk | Ya, kalau provider `opencode` | `http://127.0.0.1:4096` | Butuh `opencode serve` jalan (legacy) |
| `COMICS_*` | Ya, kalau engine `comics_text_plus` | lihat `.env.example` | Butuh venv Python 3.9 + checkpoint (lihat 1.4) |

Prioritas nilai per-request: **form → query URL (`?provider=&bubble=&ocrEngine=`) → env → default kode**.

### 2.4 API

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/api/health` | status + config OpenRouter/OpenCode (apakah key terpasang) |
| POST | `/api/translate-text` | body `{ texts: string[], provider? }` |
| POST | `/api/process?provider=auto&bubble=1&ocrEngine=tesseract` | multipart `files` (+ field `provider`/`bubble`/`ocrEngine` opsional, menang atas env) |
| GET | `/api/outputs/<jobId>/<file>` | file hasil (png/zip/pdf) |

Respons `pages[]` memuat `via` (`yolo-ogkalu` / `yolo-psimera` /
`ocr-full`) dan `bubbleCount` selain `boxes`.

### 2.5 Catatan produksi

- Route `POST /api/process` memakai `runtime = "nodejs"` + `maxDuration = 300`.
  Jangan deploy ke serverless dengan timeout kecil; disarankan VPS/Docker
  dengan `npm run build && npm start`.
- Hasil tersimpan di folder lokal `outputs/` dan diserve lewat
  `/api/outputs/...`. Di lingkungan ephemeral (serverless) pindahkan ke Blob/S3.
- `sharp` didaftarkan di `serverExternalPackages` di `next.config.ts`.

### 2.6 Batasan v1

- Pembersihan = elips putih (bukan inpaint AI). Bagus untuk bubble putih komik barat.
- OCR = Tesseract.js. Kandidat bentuk/confidence buruk dilewati. Huruf stilasi / SFX
  masih bisa terlewat — cek preview.
- Translate Google gratis bisa rate-limit (sudah ada jeda + fallback).

---

## Lampiran: struktur project

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
  ocr.ts            # sharp + tesseract.js
  ocrComicsPlus.ts  # engine alternatif FCENet+MASTER via Python (opsional)
  ocrVisionLLM.ts   # engine alternatif Vision LLM via OpenRouter (opsional)
  bubble.ts         # YOLO bubble via Python sidecar (sekali per job, fallback aman)
  translate.ts      # auto (Google gratis → MyMemory), openrouter, opencode
  overlay.ts        # sharp composite SVG
components/
  UploadForm.tsx  PageCard.tsx  Downloads.tsx  types.ts
detector/       # sidecar Python YOLO (detect.py, requirements, README)
outputs/        # hasil per job (git-ignored, dibuat otomatis)
```
