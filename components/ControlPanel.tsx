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
} from "lucide-react";
import type { ProcessingSettings } from "./useJobSession";
import { APP_LANGS, LANG_LABEL, LANG_SHORT, type AppLang } from "@/lib/languages";
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

const PROVIDER_LABEL: Record<string, string> = {
  auto: "Otomatis",
  openrouter: "OpenRouter",
  opencode: "OpenCode",
};

const BUBBLE_LABEL: Record<string, string> = {
  ogkalu: "Ogkalu",
  psimera: "Psimera",
  google: "Google",
  "0": "Tanpa deteksi",
};

const OCR_LABEL: Record<string, string> = {
  tesseract: "Tesseract",
  comics_text_plus: "Comics Text Plus",
  vision_llm: "Vision LLM",
  google_vision: "Google Vision",
};

const CLEAN_LABEL: Record<CleanMode, string> = {
  text: "Per baris teks",
  bubble: "Warna bubble",
  white: "Putih",
  none: "Tanpa hapus",
};

function FieldLabel({
  id,
  num,
  children,
}: {
  id: string;
  num: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        aria-hidden="true"
        className="text-muted-foreground font-mono text-[10px] tracking-[0.14em]"
      >
        [{num}]
      </span>
      <h3
        id={id}
        className="font-mono text-[10px] font-medium uppercase tracking-[0.18em]"
      >
        {children}
      </h3>
    </div>
  );
}

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

  const shortPair = `${LANG_SHORT[sourceLang]} → ${LANG_SHORT[targetLang]}`;
  const panelSummary = cleanOnly
    ? `Mode bersih · ${BUBBLE_LABEL[bubble] ?? bubble}`
    : `${shortPair} · ${OCR_LABEL[ocrEngine] ?? ocrEngine}`;

  const ctaLabel = uploading
    ? "Mengunggah…"
    : busy
      ? `Memproses ${percent}%`
      : cleanOnly
        ? "Bersihkan bubble"
        : "Proses komik";

  let helper: string;
  if (busy) {
    helper = "Halaman diproses satu per satu. Panel tetap bisa dibuka.";
  } else if (uploading) {
    helper = "File sedang dikirim ke server.";
  } else if (hasResult) {
    helper = "Hasil siap. Unduh di workspace, atau mulai baru untuk memproses lagi.";
  } else if (cleanBubbleInvalid) {
    helper = "Mode bersih butuh deteksi bubble Ogkalu atau Psimera.";
  } else if (sameLang) {
    helper = "Bahasa sumber dan target sama — pilih pasangan berbeda.";
  } else if (fileCount === 0) {
    helper = "Belum ada file. Tambahkan halaman komik di workspace.";
  } else {
    helper = `${fileCount} file · ${shortPair} · ${OCR_LABEL[ocrEngine] ?? ocrEngine} · ${CLEAN_LABEL[cleanMode]}`;
  }

  return (
    <aside aria-labelledby="panel-title" className="min-w-0 lg:sticky lg:top-20">
      <div className="panel overflow-hidden">
        <div className="bg-muted/30 flex items-center justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 id="panel-title" className="font-mono text-[11px] font-medium uppercase tracking-[0.18em]">
              Panel kendali
            </h2>
            <p className="text-muted-foreground mt-1 truncate font-mono text-[10px] uppercase tracking-[0.14em]">
              {panelSummary}
            </p>
          </div>
          <span
            aria-hidden="true"
            className={cn(
              "size-2 shrink-0 border border-current",
              busy && "bg-foreground animate-pulse",
              uploading && "bg-foreground animate-pulse",
              !busy && !uploading && hasResult && "bg-foreground",
              !busy && !uploading && !hasResult && "text-muted-foreground"
            )}
          />
          <span className="sr-only">
            {busy || uploading ? "Sedang memproses" : hasResult ? "Hasil siap" : "Siap"}
          </span>
        </div>

        <div className="divide-y">
          <section aria-labelledby="panel-lang" className="space-y-3 p-5">
            <FieldLabel id="panel-lang" num="01">
              Bahasa
            </FieldLabel>
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
            {cleanOnly && (
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                Mode bersih tidak memakai bahasa sumber maupun target.
              </p>
            )}
          </section>

          <section aria-labelledby="panel-mode" className="space-y-3 p-5">
            <FieldLabel id="panel-mode" num="02">
              Mode
            </FieldLabel>
            <div
              role="group"
              aria-label="Mode proses"
              className="bg-muted/40 grid grid-cols-2 gap-1 border p-1"
            >
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
                      "flex h-9 items-center justify-center gap-1.5 text-xs font-medium transition-colors disabled:opacity-50",
                      active
                        ? "bg-foreground text-background font-semibold"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon aria-hidden="true" className="size-3.5" />
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              {cleanOnly
                ? "Timpa seluruh bubble tanpa OCR dan terjemahan, untuk mengecek coverage."
                : "OCR → terjemah → timpa bubble → tempel teks terjemahan."}
            </p>
          </section>

          <div>
            <Accordion type="single" collapsible>
              <AccordionItem value="advanced" className="border-none">
                <AccordionTrigger className="px-5 py-4 text-xs hover:no-underline">
                  <span className="flex items-baseline gap-2 text-left">
                    <span
                      aria-hidden="true"
                      className="text-muted-foreground font-mono text-[10px] tracking-[0.14em]"
                    >
                      [03]
                    </span>
                    <span className="font-mono text-[10px] font-medium uppercase tracking-[0.18em]">
                      Pengaturan lanjutan
                    </span>
                  </span>
                </AccordionTrigger>
                <p className="text-muted-foreground -mt-1 px-5 pb-4 font-mono text-[10px] leading-relaxed uppercase tracking-[0.1em]">
                  {PROVIDER_LABEL[provider] ?? provider} ·{" "}
                  {BUBBLE_LABEL[bubble] ?? bubble} ·{" "}
                  {OCR_LABEL[ocrEngine] ?? ocrEngine} · {CLEAN_LABEL[cleanMode]}
                </p>
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
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <div className="flex items-center gap-3">
                                <span>Otomatis</span>
                                <OsBadges mac win />
                              </div>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                Google gratis, lalu MyMemory bila perlu.
                              </div>
                            </div>
                          </SelectItem>
                          <SelectItem value="openrouter">
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <div className="flex items-center gap-3">
                                <span>OpenRouter</span>
                                <OsBadges mac win />
                              </div>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                Terjemahan LLM dengan API key.
                              </div>
                            </div>
                          </SelectItem>
                          <SelectItem value="opencode">
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <div className="flex items-center gap-3">
                                <span>OpenCode</span>
                                <OsBadges mac win />
                              </div>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                Memakai server OpenCode lokal.
                              </div>
                            </div>
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
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <div className="flex items-center gap-3">
                                <span>Ogkalu</span>
                                <OsBadges mac win />
                              </div>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                Untuk komik barat dan manga.
                              </div>
                            </div>
                          </SelectItem>
                          <SelectItem value="psimera">
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <div className="flex items-center gap-3">
                                <span>Psimera</span>
                                <OsBadges mac win />
                              </div>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                Khusus halaman manga.
                              </div>
                            </div>
                          </SelectItem>
                          <SelectItem value="google">
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <div className="flex items-center gap-3">
                                <span>Google</span>
                                <OsBadges mac win />
                              </div>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                Dari blok teks Google Vision.
                              </div>
                            </div>
                          </SelectItem>
                          <SelectItem value="0">
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <div className="flex items-center gap-3">
                                <span>Matikan</span>
                                <OsBadges mac win />
                              </div>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                OCR seluruh halaman, tanpa deteksi.
                              </div>
                            </div>
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
                          Baca apa tulisannya di dalam bubble (Tesseract, Comics
                          Text Plus, Vision LLM, Google Vision). Output berupa
                          teks + kotak kata.
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
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <div className="flex items-center gap-3">
                                <span>Tesseract</span>
                                <OsBadges mac win />
                              </div>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                Bawaan, tanpa API key.
                              </div>
                            </div>
                          </SelectItem>
                          <SelectItem value="comics_text_plus">
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <div className="flex items-center gap-3">
                                <span>Comics Text Plus</span>
                                <OsBadges mac={false} win />
                              </div>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                Perlu model lokal.
                              </div>
                            </div>
                          </SelectItem>
                          <SelectItem value="vision_llm">
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <div className="flex items-center gap-3">
                                <span>Vision LLM</span>
                                <OsBadges mac win />
                              </div>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                Perlu API key OpenRouter.
                              </div>
                            </div>
                          </SelectItem>
                          <SelectItem value="google_vision">
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <div className="flex items-center gap-3">
                                <span>Google Vision</span>
                                <OsBadges mac win />
                              </div>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                Perlu API key Google (berbayar).
                              </div>
                            </div>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {sourceLang !== "en" && ocrEngine === "comics_text_plus" && (
                        <p className="text-muted-foreground text-[10px] leading-relaxed">
                          comics_text_plus hanya akurat untuk Inggris — otomatis
                          fallback ke Tesseract untuk {LANG_LABEL[sourceLang]}.
                        </p>
                      )}
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
                          <SelectItem value="text">
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <span>Per baris teks</span>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                Hanya baris OCR yang ditimpa; outline bubble
                                tetap utuh.
                              </div>
                            </div>
                          </SelectItem>
                          <SelectItem value="bubble">
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <span>Warna bubble</span>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                Ikut warna kertas dari gambar, tanpa bercak
                                putih.
                              </div>
                            </div>
                          </SelectItem>
                          <SelectItem value="white">
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <span>Putih (lama)</span>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                Mask putih solid, seperti versi sebelumnya.
                              </div>
                            </div>
                          </SelectItem>
                          <SelectItem value="none">
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <span>Tanpa hapus</span>
                              <div className="select-item-desc text-muted-foreground text-xs font-normal">
                                Teks asli dibiarkan, untuk mengecek OCR.
                              </div>
                            </div>
                          </SelectItem>
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

                    {cleanOnly && (
                      <p className="text-muted-foreground text-[10px] leading-relaxed">
                        Mode bersih mengabaikan penerjemah, pengaturan bahasa,
                        dan mesin OCR.
                      </p>
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

          <p
            aria-live="polite"
            className="text-muted-foreground text-center text-[11px] leading-relaxed"
          >
            {helper}
          </p>
        </div>
      </div>
    </aside>
  );
}
