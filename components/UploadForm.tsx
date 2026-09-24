import { useRef, useState } from "react";
import type { ProcessResult } from "./types";

interface Props {
  onResult: (r: ProcessResult | null) => void;
  onStatus: (s: string) => void;
  disabled: boolean;
  setDisabled: (v: boolean) => void;
}

export default function UploadForm({
  onResult,
  onStatus,
  disabled,
  setDisabled,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState("auto");
  const [bubble, setBubble] = useState("ogkalu");
  // Engine OCR: "tesseract" = default (tanpa install tambahan),
  // "comics_text_plus" = FCENet+MASTER (perlu pip + checkpoint),
  // "vision_llm" = Vision LLM via OpenRouter (perlu OPENROUTER_API_KEY).
  const [ocrEngine, setOcrEngine] = useState("tesseract");
  const [fileCount, setFileCount] = useState(0);

  async function handleProcess() {
    const files = inputRef.current?.files;
    if (!files || !files.length) {
      alert("Pilih file dulu");
      return;
    }
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("files", f);
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
        { method: "POST", body: fd },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || String(res.status));
      onStatus(`Selesai: ${data.pages.length} halaman`);
      onResult(data as ProcessResult);
    } catch (e) {
      onStatus("Gagal: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setDisabled(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".png,.jpg,.jpeg,.webp,.zip"
        onChange={(e) => setFileCount(e.target.files?.length || 0)}
        className="block w-full text-sm text-zinc-700 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-zinc-700 dark:text-zinc-300 dark:file:bg-zinc-100 dark:file:text-zinc-900"
      />
      {fileCount > 0 && (
        <p className="mt-1 text-xs text-zinc-500">{fileCount} file dipilih</p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-zinc-700 dark:text-zinc-300">
          Provider translate:{" "}
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="auto">auto (Google gratis → MyMemory)</option>
            <option value="openrouter">
              openrouter (LLM, natural — perlu API key)
            </option>
            <option value="opencode">
              opencode (server lokal, perlu OPENCODE_URL)
            </option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-zinc-700 dark:text-zinc-300">
          Bubble YOLO:{" "}
          <select
            value={bubble}
            onChange={(e) => setBubble(e.target.value)}
            className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="ogkalu">ogkalu (barat + manga)</option>
            <option value="psimera">psimera (manga)</option>
            <option value="0">mati (OCR penuh)</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-zinc-700 dark:text-zinc-300">
          OCR engine:{" "}
          <select
            value={ocrEngine}
            onChange={(e) => setOcrEngine(e.target.value)}
            className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="tesseract">tesseract (default, cepat)</option>
            <option value="comics_text_plus">
              comics_text_plus (FCENet+MASTER, perlu model)
            </option>
            <option value="vision_llm">
              vision_llm (Vision LLM via OpenRouter, perlu API key)
            </option>
          </select>
        </label>
        <button
          onClick={handleProcess}
          disabled={disabled}
          className="rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          {disabled ? "Memproses..." : "Proses"}
        </button>
      </div>
    </div>
  );
}
