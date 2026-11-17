"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export const MAX_FILES = 50;
const LEAVE_MS = 220;

const fileIdentity = (file: File) =>
  `${file.name}-${file.size}-${file.lastModified}`;

/**
 * State antrean file untuk UploadDropzone.
 * Dipisah dari form agar dropzone dan panel kendali bisa hidup di kolom
 * berbeda tanpa mengangkat seluruh logika upload ke page.
 */
export function useFileQueue(disabled: boolean) {
  const [files, setFiles] = useState<File[]>([]);
  const [leaving, setLeaving] = useState<File[]>([]);
  // Posisi awal file yang baru masuk pada add() terakhir, untuk animasi masuk.
  const [addedFrom, setAddedFrom] = useState(0);
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

      // Buang file yang sudah ada di antrean (termasuk duplikat dalam batch).
      const seen = new Set(files.map(fileIdentity));
      const unique = incoming.filter((file) => {
        const id = fileIdentity(file);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (unique.length < incoming.length) {
        toast.info("File sudah ada", {
          description: `${incoming.length - unique.length} file dilewati karena sudah ada di antrean.`,
        });
      }
      if (!unique.length) return;

      const room = MAX_FILES - files.length;
      if (room <= 0) {
        toast.warning("Maksimal 50 file", {
          description: "Hapus beberapa file dulu sebelum menambah.",
        });
        return;
      }
      if (unique.length > room) {
        toast.warning("Maksimal 50 file", {
          description: `Hanya ${room} file pertama yang ditambahkan.`,
        });
      }

      clearTimers();
      setLeaving([]);
      const added = unique.slice(0, room);
      setFiles([...files, ...added]);
      setAddedFrom(files.length);
      toast.success(
        added.length === 1 ? "1 file ditambahkan" : `${added.length} file ditambahkan`,
        { description: `Total ${files.length + added.length} file di antrean` }
      );
    },
    [clearTimers, disabled, files]
  );

  const remove = useCallback(
    (index: number) => {
      if (disabled) return;
      const target = files[index];
      if (!target || leaving.includes(target)) return;
      toast.info("File dihapus", { description: target.name });
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

  const clear = useCallback(
    (silent = false) => {
      clearTimers();
      setLeaving([]);
      setFiles([]);
      setAddedFrom(0);
      if (!silent && files.length > 0) {
        toast.info("Semua file dihapus");
      }
    },
    [clearTimers, files.length]
  );

  return { files, leaving, add, remove, clear, addedFrom };
}
