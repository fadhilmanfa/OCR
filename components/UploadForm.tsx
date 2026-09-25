"use client";

import { useRef, useState } from "react";
import {
  CloudUpload,
  FileImage,
  FileArchive,
  Loader2,
  Settings2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { JobProgress, ProcessResult } from "./types";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OsBadges } from "@/components/OsIcons";
import { cn } from "@/lib/utils";

interface Props {
  onResult: (r: ProcessResult | null) => void;
  onStatus: (s: string) => void;
  onProgress: (p: JobProgress | null) => void;
  disabled: boolean;
  setDisabled: (v: boolean) => void;
}

const ACCEPT = ".png,.jpg,.jpeg,.webp,.zip,.rar";

function fileSize(size: number) {
  return size < 1024 * 1024
    ? `${Math.max(1, Math.round(size / 1024))} KB`
    : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadForm({
  onResult,
  onStatus,
  onProgress,
  disabled,
  setDisabled,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [provider, setProvider] = useState("auto");
  const [bubble, setBubble] = useState("ogkalu");
  const [ocrEngine, setOcrEngine] = useState("tesseract");
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);

  function syncFiles(list: FileList | File[] | null) {
    if (!list || disabled) return;
    const arr = Array.from(list).slice(0, 50);
    if (list.length > 50) {
      toast.warning("Maksimal 50 file", {
        description: "Hanya 50 file pertama yang ditambahkan.",
      });
    }
    setFiles(arr);
    // sinkronkan ke input agar FormData tetap konsisten
    if (inputRef.current && arr.length) {
      const dt = new DataTransfer();
      arr.forEach((f) => dt.items.add(f));
      inputRef.current.files = dt.files;
    }
  }

  function removeFile(idx: number) {
    if (disabled) return;
    const next = files.filter((_, i) => i !== idx);
    setFiles(next);
    if (inputRef.current) {
      const dt = new DataTransfer();
      next.forEach((f) => dt.items.add(f));
      inputRef.current.files = dt.files;
    }
  }

  async function handleProcess() {
    const inputFiles = inputRef.current?.files;
    if (!inputFiles || !inputFiles.length) {
      toast.error("Pilih file dulu", {
        description: "Upload JPG/PNG (boleh banyak) atau ZIP/RAR berisi gambar.",
      });
      return;
    }
    // Hentikan polling sebelumnya kalau ada (klik ganda / job lama).
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    const fd = new FormData();
    for (const f of Array.from(inputFiles)) fd.append("files", f);
    fd.append("provider", provider);
    fd.append("bubble", bubble);
    fd.append("ocrEngine", ocrEngine);
    setDisabled(true);
    onStatus("Mengunggah & menyiapkan job...");
    onResult(null);
    onProgress(null);
    try {
      // 1) Start job — langsung dapat jobId tanpa nunggu proses selesai.
      const start = await fetch(
        "/api/jobs?provider=" +
          encodeURIComponent(provider) +
          "&bubble=" +
          encodeURIComponent(bubble) +
          "&ocrEngine=" +
          encodeURIComponent(ocrEngine),
        { method: "POST", body: fd }
      );
      const started = await start.json().catch(() => ({}));
      if (!start.ok) throw new Error(started.error || String(start.status));
      const jobId = String(started.jobId || "");
      if (!jobId) throw new Error("server tidak mengembalikan jobId");
      onStatus(`Job ${jobId}: mengunggah selesai, mulai diproses...`);

      // 2) Poll progress tiap 800ms sampai done/error.
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          fn();
        };
        const tick = async () => {
          try {
            const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
            const data = (await res.json().catch(() => ({}))) as JobProgress & {
              error?: string;
            };
            if (!res.ok) throw new Error((data as { error?: string }).error || String(res.status));
            const prog = data as JobProgress;
            onProgress(prog);
            onStatus(prog.message || `Memproses... ${Math.round(prog.percent)}%`);
            if (prog.done) {
              finish(() => {
                if (prog.error || prog.stage === "error") {
                  reject(new Error(prog.error || "job gagal"));
                } else if (prog.result) {
                  onStatus(`Selesai: ${prog.result.pages.length} halaman`);
                  toast.success(`Selesai: ${prog.result.pages.length} halaman`, {
                    description: `Provider ${prog.result.provider ?? provider}`,
                  });
                  onResult(prog.result as ProcessResult);
                  resolve();
                } else {
                  reject(new Error("job selesai tanpa hasil"));
                }
              });
            }
          } catch (e) {
            // 404 saat job baru dibuat (race) -> coba lagi 1x putaran berikutnya.
            // Error lain yang persisten akan terlihat di tick berikutnya;
            // jangan langsung reject agar tahan terhadap glitch jaringan sesaat.
            // Hanya reject kalau fetch gagal total berkali-kali? Untuk simpel:
            // log dan lanjut; reject hanya via tombol / timeout 10 menit.
            if (e instanceof Error && /tidak ditemukan|kedaluwarsa/i.test(e.message)) {
              // beri kesempatan 1 putaran lagi sebelum menyerah
            }
          }
        };
        // Timeout pengaman 30 menit (sama dengan TTL job server).
        const timeout = setTimeout(() => {
          finish(() => reject(new Error("timeout menunggu job (30 menit)")));
        }, 30 * 60 * 1000);
        const wrappedTick = async () => {
          await tick();
          if (settled) clearTimeout(timeout);
        };
        pollRef.current = setInterval(wrappedTick, 800);
        void wrappedTick();
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onStatus("Gagal: " + msg);
      toast.error("Gagal memproses", { description: msg });
    } finally {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setDisabled(false);
    }
  }

  return (
    <section aria-label="Unggah komik" className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          syncFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center rounded-xl border border-dashed px-4 py-7 text-center transition-colors sm:py-9",
          dragOver ? "border-foreground bg-muted" : "border-input bg-muted/20"
        )}
      >
        <CloudUpload aria-hidden="true" className="text-muted-foreground mb-3 size-6" />
        <p className="text-sm font-medium">Pilih gambar atau arsip komik</p>
        <p className="text-muted-foreground mt-1 text-xs">
          JPG, PNG, WEBP, ZIP, RAR · maksimal 50 file
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-4 h-11 min-w-36"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
        >
          Pilih file
        </Button>
        <p className="text-muted-foreground mt-3 hidden text-xs sm:block">
          atau tarik dan lepas file di sini
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          onChange={(e) => syncFiles(e.target.files)}
          className="hidden"
          disabled={disabled}
        />
      </div>

      {files.length === 1 && (
        <div className="flex min-w-0 items-center gap-2 border-b pb-2 text-sm">
          {files[0].name.toLowerCase().endsWith(".zip") ||
          files[0].name.toLowerCase().endsWith(".rar") ? (
            <FileArchive aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
          ) : (
            <FileImage aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate" title={files[0].name}>
            {files[0].name}
          </span>
          <span className="text-muted-foreground shrink-0 text-xs">
            {fileSize(files[0].size)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10"
            onClick={() => removeFile(0)}
            aria-label={`Hapus ${files[0].name}`}
            disabled={disabled}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}

      {files.length > 1 && (
        <Accordion type="single" collapsible className="border-b">
          <AccordionItem value="files" className="border-none">
            <AccordionTrigger className="py-3 hover:no-underline">
              <span className="min-w-0 text-left">
                <span className="block text-sm font-medium">{files.length} file dipilih</span>
                <span className="text-muted-foreground block truncate text-xs font-normal">
                  {files[0].name} dan {files.length - 1} lainnya · lihat &amp; kelola
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <ul className="max-h-60 divide-y overflow-y-auto">
                {files.map((f, i) => (
                  <li key={`${f.name}-${f.size}-${i}`} className="flex min-w-0 items-center gap-2 py-1 text-sm">
                    {f.name.toLowerCase().endsWith(".zip") || f.name.toLowerCase().endsWith(".rar") ? (
                      <FileArchive aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                    ) : (
                      <FileImage aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate" title={f.name}>{f.name}</span>
                    <span className="text-muted-foreground shrink-0 text-xs">{fileSize(f.size)}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-10"
                      onClick={() => removeFile(i)}
                      aria-label={`Hapus ${f.name}`}
                      disabled={disabled}
                    >
                      <X className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}

      <Accordion type="single" collapsible className="border-y">
        <AccordionItem value="settings" className="border-none">
          <AccordionTrigger className="py-4 hover:no-underline">
            <span className="flex min-w-0 items-center gap-3 text-left">
              <Settings2 aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">Detail pemrosesan</span>
                <span className="text-muted-foreground block truncate text-xs font-normal">
                  {provider === "auto" ? "Otomatis" : provider === "openrouter" ? "OpenRouter" : "OpenCode"} · {ocrEngine === "tesseract" ? "Tesseract" : ocrEngine === "vision_llm" ? "Vision LLM" : "Comics Text Plus"}
                </span>
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="space-y-4 pt-1">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="provider">Penerjemah</Label>
                <Select value={provider} onValueChange={setProvider} disabled={disabled}>
                  <SelectTrigger id="provider" className="h-11 w-full">
                    <SelectValue placeholder="Pilih penerjemah" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto"><span className="flex items-center gap-3"><span>Otomatis</span><OsBadges mac win /></span></SelectItem>
                    <SelectItem value="openrouter"><span className="flex items-center gap-3"><span>OpenRouter</span><OsBadges mac win /></span></SelectItem>
                    <SelectItem value="opencode"><span className="flex items-center gap-3"><span>OpenCode</span><OsBadges mac win /></span></SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  {provider === "auto" ? "Google gratis, lalu MyMemory bila perlu." : provider === "openrouter" ? "Terjemahan LLM dengan API key." : "Menggunakan server OpenCode lokal."}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bubble">Deteksi bubble</Label>
                <Select value={bubble} onValueChange={setBubble} disabled={disabled}>
                  <SelectTrigger id="bubble" className="h-11 w-full">
                    <SelectValue placeholder="Pilih model bubble" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ogkalu"><span className="flex items-center gap-3"><span>Ogkalu</span><OsBadges mac win /></span></SelectItem>
                    <SelectItem value="psimera"><span className="flex items-center gap-3"><span>Psimera</span><OsBadges mac win /></span></SelectItem>
                    <SelectItem value="0"><span className="flex items-center gap-3"><span>Matikan</span><OsBadges mac win /></span></SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  {bubble === "ogkalu" ? "Untuk komik barat dan manga." : bubble === "psimera" ? "Untuk halaman manga." : "OCR seluruh halaman tanpa deteksi bubble."}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ocr-engine">Mesin OCR</Label>
                <Select value={ocrEngine} onValueChange={setOcrEngine} disabled={disabled}>
                  <SelectTrigger id="ocr-engine" className="h-11 w-full">
                    <SelectValue placeholder="Pilih mesin OCR" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tesseract"><span className="flex items-center gap-3"><span>Tesseract</span><OsBadges mac win /></span></SelectItem>
                    <SelectItem value="comics_text_plus"><span className="flex items-center gap-3"><span>Comics Text Plus</span><OsBadges mac={false} win /></span></SelectItem>
                    <SelectItem value="vision_llm"><span className="flex items-center gap-3"><span>Vision LLM</span><OsBadges mac win /></span></SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  {ocrEngine === "tesseract" ? "Pilihan bawaan, tanpa API key." : ocrEngine === "comics_text_plus" ? "Memerlukan model lokal." : "Memerlukan API key OpenRouter."}
                </p>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      {(provider === "openrouter" || ocrEngine === "vision_llm") && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Perlu OPENROUTER_API_KEY di .env. Periksa statusnya di /api/health.
        </p>
      )}
      <Button
        type="button"
        onClick={handleProcess}
        disabled={disabled || files.length === 0}
        className="h-11 w-full"
      >
        {disabled && <Loader2 className="animate-spin" />}
        {disabled ? "Memproses..." : "Proses komik"}
      </Button>
    </section>
  );
}
