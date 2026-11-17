"use client";

import { useState } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  CircleAlert,
  Eraser,
  Eye,
  EyeOff,
  Info,
  Languages,
  Loader2,
  Settings2,
} from "lucide-react";
import type { ProcessingSettings } from "./useJobSession";
import { APP_LANGS, LANG_LABEL, type AppLang } from "@/lib/languages";
import type { CleanMode, ProcessMode } from "@/lib/cleanMode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { OsBadges } from "@/components/OsIcons";
import { cn } from "@/lib/utils";

function InfoHint({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="text-muted-foreground hover:text-foreground cursor-help"
        >
          <Info aria-hidden="true" className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-60">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

interface Props {
  settings: ProcessingSettings;
  onSettingsChange: (settings: ProcessingSettings) => void;
  fileCount: number;
  busy: boolean;
  uploading: boolean;
  hasResult: boolean;
  progressPercent: number;
  onProcess: () => void;
}

export default function ControlPanel({
  settings,
  onSettingsChange,
  fileCount,
  busy,
  uploading,
  hasResult,
  progressPercent,
  onProcess,
}: Props) {
  const {
    provider,
    bubble,
    ocrEngine,
    apiKey,
    googleApiKey,
    sourceLang,
    targetLang,
    cleanMode,
    mode,
  } = settings;

  const [showApiKey, setShowApiKey] = useState(false);
  const [showGoogleApiKey, setShowGoogleApiKey] = useState(false);

  const patch = (next: Partial<ProcessingSettings>) =>
    onSettingsChange({ ...settings, ...next });

  const cleanOnly = mode === "clean";
  const locked = busy || uploading;
  const cleanBubbleInvalid = cleanOnly && (bubble === "0" || bubble === "google");
  const sameLang = !cleanOnly && sourceLang === targetLang;
  const needsOpenRouterKey =
    !cleanOnly && (provider === "openrouter" || ocrEngine === "vision_llm");
  const needsGoogleKey = !cleanOnly && ocrEngine === "google_vision";

  const canProcess =
    fileCount > 0 && !locked && !cleanBubbleInvalid && !sameLang;
  const percent = Math.min(100, Math.max(0, Math.round(progressPercent)));

  const ctaLabel = uploading
    ? "Mengunggah…"
    : busy
      ? `Memproses ${percent}%`
      : cleanOnly
        ? "Bersihkan bubble"
        : "Proses komik";

  return (
    <aside aria-labelledby="panel-title" className="min-w-0 lg:sticky lg:top-20">
      <div className="panel overflow-hidden">
        <div className="bg-muted/30 border-b px-5 py-4">
          <h2 id="panel-title" className="font-mono text-[11px] font-medium uppercase tracking-[0.18em]">
            Panel kendali
          </h2>
        </div>

        <div className="divide-y">
          <section aria-label="Bahasa" className="space-y-3 p-5">
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2">
              <div className="min-w-0 space-y-1.5">
                <Label
                  htmlFor="source-lang"
                  className="text-muted-foreground text-[11px] font-normal"
                >
                  Dari
                </Label>
                <Select
                  value={sourceLang}
                  onValueChange={(value) => patch({ sourceLang: value as AppLang })}
                  disabled={locked || cleanOnly}
                >
                  <SelectTrigger id="source-lang" className="h-10 w-full text-xs">
                    <SelectValue placeholder="Bahasa sumber" />
                  </SelectTrigger>
                  <SelectContent>
                    {APP_LANGS.map((lang) => (
                      <SelectItem key={lang} value={lang}>
                        {LANG_LABEL[lang]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-10"
                    onClick={() =>
                      patch({ sourceLang: targetLang, targetLang: sourceLang })
                    }
                    disabled={locked || cleanOnly}
                    aria-label="Tukar bahasa sumber dan target"
                  >
                    <ArrowLeftRight className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Tukar bahasa</TooltipContent>
              </Tooltip>
              <div className="min-w-0 space-y-1.5">
                <Label
                  htmlFor="target-lang"
                  className="text-muted-foreground text-[11px] font-normal"
                >
                  Ke
                </Label>
                <Select
                  value={targetLang}
                  onValueChange={(value) => patch({ targetLang: value as AppLang })}
                  disabled={locked || cleanOnly}
                >
                  <SelectTrigger id="target-lang" className="h-10 w-full text-xs">
                    <SelectValue placeholder="Bahasa target" />
                  </SelectTrigger>
                  <SelectContent>
                    {APP_LANGS.map((lang) => (
                      <SelectItem key={lang} value={lang}>
                        {LANG_LABEL[lang]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </section>

          <section aria-label="Mode" className="space-y-3 p-5">
            <div
              role="group"
              aria-label="Mode proses"
              className="bg-muted/40 relative grid grid-cols-2 gap-1 border p-1"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "bg-foreground pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%_-_0.375rem)] transition-[translate,opacity] duration-200 ease-out",
                  cleanOnly ? "translate-x-[calc(100%_+_0.25rem)]" : "translate-x-0",
                  locked && "opacity-50"
                )}
              />
              {(
                [
                  { value: "translate", label: "Terjemah", icon: Languages },
                  { value: "clean", label: "Bersih", icon: Eraser },
                ] as const
              ).map((option) => {
                const active = mode === option.value;
                const Icon = option.icon;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => patch({ mode: option.value as ProcessMode })}
                    disabled={locked}
                    className={cn(
                      "relative z-10 flex h-9 items-center justify-center gap-1.5 text-xs font-medium transition-colors disabled:opacity-50",
                      active
                        ? "text-background font-semibold"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon aria-hidden="true" className="size-3.5" />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </section>

          <div>
            <Accordion type="single" collapsible>
              <AccordionItem value="advanced" className="border-none">
                <AccordionTrigger className="px-5 py-4 hover:no-underline">
                  <span className="flex items-center gap-2 text-left">
                    <Settings2
                      aria-hidden="true"
                      className="text-muted-foreground size-4"
                    />
                    <span className="font-mono text-[10px] font-medium uppercase tracking-[0.18em]">
                      Pengaturan lanjutan
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-5">
                  <div className="space-y-5">
                    <div className="space-y-1.5">
                      <Label
                        htmlFor="provider"
                        className="text-muted-foreground text-[11px] font-normal"
                      >
                        Penerjemah
                      </Label>
                      <Select
                        value={provider}
                        onValueChange={(value) => patch({ provider: value })}
                        disabled={locked || cleanOnly}
                      >
                        <SelectTrigger id="provider" className="h-10 w-full text-xs">
                          <SelectValue placeholder="Pilih penerjemah" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">
                            <span className="flex items-center gap-3">
                              Otomatis
                              <OsBadges mac win />
                            </span>
                          </SelectItem>
                          <SelectItem value="openrouter">
                            <span className="flex items-center gap-3">
                              OpenRouter
                              <OsBadges mac win />
                            </span>
                          </SelectItem>
                          <SelectItem value="opencode">
                            <span className="flex items-center gap-3">
                              OpenCode
                              <OsBadges mac win />
                            </span>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label
                        htmlFor="bubble"
                        className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-normal"
                      >
                        Deteksi bubble
                        <InfoHint label="Info deteksi bubble">
                          Cari di mana balon teksnya (YOLO, atau blok teks Google
                          bila bubble = Google). Tidak membaca tulisan, hanya
                          menandai area bubble agar OCR lebih akurat.
                        </InfoHint>
                      </Label>
                      <Select
                        value={bubble}
                        onValueChange={(value) => patch({ bubble: value })}
                        disabled={locked}
                      >
                        <SelectTrigger id="bubble" className="h-10 w-full text-xs">
                          <SelectValue placeholder="Pilih model bubble" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ogkalu">
                            <span className="flex items-center gap-3">
                              Ogkalu
                              <OsBadges mac win />
                            </span>
                          </SelectItem>
                          <SelectItem value="psimera">
                            <span className="flex items-center gap-3">
                              Psimera
                              <OsBadges mac win />
                            </span>
                          </SelectItem>
                          <SelectItem value="google">
                            <span className="flex items-center gap-3">
                              Google
                              <OsBadges mac win />
                            </span>
                          </SelectItem>
                          <SelectItem value="0">
                            <span className="flex items-center gap-3">
                              Matikan
                              <OsBadges mac win />
                            </span>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label
                        htmlFor="ocr-engine"
                        className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-normal"
                      >
                        Mesin OCR
                        <InfoHint label="Info mesin OCR">
                          Baca apa tulisannya di dalam bubble (Tesseract, Vision
                          LLM, Google Vision). Output berupa teks + kotak kata.
                        </InfoHint>
                      </Label>
                      <Select
                        value={ocrEngine}
                        onValueChange={(value) => patch({ ocrEngine: value })}
                        disabled={locked || cleanOnly}
                      >
                        <SelectTrigger
                          id="ocr-engine"
                          className="h-10 w-full text-xs"
                        >
                          <SelectValue placeholder="Pilih mesin OCR" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="tesseract">
                            <span className="flex items-center gap-3">
                              Tesseract
                              <OsBadges mac win />
                            </span>
                          </SelectItem>
                          <SelectItem value="vision_llm">
                            <span className="flex items-center gap-3">
                              Vision LLM
                              <OsBadges mac win />
                            </span>
                          </SelectItem>
                          <SelectItem value="google_vision">
                            <span className="flex items-center gap-3">
                              Google Vision
                              <OsBadges mac win />
                            </span>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label
                        htmlFor="clean-mode"
                        className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-normal"
                      >
                        Bersih teks
                        <InfoHint label="Info pembersih teks">
                          Cara menutup teks asli sebelum teks terjemahan
                          ditempel. Mode per baris hanya menimpa baris hasil OCR
                          sehingga outline bubble tetap terlihat. Warna bubble
                          mengambil warna kertas dari gambar.
                        </InfoHint>
                      </Label>
                      <Select
                        value={cleanMode}
                        onValueChange={(value) =>
                          patch({ cleanMode: value as CleanMode })
                        }
                        disabled={locked}
                      >
                        <SelectTrigger
                          id="clean-mode"
                          className="h-10 w-full text-xs"
                        >
                          <SelectValue placeholder="Pilih mode pembersih" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="text">Per baris teks</SelectItem>
                          <SelectItem value="bubble">Warna bubble</SelectItem>
                          <SelectItem value="white">Putih (lama)</SelectItem>
                          <SelectItem value="none">Tanpa hapus</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {needsOpenRouterKey && (
                      <div className="space-y-1.5">
                        <Label
                          htmlFor="openrouter-api-key"
                          className="text-muted-foreground text-[11px] font-normal"
                        >
                          API key OpenRouter
                        </Label>
                        <div className="flex gap-2">
                          <Input
                            id="openrouter-api-key"
                            type={showApiKey ? "text" : "password"}
                            value={apiKey}
                            onChange={(event) =>
                              patch({ apiKey: event.target.value })
                            }
                            placeholder="sk-or-v1-..."
                            autoComplete="off"
                            spellCheck={false}
                            disabled={locked}
                            className="h-10 min-w-0 flex-1 text-xs"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="size-10"
                            onClick={() => setShowApiKey(!showApiKey)}
                            aria-controls="openrouter-api-key"
                            aria-pressed={showApiKey}
                            aria-label={
                              showApiKey ? "Sembunyikan API key" : "Tampilkan API key"
                            }
                            disabled={locked}
                          >
                            {showApiKey ? (
                              <EyeOff className="size-4" />
                            ) : (
                              <Eye className="size-4" />
                            )}
                          </Button>
                        </div>
                      </div>
                    )}

                    {needsGoogleKey && (
                      <div className="space-y-1.5">
                        <Label
                          htmlFor="google-api-key"
                          className="text-muted-foreground text-[11px] font-normal"
                        >
                          API key Google Vision
                        </Label>
                        <div className="flex gap-2">
                          <Input
                            id="google-api-key"
                            type={showGoogleApiKey ? "text" : "password"}
                            value={googleApiKey ?? ""}
                            onChange={(event) =>
                              patch({ googleApiKey: event.target.value })
                            }
                            placeholder="AIza..."
                            autoComplete="off"
                            spellCheck={false}
                            disabled={locked}
                            className="h-10 min-w-0 flex-1 text-xs"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="size-10"
                            onClick={() =>
                              setShowGoogleApiKey(!showGoogleApiKey)
                            }
                            aria-controls="google-api-key"
                            aria-pressed={showGoogleApiKey}
                            aria-label={
                              showGoogleApiKey
                                ? "Sembunyikan API key Google"
                                : "Tampilkan API key Google"
                            }
                            disabled={locked}
                          >
                            {showGoogleApiKey ? (
                              <EyeOff className="size-4" />
                            ) : (
                              <Eye className="size-4" />
                            )}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        </div>

        <div className="bg-muted/20 space-y-3 border-t p-5">
          {(cleanBubbleInvalid || sameLang) && (
            <p
              role="alert"
              className="flex items-start gap-2 text-[11px] leading-relaxed"
            >
              <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              {cleanBubbleInvalid
                ? "Mode bersih butuh deteksi bubble Ogkalu atau Psimera."
                : "Bahasa sumber dan target sama — pilih pasangan berbeda."}
            </p>
          )}

          {busy && (
            <div
              className="bg-muted h-1 overflow-hidden"
              role="progressbar"
              aria-label="Progres pemrosesan"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div
                className="bg-foreground h-full transition-[width] duration-500"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}

          {hasResult ? (
            <Button asChild variant="outline" className="h-11 w-full">
              <a href="#hasil">
                <ArrowRight className="size-4" />
                Lihat hasil
              </a>
            </Button>
          ) : (
            <Button
              type="button"
              onClick={onProcess}
              disabled={!canProcess}
              className="h-11 w-full"
            >
              {uploading || busy ? (
                <Loader2 className="animate-spin" />
              ) : (
                <ArrowRight className="size-4" />
              )}
              {ctaLabel}
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}
