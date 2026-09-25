"use client";

import { useEffect, useRef, useState } from "react";
import {
  CloudUpload,
  FileArchive,
  Info,
  Loader2,
  Settings2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { ProcessingSettings } from "./useJobSession";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
  settings: ProcessingSettings;
  onSettingsChange: (settings: ProcessingSettings) => void;
  onJobStarted: (jobId: string) => void;
  disabled: boolean;
}

const ACCEPT = ".png,.jpg,.jpeg,.webp,.zip,.rar";

function fileSize(size: number) {
  return size < 1024 * 1024
    ? `${Math.max(1, Math.round(size / 1024))} KB`
    : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function isPreviewable(name: string) {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
}

function FileThumb({
  file,
  onRemove,
  disabled,
  leaving,
}: {
  file: File;
  onRemove: () => void;
  disabled: boolean;
  leaving: boolean;
}) {
  // Blob URL dibuat di dalam effect (bukan saat render) agar selamat dari
  // StrictMode dev yang menjalankan cleanup effect tepat setelah mount.
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isPreviewable(file.name)) return;
    const next = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
    };
  }, [file]);

  return (
    <div
      className={`group relative size-28 shrink-0 overflow-hidden rounded-lg border bg-muted ${
        leaving
          ? "animate-out fade-out-0 zoom-out-95 duration-180"
          : "animate-in fade-in-0 zoom-in-95 duration-200"
      }`}
    >
      {url ? (
        // blob URL pratinjau lokal, tidak lewat next/image
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={`Pratinjau ${file.name}`}
          loading="lazy"
          className="size-full object-contain"
        />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-1 p-2">
          <FileArchive aria-hidden="true" className="text-muted-foreground size-6" />
          <span className="text-muted-foreground w-full truncate text-center text-[10px]">
            Arsip
          </span>
        </div>
      )}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-[10px] text-white"
        title={`${file.name} · ${fileSize(file.size)}`}
      >
        {file.name}
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Hapus ${file.name}`}
        className="bg-background absolute top-1 right-1 flex size-6 items-center justify-center rounded-full border shadow-sm transition-opacity hover:bg-accent disabled:opacity-50 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export default function UploadForm({
  settings,
  onSettingsChange,
  onJobStarted,
  disabled: sessionBusy,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const removeTimers = useRef<number[]>([]);
  const [uploading, setUploading] = useState(false);
  const disabled = sessionBusy || uploading;
  const { provider, bubble, ocrEngine, apiKey } = settings;
  const setProvider = (provider: string) => onSettingsChange({ ...settings, provider });
  const setBubble = (bubble: string) => onSettingsChange({ ...settings, bubble });
  const setOcrEngine = (ocrEngine: string) => onSettingsChange({ ...settings, ocrEngine });
  const setApiKey = (apiKey: string) => onSettingsChange({ ...settings, apiKey });
  const [showApiKey, setShowApiKey] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [leaving, setLeaving] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);

  // Bersihkan timer hapus yang belum tuntas saat form dilepas.
  useEffect(() => {
    const timers = removeTimers.current;
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  function syncFiles(list: FileList | File[] | null) {
    if (!list || disabled) return;
    const arr = Array.from(list).slice(0, 50);
    if (list.length > 50) {
      toast.warning("Maksimal 50 file", {
        description: "Hanya 50 file pertama yang ditambahkan.",
      });
    }
    removeTimers.current.forEach((t) => window.clearTimeout(t));
    removeTimers.current = [];
    setLeaving([]);
    setFiles(arr);
  }

  function removeFile(idx: number) {
    if (disabled) return;
    const target = files[idx];
    if (!target || leaving.includes(target)) return;
    // Mainkan animasi keluar dulu, kartu benar-benar dibuang setelahnya.
    setLeaving((prev) => [...prev, target]);
    const timer = window.setTimeout(() => {
      setFiles((prev) => prev.filter((f) => f !== target));
      setLeaving((prev) => prev.filter((f) => f !== target));
    }, 180);
    removeTimers.current.push(timer);
  }

  async function handleProcess() {
    if (disabled || submitting.current) return;
    if (!files.length) {
      toast.error("Pilih file dulu", {
        description: "Upload JPG/PNG (boleh banyak) atau ZIP/RAR berisi gambar.",
      });
      return;
    }
    const form = new FormData();
    for (const file of files) form.append("files", file);
    form.append("provider", provider);
    form.append("bubble", bubble);
    form.append("ocrEngine", ocrEngine);
    if ((provider === "openrouter" || ocrEngine === "vision_llm") && apiKey.trim()) {
      form.append("apiKey", apiKey.trim());
    }
    submitting.current = true;
    setUploading(true);
    try {
      const response = await fetch("/api/jobs", { method: "POST", body: form });
      const started = await response.json();
      if (!response.ok) throw new Error(started.error || String(response.status));
      if (typeof started.jobId !== "string" || !/^[a-z0-9]+$/i.test(started.jobId)) {
        throw new Error("Server tidak mengembalikan jobId yang valid");
      }
      onJobStarted(started.jobId);
    } catch (error) {
      toast.error("Gagal memproses", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      submitting.current = false;
      setUploading(false);
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
          JPG, PNG, WEBP, ZIP, RAR
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

      {/* Selalu mount agar tinggi mengembang/menyusut mulus; -mt-4 saat
          tertutup menetralkan margin space-y parent sehingga tak ada gap sisa. */}
      <div
        className={`grid transition-all duration-300 ease-out ${
          files.length > 0 ? "grid-rows-[1fr] opacity-100" : "-mt-4 grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="min-h-0 overflow-hidden border rounded-xl p-4">
          <div className="space-y-2 pb-1">
            <p className="text-muted-foreground text-xs text-center">
              {files.length} file dipilih
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {files.map((f, i) => (
                <FileThumb
                  key={`${f.name}-${f.size}-${i}`}
                  file={f}
                  disabled={disabled}
                  leaving={leaving.includes(f)}
                  onRemove={() => removeFile(i)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <section aria-label="Detail pemrosesan" className="space-y-4">
        <div className="flex min-w-0 items-center gap-3">
          <Settings2 aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
          <span className="block text-sm font-medium">Detail pemrosesan</span>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="provider">Penerjemah</Label>
                <Select value={provider} onValueChange={setProvider} disabled={disabled}>
                  <SelectTrigger id="provider" className="h-11 w-full">
                    <SelectValue placeholder="Pilih penerjemah" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex items-center gap-3"><span>Otomatis</span><OsBadges mac win /></div>
                        <div className="select-item-desc text-muted-foreground text-xs font-normal">Google gratis, lalu MyMemory bila perlu.</div>
                      </div>
                    </SelectItem>
                    <SelectItem value="openrouter">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex items-center gap-3"><span>OpenRouter</span><OsBadges mac win /></div>
                        <div className="select-item-desc text-muted-foreground text-xs font-normal">Terjemahan LLM dengan API key.</div>
                      </div>
                    </SelectItem>
                    <SelectItem value="opencode">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex items-center gap-3"><span>OpenCode</span><OsBadges mac win /></div>
                        <div className="select-item-desc text-muted-foreground text-xs font-normal">Memakai server OpenCode lokal.</div>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bubble" className="flex items-center gap-1.5">
                  Deteksi bubble
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="Info deteksi bubble"
                        className="text-muted-foreground hover:text-foreground cursor-help rounded-full"
                      >
                        <Info aria-hidden="true" className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-60">
                      Cari di mana balon teksnya (YOLO). Tidak membaca tulisan,
                      hanya menandai area bubble agar OCR lebih akurat.
                    </TooltipContent>
                  </Tooltip>
                </Label>
                <Select value={bubble} onValueChange={setBubble} disabled={disabled}>
                  <SelectTrigger id="bubble" className="h-11 w-full">
                    <SelectValue placeholder="Pilih model bubble" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ogkalu">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex items-center gap-3"><span>Ogkalu</span><OsBadges mac win /></div>
                        <div className="select-item-desc text-muted-foreground text-xs font-normal">Untuk komik barat dan manga.</div>
                      </div>
                    </SelectItem>
                    <SelectItem value="psimera">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex items-center gap-3"><span>Psimera</span><OsBadges mac win /></div>
                        <div className="select-item-desc text-muted-foreground text-xs font-normal">Khusus halaman manga.</div>
                      </div>
                    </SelectItem>
                    <SelectItem value="0">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex items-center gap-3"><span>Matikan</span><OsBadges mac win /></div>
                        <div className="select-item-desc text-muted-foreground text-xs font-normal">OCR seluruh halaman, tanpa deteksi.</div>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ocr-engine" className="flex items-center gap-1.5">
                  Mesin OCR
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="Info mesin OCR"
                        className="text-muted-foreground hover:text-foreground cursor-help rounded-full"
                      >
                        <Info aria-hidden="true" className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-60">
                      Baca apa tulisannya di dalam bubble (Tesseract, Comics
                      Text Plus, Vision LLM). Output berupa teks + kotak kata.
                    </TooltipContent>
                  </Tooltip>
                </Label>
                <Select value={ocrEngine} onValueChange={setOcrEngine} disabled={disabled}>
                  <SelectTrigger id="ocr-engine" className="h-11 w-full">
                    <SelectValue placeholder="Pilih mesin OCR" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tesseract">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex items-center gap-3"><span>Tesseract</span><OsBadges mac win /></div>
                        <div className="select-item-desc text-muted-foreground text-xs font-normal">Bawaan, tanpa API key.</div>
                      </div>
                    </SelectItem>
                    <SelectItem value="comics_text_plus">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex items-center gap-3"><span>Comics Text Plus</span><OsBadges mac={false} win /></div>
                        <div className="select-item-desc text-muted-foreground text-xs font-normal">Perlu model lokal.</div>
                      </div>
                    </SelectItem>
                    <SelectItem value="vision_llm">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex items-center gap-3"><span>Vision LLM</span><OsBadges mac win /></div>
                        <div className="select-item-desc text-muted-foreground text-xs font-normal">Perlu API key OpenRouter.</div>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
      </section>

      {(provider === "openrouter" || ocrEngine === "vision_llm") && (
        <div className="space-y-2">
          <Label htmlFor="openrouter-api-key">API key OpenRouter</Label>
          <div className="flex gap-2">
            <Input
              id="openrouter-api-key"
              type={showApiKey ? "text" : "password"}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-or-v1-..."
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              className="h-11 min-w-0 flex-1"
            />
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => setShowApiKey(!showApiKey)}
              aria-controls="openrouter-api-key"
              aria-pressed={showApiKey}
              disabled={disabled}
            >
              {showApiKey ? "Sembunyikan" : "Tampilkan"}
            </Button>
          </div>
        </div>
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
