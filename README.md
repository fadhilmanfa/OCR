# Komik OCR EN / JA / ID / ZH (Next.js)

Upload JPG/PNG/ZIP → OCR Inggris/Jepang/Indonesia/Mandarin → auto-translate → hapus teks asli → timpa teks terjemahan.

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
2. Masukkan API key di web setelah memilih penerjemah `OpenRouter` atau mesin OCR
   `Vision LLM`. Alternatifnya, isi `.env`:

```bat
OPENROUTER_API_KEY=sk-or-v1-...
```

3. Pilih provider `openrouter` di form. Key dari UI diprioritaskan; jika kosong,
   server memakai `OPENROUTER_API_KEY` dari env. Key UI disimpan di `sessionStorage`
   selama sesi tab, sehingga tetap tersedia setelah refresh. Key tidak disimpan
   dalam metadata job di server.
   `/api/health` hanya menunjukkan status key env, tanpa menampilkan nilainya.

API menerima field `apiKey` opsional dalam multipart body `/api/jobs` dan
`/api/process`, atau JSON body `/api/translate-text`. Key dikirim lewat body,
bukan query URL, dan tidak disertakan dalam progress atau hasil job.

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
Untuk bubble persegi, bulat, dan bentuk bebas, OpenCV mengambil kontur
di dalam area deteksi. Teks terjemahan ditempatkan pada ruang aman di
dalam kontur. Jika kontur tidak terbaca, jalur YOLO memakai elips;
pilihan bubble Google memakai kotak teks kecil sebagai cadangan.

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
2. `Mode proses`:
   - **Terjemahkan**: OCR → terjemah → timpa teks asli (default: per baris)
     → teks terjemahan ditempel. Bubble yang teksnya tidak terbaca tetap
     ditimpa satu bubble penuh agar tidak ada sisa huruf.
   - **Bersihkan saja (cek timpa)**: hanya menimpa seluruh bubble, tanpa OCR
     dan terjemahan. Dipakai untuk mengecek dulu coverage bubble; tidak
     memakai kredit API dan jauh lebih cepat.
3. Pilih bahasa `Dari → Ke` (Inggris / Jepang / Indonesia / Mandarin).
4. Provider `auto` untuk default gratis (atau `openrouter` bila sudah isi key).
5. `Bersih teks` menentukan cara timpa:
   - **Per baris teks** (default UI): OCR melacak posisi tiap baris, lalu
     hanya baris itu yang ditimpa (warna kertas). Kotak baris juga dipotong
     ke kontur bubble, jadi mask tidak melewati garis outline. Outline bubble
     dan ilustrasi tetap utuh — tidak ada blok/lingkaran putih yang oversize.
   - **Warna bubble**: seluruh area bubble ditimpa dengan warna kertas dari
     gambar, jadi bubble abu-abu/berwarna tidak menjadi putih.
   - **Putih**: seluruh area bubble ditimpa putih solid (perilaku lama).
   - **Tanpa hapus**: tidak menimpa apa pun (hanya berguna dengan mode
     terjemahkan, untuk mengecek OCR).
   API: kirim field/query `mode` (`translate`/`clean`) dan `cleanMode`
   (`text`/`white`/`bubble`/`none`). Tanpa `cleanMode`, API lama tetap
   `white`; UI memakai `text`. Mode `clean` hanya sah dengan deteksi bubble
   Ogkalu/Psimera dan otomatis memakai mask bubble penuh karena tidak ada OCR.
6. Klik Proses → tunggu (OCR 10–60 detik/halaman) → preview Before/After → Download ZIP/PDF.
7. Bila ada teks yang terlewat, klik **Koreksi mask** di halaman hasil.
   Editor memakai ribbon dua tab: **Mask** (Alat, Ukuran, Mask otomatis,
   Riwayat, Latar, Zoom) dan **Teks** (font, gaya, ukuran, cakupan, tampilan,
   posisi teks).
   **Brush** menimpa area yang terlewat, **Eraser** mengoreksi goresan
   (urutan paint → erase → paint dipertahankan), dan alat **Mask** mengatur
   mask otomatis (garis kuning): klik kotak lalu geser untuk pindah, tarik
   handle untuk ubah ukuran, atau **Hapus** / `Delete`. Semua perubahan
   langsung tampil di foto memakai warna kertas (preview lokal, tanpa render
   server). Preview memakai gambar dasar tanpa teks, lalu teks terjemahan
   digambar ulang di atas sapuan brush — jadi menimpa bubble tidak
   menghilangkan terjemahannya. Mask yang dihapus tetap ditandai merah (silang)
   dan bisa diaktifkan lagi dengan mengklik kotaknya. **Pulihkan**
   mengembalikan semua mask otomatis ke posisi/ukuran awal.
   Tab **Teks** menampilkan workspace tipografi: halaman tanpa teks + tiap
   terjemahan sebagai kotak yang bisa digeser dan diubah ukurannya (tarik
   handle). Pilih kotak lalu ubah **Isi teks** di ribbon (atau ganti font,
   bold, skala); teks di dalam kotak langsung mengikuti, otomatis wrap dan
   menyesuaikan ukuran. **Hapus** / `Delete` menghilangkan teks terjemahan
   (area tetap dibersihkan); teks yang dihapus ditandai merah dan bisa
   diaktifkan lagi. **Cakupan** menentukan font hanya untuk halaman ini atau
   semua halaman. **Pulihkan** mengembalikan semua kotak teks ke posisi/isi
   awal dan menampilkan lagi teks yang dihapus.
   **Undo/Redo** (Ctrl+Z / Ctrl+Shift+Z) mencakup goresan, edit mask, dan
   posisi kotak teks. Ukuran brush (`[` / `]`), latar **Hasil / Asli**, tombol
   layar penuh, serta **Ctrl+scroll** untuk zoom, scroll untuk geser,
   **Shift+scroll** untuk geser kanan/kiri, Space+drag / tombol tengah untuk
   pan, dan pinch dua jari di layar sentuh. **Terapkan** tetap diperlukan untuk
   menyimpan: server merender ulang halaman dari gambar asli (terjemahan tetap
   aman) lalu memperbarui ZIP/PDF. Mask manual dan pengaturan teks disimpan
   selama sesi hasil masih ada.

### Sesi dan masa simpan hasil

Hasil disimpan selama **10 menit sejak pemrosesan selesai**, lalu folder job
beserta PNG, ZIP, PDF, dan metadata dihapus otomatis. Refresh, polling, dan
unduhan tidak memperpanjang batas waktu. File parsial job gagal dibersihkan
10 menit sejak kegagalan. Hitung mundur ditampilkan di halaman hasil.

Sesi tab menyimpan ID job terakhir, pilihan pemrosesan, dan API key. Refresh
melanjutkan pemantauan job yang sudah diterima server atau menampilkan hasil
yang masih tersedia. File yang belum selesai diunggah perlu dipilih kembali.
Tombol **Proses baru** mempertahankan pengaturan dan key. Sesi tidak dijanjikan
lintas perangkat atau setelah tab ditutup.

Koreksi mask disimpan di server bersama hasil (gambar asli + metadata render)
selama hasil belum kedaluwarsa. Koreksi **tidak memperpanjang** batas 10 menit;
setelah itu halaman asli ikut terhapus dan editor tidak bisa dipakai lagi.

Preferensi editor (layar penuh, alat, ukuran brush, tab aktif) dan draf
koreksi (goresan + edit mask otomatis + posisi kotak teks) disimpan di
`localStorage` browser, jadi membuka **Koreksi mask** lagi memakai setelan
terakhir dan koreksi yang belum diterapkan tidak hilang. Font dan ukuran/posisi
kotak teks sendiri disimpan di server per job (bukan di localStorage). Draf
dibuang otomatis setelah **Terapkan** berhasil atau saat halaman hasil sudah
kedaluwarsa (editor tidak bisa dimuat lagi).

Cleanup berjalan pada satu server Node.js yang terus hidup, termasuk tanpa
halaman browser terbuka. Jika server mati, cleanup dilanjutkan saat startup:
hasil selesai dipulihkan dari metadata, job terputus ditandai gagal, dan folder
lama tanpa metadata dibersihkan berdasarkan umur folder. Pemeriksaan ulang
setiap menit menangani penghapusan yang gagal. Jangan gunakan beberapa instance
server yang berbagi folder `outputs` dengan mekanisme ini.

Respons hasil dan status terminal memuat `expiresAt` (timestamp milidetik).
Endpoint output/status menggunakan `Cache-Control: no-store`; hasil kedaluwarsa
mengembalikan `410` sebelum cleanup atau `404` setelah dihapus.

### 2.3 Konfigurasi env (`.env`)

### Setup terbaik (download besar tidak masalah)
- Bubble: download kedua model (`python detector/download_model.py` tanpa `--only`):
  `ogkalu ~52MB` untuk barat, `psimera ~23MB` untuk manga.
- OCR:
  - Sumber Inggris: `comics_text_plus` (venv Python 3.9 + checkpoint, lihat 1.4) paling akurat untuk huruf komik; fallback otomatis ke Tesseract.
  - Sumber Jepang: `vision_llm` (butuh `OPENROUTER_API_KEY`) atau `google_vision` (butuh `GOOGLE_VISION_API_KEY`) — jauh lebih akurat dari Tesseract untuk kana/kanji, teks vertikal, dan huruf stilasi. Tesseract `jpn` lokal tetap didukung sebagai fallback offline (data diunduh otomatis oleh tesseract.js).
  - Sumber Mandarin: `vision_llm` atau `google_vision` sangat disarankan karena Tesseract `chi_sim` lebih lemah untuk hanzi bergaya komik. Fallback lokal memakai `chi_sim` (diunduh otomatis oleh tesseract.js, ±20MB) dan hanya mendukung Mandarin Sederhana.
  - Sumber Indonesia: `tesseract` bawaan cukup.
- Translate natural: `openrouter` (butuh key). Rekomendasi model: umum `google/gemini-2.5-flash`, kualitas JP tinggi `google/gemini-2.5-pro` / `anthropic/claude-3.5-sonnet`, konten dewasa `z-ai/glm-5.3-flash`. `auto` (Google gratis + MyMemory) tetap ada tapi kaku/literal dan rawan rate-limit.
- `comics_text_plus` hanya latin — untuk sumber Jepang/Indonesia/Mandarin otomatis fallback ke Tesseract (tercatat di `via`).

API key OpenRouter wajib tersedia lewat UI atau env jika fiturnya dipakai.
Pengaturan lainnya memiliki default di kode.

| Variabel | Wajib? | Default | Keterangan |
|---|---|---|---|
| `OPENROUTER_API_KEY` | Jika key belum diisi di UI untuk `openrouter` / `vision_llm` | — | Ambil di openrouter.ai/keys |
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
| POST | `/api/process?provider=auto&bubble=1&ocrEngine=tesseract&cleanMode=text&mode=translate` | multipart `files` (+ field `provider`/`bubble`/`ocrEngine`/`cleanMode`/`mode` opsional, menang atas env) |
| GET | `/api/outputs/<jobId>/<file>` | file hasil (png/zip/pdf) |
| GET | `/api/jobs/<jobId>/editor?file=<file>` | data editor: ukuran, mask, goresan, font, kotak teks, URL asli/hasil/pratinjau teks |
| GET | `/api/jobs/<jobId>/source?file=<file>` | halaman asli (sebelum ditimpa) untuk background editor |
| GET | `/api/jobs/<jobId>/textbase?file=<file>` | halaman dasar workspace teks (mask + goresan, tanpa teks terjemahan) |
| POST | `/api/jobs/<jobId>/mask` | body `{ file, strokes, autoMaskEdits?, textOverrides?: [{ index, x, y, w, h }], font?: { family, bold, scale }, fontScope?: "page" \| "all" }`; render ulang dari halaman asli lalu perbarui ZIP/PDF (`fontScope: all` merender semua halaman) |

Respons `pages[]` memuat `via` (`yolo-ogkalu` / `yolo-psimera` /
`ocr-full`), `bubbleCount`, `undetected` (bubble tanpa teks OCR), dan `boxes`.

### 2.5 Catatan produksi

- Route `POST /api/process` memakai `runtime = "nodejs"` + `maxDuration = 300`.
  Jangan deploy ke serverless dengan timeout kecil; disarankan VPS/Docker
  dengan `npm run build && npm start`.
- Hasil tersimpan di folder lokal `outputs/` dan diserve lewat
  `/api/outputs/...`. Di lingkungan ephemeral (serverless) pindahkan ke Blob/S3.
- `sharp` didaftarkan di `serverExternalPackages` di `next.config.ts`.

### 2.6 Batasan v1

- Pembersihan mengikuti kontur/garis yang berhasil ditemukan (bukan inpaint AI).
  Mode `text` (default UI) menimpa **per baris/paragraf hasil OCR**, sehingga
  outline bubble dan ilustrasi tetap utuh. Mode `bubble` menimpa seluruh area
  bubble dengan warna kertas; mode `white` memakai putih. Tanpa deteksi bubble,
  mask kembali per kotak teks. Ilustrasi/tekstur yang menyatu dengan teks masih
  perlu diperiksa pada preview hasil.
- Bubble yang teksnya tidak terdeteksi **dibiarkan utuh** dan ditandai di UI.
  Gunakan **Koreksi mask** (brush/eraser, atau atur mask otomatis kuning) untuk
  menimpa manual; koreksi hanya menimpa area (tidak menambah teks terjemahan).
  Halaman asli untuk render ulang disimpan di folder job dan ikut terhapus saat
  TTL habis; koreksi tidak memperpanjang TTL.
- OCR = Tesseract.js. Kandidat bentuk/confidence buruk dilewati. Huruf stilasi / SFX
  masih bisa terlewat — cek preview. Mandarin Sederhana memakai `chi_sim`;
  untuk akurasi hanzi yang lebih baik pilih `vision_llm`/`google_vision`.
- Font terjemahan bisa dipilih di tab **Teks** (family, bold, skala 70–130%).
  Font utama harus tersedia di mesin server; kalau tidak ada, overlay memakai
  fallback CJK/sistem (PingFang/Noto/YaHei/DejaVu/Liberation) agar huruf tetap
  tampil. Posisi/ukuran tiap kotak teks disimpan per halaman.
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
    jobs/[jobId]/route.ts     # status/hapus job
    jobs/[jobId]/editor/route.ts  # data editor (mask, font, kotak teks)
    jobs/[jobId]/source/route.ts  # halaman asli untuk editor
    jobs/[jobId]/textbase/route.ts # halaman dasar workspace teks (tanpa teks)
    jobs/[jobId]/mask/route.ts    # render ulang + mask/font/kotak teks
    outputs/[jobId]/[file]/route.ts  # GET file hasil (pengganti express.static)
lib/
  ocr.ts            # sharp + tesseract.js
  ocrComicsPlus.ts  # engine alternatif FCENet+MASTER via Python (opsional)
  ocrVisionLLM.ts   # engine alternatif Vision LLM via OpenRouter (opsional)
  bubble.ts         # YOLO bubble via Python sidecar (sekali per job, fallback aman)
  translate.ts      # auto (Google gratis → MyMemory), openrouter, opencode
  overlay.ts        # sharp composite SVG
  fonts.ts          # daftar font terjemahan (dipakai client & server)
  textLayout.ts     # wrap & auto-fit teks (dipakai client & server)
  renderPage.ts     # render ulang satu halaman (dipakai mask & textbase)
  jobFiles.ts       # pembuatan ZIP/PDF (awal & setelah koreksi mask)
  renderStore.ts    # simpan halaman asli + metadata render per halaman
components/
  UploadForm.tsx  PageCard.tsx  MaskEditor.tsx  Downloads.tsx  types.ts
detector/       # sidecar Python YOLO (detect.py, requirements, README)
outputs/        # hasil per job (git-ignored, dibuat otomatis)
```
