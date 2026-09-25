import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { Toaster } from "@/components/ui/sonner";
import { BookOpenText } from "lucide-react";

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
        className={`${geistSans.variable} ${geistMono.variable} flex min-h-full flex-col font-sans antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <header className="border-b bg-background">
            <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-4 sm:px-6">
              <div className="flex items-center gap-2.5">
                <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-md">
                  <BookOpenText className="size-4" />
                </span>
                <span className="text-sm font-semibold tracking-tight">
                  Komik OCR
                </span>
              </div>
              <ThemeToggle />
            </div>
          </header>
          <main className="flex-1">{children}</main>
          <Toaster richColors closeButton position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
