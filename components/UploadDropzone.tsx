"use client";

import { useEffect, useRef, useState } from "react";
import { CloudUpload, FileArchive, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ACCEPT = ".png,.jpg,.jpeg,.webp,.zip,.rar";

function fileSize(size: number) {
  if (size < 1024) return `${size} B`;
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
      className={cn(
        "group bg-muted relative size-24 shrink-0 overflow-hidden border sm:size-28",
        leaving
          ? "animate-out fade-out-0 zoom-out-95 duration-180"
          : "animate-in fade-in-0 zoom-in-95 duration-200"
      )}
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
        className="bg-background absolute top-1 right-1 flex size-6 items-center justify-center border transition-opacity hover:bg-accent disabled:opacity-50 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

interface Props {
  files: File[];
  leaving: File[];
  totalBytes: number;
  disabled: boolean;
  onAdd: (list: FileList | File[] | null) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
}

export default function UploadDropzone({
  files,
  leaving,
  totalBytes,
  disabled,
  onAdd,
  onRemove,
  onClear,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Tempel gambar langsung dari clipboard (Ctrl+V) selama belum ada job.
  useEffect(() => {
    if (disabled) return;
    function onPaste(event: ClipboardEvent) {
      const pasted = event.clipboardData?.files;
      if (!pasted || !pasted.length) return;
      event.preventDefault();
      onAdd(pasted);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [disabled, onAdd]);

  return (
    <section aria-labelledby="input-title" className="min-w-0 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="input-title" className="eyebrow flex items-center gap-2">
          <span aria-hidden="true">[01]</span>
          Input
        </h2>
        <span className="text-muted-foreground font-mono text-[10px] uppercase tracking-[0.14em]">
          Maks. 50 file
        </span>
      </div>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          onAdd(event.dataTransfer.files);
        }}
        className={cn(
          "panel p-1.5 transition-colors",
          dragOver && "border-foreground"
        )}
      >
        <div
          className={cn(
            "flex flex-col items-center border border-dashed px-4 py-9 text-center transition-colors sm:py-12",
            dragOver ? "border-foreground bg-muted" : "border-input bg-muted/20"
          )}
        >
          <span className="bg-background flex size-11 items-center justify-center border">
            <CloudUpload aria-hidden="true" className="size-5" />
          </span>
          <p className="mt-4 text-sm font-semibold">Tarik file ke sini</p>
          <p className="text-muted-foreground mt-1 text-xs">
            atau tempel dengan{" "}
            <kbd className="bg-background border px-1 py-0.5 font-mono text-[10px]">
              Ctrl
            </kbd>{" "}
            +{" "}
            <kbd className="bg-background border px-1 py-0.5 font-mono text-[10px]">
              V
            </kbd>
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-5 h-10 min-w-36"
            onClick={() => inputRef.current?.click()}
            disabled={disabled}
          >
            Pilih file
          </Button>
          <p className="text-muted-foreground mt-4 font-mono text-[10px] uppercase tracking-[0.14em]">
            JPG · PNG · WEBP · ZIP · RAR
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            onChange={(event) => {
              onAdd(event.target.files);
              // Reset agar file yang sama bisa dipilih ulang.
              event.target.value = "";
            }}
            className="hidden"
            disabled={disabled}
          />
        </div>
      </div>

      {/* Selalu mount agar tinggi mengembang/menyusut mulus; -mt-4 saat
          tertutup menetralkan margin space-y parent sehingga tak ada gap sisa. */}
      <div
        className={cn(
          "grid transition-all duration-300 ease-out",
          files.length > 0
            ? "grid-rows-[1fr] opacity-100"
            : "-mt-4 grid-rows-[0fr] opacity-0"
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="panel p-4">
            <div className="flex items-center justify-between gap-3">
              <p
                className="num text-muted-foreground font-mono text-[11px]"
                aria-live="polite"
              >
                {files.length} file · {fileSize(totalBytes)}
              </p>
              <button
                type="button"
                onClick={onClear}
                disabled={disabled}
                className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-4 transition-colors hover:underline disabled:opacity-50"
              >
                Hapus semua
              </button>
            </div>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {files.map((file, index) => (
                <FileThumb
                  key={`${file.name}-${file.size}-${index}`}
                  file={file}
                  disabled={disabled}
                  leaving={leaving.includes(file)}
                  onRemove={() => onRemove(index)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
