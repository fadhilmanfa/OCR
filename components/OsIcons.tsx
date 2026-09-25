"use client";

import { cn } from "@/lib/utils";

export function MacIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 384 512"
      fill="currentColor"
      aria-hidden="true"
      className={cn("size-3.5", className)}
    >
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}

export function WindowsIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      fill="currentColor"
      aria-hidden="true"
      className={cn("size-3.5", className)}
    >
      <path d="M0 93.7l183.6-25.3v177.4H0V93.7zm0 324.6l183.6 25.3V268.4H0v149.9zm203.6-374L512 0v245.8H203.6V43.7zm0 469.7L512 512V268.4H203.6v245z" />
    </svg>
  );
}

export function OsBadges({
  mac = true,
  win = true,
  className,
}: {
  mac?: boolean;
  win?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      aria-label={`Support: ${mac ? "macOS ya" : "macOS tidak"}, ${win ? "Windows ya" : "Windows tidak"}`}
    >
      <span title={mac ? "Support macOS" : "Tidak support macOS"}>
        <MacIcon
          className={mac ? "text-foreground" : "text-muted-foreground/40"}
        />
      </span>
      <span title={win ? "Support Windows" : "Tidak support Windows"}>
        <WindowsIcon
          className={win ? "text-foreground" : "text-muted-foreground/40"}
        />
      </span>
    </span>
  );
}
