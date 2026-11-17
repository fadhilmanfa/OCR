"use client";

import { useEffect, useRef, useState } from "react";
import { CloudUpload, FileArchive, Plus, Trash2, X } from "lucide-react";
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
  enterDelay = 0,
}: {
  file: File;
  onRemove: () => void;
  disabled: boolean;
  leaving: boolean;
  enterDelay?: number;
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
      style={
        leaving || enterDelay <= 0
          ? undefined
          : { animationDelay: `${enterDelay}ms` }
      }
      className={cn(
        "group bg-muted relative h-24 w-full shrink-0 overflow-hidden border sm:h-28",
        leaving
          ? "animate-out fade-out-0 zoom-out-95 duration-180"
          : "animate-in fade-in-0 zoom-in-95 fill-mode-both duration-200"
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
  addedFrom: number;
  disabled: boolean;
  onAdd: (list: FileList | File[] | null) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
}

export default function UploadDropzone({
  files,
  leaving,
  addedFrom,
  disabled,
  onAdd,
  onRemove,
  onClear,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dropTick, setDropTick] = useState(0);

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
        onDragLeave={(event) => {
          // Jangan matikan highlight saat kursor cuma pindah ke anak elemen.
          if (event.currentTarget.contains(event.relatedTarget as Node | null))
            return;
          setDragOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          setDropTick((tick) => tick + 1);
          onAdd(event.dataTransfer.files);
        }}
        className={cn(
          "panel p-1.5 transition-[scale,box-shadow,border-color] duration-200 ease-out",
          dragOver && "border-foreground scale-[1.01] shadow-sm"
        )}
      >
        <div
          className={cn(
            "relative border border-dashed px-4 transition-colors",
            files.length === 0
              ? "flex flex-col items-center py-9 text-center sm:py-12"
              : "py-4",
            dragOver ? "border-foreground bg-muted" : "border-input bg-muted/20"
          )}
        >
          {dropTick > 0 && (
            <span
              key={dropTick}
              aria-hidden="true"
              className="animate-drop-flash pointer-events-none absolute inset-0 border-2 border-foreground"
            />
          )}
          {files.length === 0 ? (
            <>
              <span
                className={cn(
                  "bg-background flex size-11 items-center justify-center border transition-[translate,scale] duration-200",
                  dragOver && "-translate-y-0.5 scale-105"
                )}
              >
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
            </>
          ) : (
            <div className="animate-in fade-in-0 duration-200">
              <div className="flex items-center justify-between gap-3">
                <p
                  className="num text-muted-foreground font-mono text-[11px]"
                  aria-live="polite"
                >
                  {files.length} file
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-8"
                    onClick={() => inputRef.current?.click()}
                    disabled={disabled}
                    aria-label="Tambah file"
                    title="Tambah file"
                  >
                    <Plus className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive size-8"
                    onClick={onClear}
                    disabled={disabled}
                    aria-label="Hapus semua file"
                    title="Hapus semua"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="mt-3 flex gap-0 overflow-x-auto pb-1">
                {files.map((file, index) => {
                  const isLeaving = leaving.includes(file);
                  return (
                    <div
                      key={`${file.name}-${file.size}-${file.lastModified}`}
                      className={cn(
                        "shrink-0 overflow-hidden transition-[width,padding-right,opacity] duration-200 ease-out",
                        isLeaving ? "w-0 pr-0 opacity-0" : "w-24 pr-2 sm:w-28"
                      )}
                    >
                      <FileThumb
                        file={file}
                        disabled={disabled}
                        leaving={isLeaving}
                        enterDelay={
                          index < addedFrom
                            ? 0
                            : Math.min(index - addedFrom, 8) * 30
                        }
                        onRemove={() => onRemove(index)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
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
    </section>
  );
}
