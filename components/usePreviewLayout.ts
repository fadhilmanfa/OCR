"use client";

import { useCallback, useEffect, useState } from "react";

export type PreviewView = "cards" | "detail";

const STORAGE_KEY = "komik-preview-layout-v1";

export const MIN_THUMB = 140;
export const MAX_THUMB = 1280;
export const DEFAULT_THUMB = 240;

function clampThumb(value: number) {
  return Math.min(MAX_THUMB, Math.max(MIN_THUMB, Math.round(value)));
}

export function usePreviewLayout() {
  const [view, setViewState] = useState<PreviewView>("detail");
  const [thumbWidth, setThumbWidthState] = useState(DEFAULT_THUMB);
  const [hydrated, setHydrated] = useState(false);

  // Preferensi dibaca setelah mount agar HTML server dan klien tetap sama.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as {
          view?: unknown;
          thumbWidth?: unknown;
        };
        if (saved.view === "cards" || saved.view === "detail") {
          setViewState(saved.view);
        }
        if (
          typeof saved.thumbWidth === "number" &&
          Number.isFinite(saved.thumbWidth)
        ) {
          setThumbWidthState(clampThumb(saved.thumbWidth));
        }
      }
    } catch {
      // Preferensi rusak / storage diblokir: pakai default.
    }
    setHydrated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ view, thumbWidth }));
    } catch {
      // Abaikan bila storage penuh atau diblokir.
    }
  }, [hydrated, view, thumbWidth]);

  const setThumbWidth = useCallback(
    (next: number | ((prev: number) => number)) => {
      setThumbWidthState((prev) =>
        clampThumb(typeof next === "function" ? next(prev) : next)
      );
    },
    []
  );

  // Hanya zoom-in maksimum yang otomatis menjadi detail. Zoom-out tetap
  // menampilkan kartu (semakin kecil), bukan detail besar.
  const effectiveView: PreviewView =
    view === "detail" || thumbWidth >= MAX_THUMB ? "detail" : "cards";

  const setView = useCallback(
    (next: PreviewView) => {
      // Dari detail akibat zoom mentok, kembalikan lebar ke rentang kartu.
      if (next === "cards" && thumbWidth >= MAX_THUMB) {
        setThumbWidthState(Math.round(MAX_THUMB * 0.56));
      }
      setViewState(next);
    },
    [thumbWidth]
  );

  return { view: effectiveView, explicitView: view, thumbWidth, setView, setThumbWidth };
}
