"use client";

import type { CSSProperties } from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      // Kebalikan tema: gelap -> toast putih, terang -> toast hitam.
      invert
      style={{ "--border-radius": "0px" } as CSSProperties}
      {...props}
    />
  );
};

export { Toaster };
