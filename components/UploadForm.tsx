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
import type { ProcessResult } from "./types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface Props {
  onResult: (r: ProcessResult | null) => void;
  onStatus: (s: string) => void;
  disabled: boolean;
  setDisabled: (v: boolean) => void;
}

const ACCEPT = ".png,.jpg,.jpeg,.webp,.zip";

export default function UploadForm({
  onResult,
  onStatus,
  disabled,
  setDisabled,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState("auto");
  const [bubble, setBubble] = useState("ogkalu");
  const [ocrEngine, setOcrEngine] = useState("tesseract");
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);

  function syncFiles(list: FileList | File[] | null) {
    if (!list) return;
    const arr = Array.from(list).slice(0, 50);
    setFiles(arr);
    // sinkronkan ke input agar FormData tetap konsisten
    if (inputRef.current && arr.length) {
      const dt = new DataTransfer();
      arr.forEach((f) => dt.items.add(f));
      inputRef.current.files = dt.files;
    }
  }

  function removeFile(idx: number) {
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
        description: "Upload JPG/PNG (boleh banyak) atau ZIP berisi gambar.",
      });
      return;
    }
    const fd = new FormData();
    for (const f of Array.from(inputFiles)) fd.append("files", f);
    fd.append("provider", provider);
    fd.append("bubble", bubble);
    fd.append("ocrEngine", ocrEngine);
    setDisabled(true);
    onStatus("Memproses (OCR bisa 10-60 detik per halaman)...");
    onResult(null);
    try {
      const res = await fetch(
        "/api/process?provider=" +
          encodeURIComponent(provider) +
          "&bubble=" +
          encodeURIComponent(bubble) +
          "&ocrEngine=" +
          encodeURIComponent(ocrEngine),
        { method: "POST", body: fd }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || String(res.status));
      onStatus(`Selesai: ${data.pages.length} halaman`);
      toast.success(`Selesai: ${data.pages.length} halaman`, {
        description: `Provider ${data.provider ?? provider}`,
      });
      onResult(data as ProcessResult);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onStatus("Gagal: " + msg);
      toast.error("Gagal memproses", { description: msg });
    } finally {
      setDisabled(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <CloudUpload className="size-4" />
              Upload komik
            </CardTitle>
            <CardDescription>
              JPG / PNG / WEBP (maks 50 file) atau ZIP. Preview & translate
              muncul otomatis setelah diproses.
            </CardDescription>
          </div>
          {files.length > 0 && (
            <Badge variant="secondary">{files.length} file</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          role="button"
          tabIndex={0}
          aria-label="Area upload, klik atau drag file ke sini"
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            syncFiles(e.dataTransfer.files);
          }}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center transition-colors",
            dragOver
              ? "border-primary bg-accent"
              : "border-input bg-muted/40 hover:bg-muted/70"
          )}
        >
          <span className="bg-background flex size-10 items-center justify-center rounded-full border shadow-xs">
            <CloudUpload className="size-5" />
          </span>
          <p className="text-sm font-medium">
            Klik untuk pilih file atau drag & drop ke sini
          </p>
          <p className="text-muted-foreground text-xs">
            {ACCEPT} · tiap file diproses per halaman
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            onChange={(e) => syncFiles(e.target.files)}
            className="hidden"
          />
        </div>

        {files.length > 0 && (
          <ul className="grid gap-2 sm:grid-cols-2">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${f.size}-${i}`}
                className="bg-muted/50 flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs"
              >
                {f.name.toLowerCase().endsWith(".zip") ? (
                  <FileArchive className="size-4 shrink-0" />
                ) : (
                  <FileImage className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">
                  {f.name}
                </span>
                <span className="text-muted-foreground shrink-0">
                  {(f.size / 1024).toFixed(0)} KB
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(i);
                  }}
                  aria-label={`Hapus ${f.name}`}
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <Separator />

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              <Settings2 className="size-3.5" />
              Provider translate
            </Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pilih provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  auto (Google gratis → MyMemory)
                </SelectItem>
                <SelectItem value="openrouter">
                  openrouter (LLM, natural)
                </SelectItem>
                <SelectItem value="opencode">
                  opencode (server lokal)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Bubble YOLO</Label>
            <Select value={bubble} onValueChange={setBubble}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pilih model bubble" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ogkalu">ogkalu (barat + manga)</SelectItem>
                <SelectItem value="psimera">psimera (manga)</SelectItem>
                <SelectItem value="0">mati (OCR penuh)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>OCR engine</Label>
            <Select value={ocrEngine} onValueChange={setOcrEngine}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pilih OCR engine" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tesseract">
                  tesseract (default, cepat)
                </SelectItem>
                <SelectItem value="comics_text_plus">
                  comics_text_plus (perlu model)
                </SelectItem>
                <SelectItem value="vision_llm">
                  vision_llm (perlu API key)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-xs">
            {provider === "openrouter" || ocrEngine === "vision_llm"
              ? "Butuh OPENROUTER_API_KEY di .env — cek /api/health."
              : "Default auto + tesseract jalan tanpa API key."}
          </p>
          <Button
            onClick={handleProcess}
            disabled={disabled || files.length === 0}
            className="sm:min-w-40"
          >
            {disabled && <Loader2 className="animate-spin" />}
            {disabled ? "Memproses..." : "Proses sekarang"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
