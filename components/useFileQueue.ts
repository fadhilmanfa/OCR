"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export const MAX_FILES = 50;
const LEAVE_MS = 180;

/**
 * State antrean file untuk UploadDropzone.
 * Dipisah dari form agar dropzone dan panel kendali bisa hidup di kolom
 * berbeda tanpa mengangkat seluruh logika upload ke page.
 */
export function useFileQueue(disabled: boolean) {
  const [files, setFiles] = useState<File[]>([]);
  const [leaving, setLeaving] = useState<File[]>([]);
  const removeTimers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    removeTimers.current.forEach((timer) => window.clearTimeout(timer));
    removeTimers.current = [];
  }, []);

  useEffect(
    () => () => {
      removeTimers.current.forEach((timer) => window.clearTimeout(timer));
    },
    []
  );

  const add = useCallback(
    (list: FileList | File[] | null) => {
      if (!list || disabled) return;
      const incoming = Array.from(list);
      if (!incoming.length) return;
      if (incoming.length > MAX_FILES) {
        toast.warning("Maksimal 50 file", {
          description: "Hanya 50 file pertama yang ditambahkan.",
        });
      }
      clearTimers();
      setLeaving([]);
      setFiles(incoming.slice(0, MAX_FILES));
    },
    [clearTimers, disabled]
  );

  const remove = useCallback(
    (index: number) => {
      if (disabled) return;
      const target = files[index];
      if (!target || leaving.includes(target)) return;
      // Mainkan animasi keluar dulu, kartu benar-benar dibuang setelahnya.
      setLeaving((prev) => [...prev, target]);
      const timer = window.setTimeout(() => {
        setFiles((prev) => prev.filter((file) => file !== target));
        setLeaving((prev) => prev.filter((file) => file !== target));
      }, LEAVE_MS);
      removeTimers.current.push(timer);
    },
    [disabled, files, leaving]
  );

  const clear = useCallback(() => {
    clearTimers();
    setLeaving([]);
    setFiles([]);
  }, [clearTimers]);

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  return { files, leaving, add, remove, clear, totalBytes };
}
