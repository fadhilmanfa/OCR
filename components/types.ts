export interface PageBox {
  en: string;
  id: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface ProcessPage {
  file: string;
  original: string;
  url: string;
  originalUrl: string;
  via?: string;
  bubbleCount?: number;
  boxes: PageBox[];
}

export interface ProcessResult {
  jobId: string;
  provider: string;
  pages: ProcessPage[];
  zipUrl: string;
  pdfUrl: string;
}
