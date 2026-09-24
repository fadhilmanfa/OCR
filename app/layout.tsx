import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { Toaster } from "@/components/ui/sonner";
import { BookOpenText } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Komik OCR EN → ID",
  description:
    "Upload JPG/PNG/ZIP → OCR Inggris → auto-translate Indonesia → timpa teks ID.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id" suppressHydrationWarning className="h-full">
      <body
        className={`${geistSans.variable} ${geistMono.variable} flex min-h-full flex-col antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <header className="bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
            <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
              <div className="flex items-center gap-2.5">
                <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg">
                  <BookOpenText className="size-4" />
                </span>
                <div className="leading-tight">
                  <p className="text-sm font-semibold tracking-tight">
                    Komik OCR
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Inggris → Indonesia
                  </p>
                </div>
                <Badge variant="secondary" className="ml-2 hidden sm:inline-flex">
                  v1
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="hidden md:inline-flex">
                  JPG / PNG / ZIP
                </Badge>
                <ThemeToggle />
              </div>
            </div>
          </header>
          <main className="flex-1">{children}</main>
          <footer className="border-t">
            <div className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-4 text-xs">
              OCR Tesseract + YOLO bubble · Translate auto / OpenRouter · Hasil
              di folder outputs/
            </div>
          </footer>
          <Toaster richColors closeButton position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
