export interface PageBox {
  en: string;
  id: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface ProcessPage {
  file: string;
  url: string;
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

export type PageStage =
  | "queue"
  | "ocr"
  | "translate"
  | "overlay"
  | "done"
  | "error";

export interface PageProgress {
  index: number;
  file: string;
  stage: PageStage;
  bubbleCount: number | null;
  ocrTexts: number;
  translated: number;
  totalTexts: number;
  via?: string;
}

export type JobStage =
  | "upload"
  | "normalize"
  | "bubble"
  | "ocr"
  | "translate"
  | "overlay"
  | "finalize"
  | "done"
  | "error";

export interface JobProgress {
  jobId: string;
  percent: number;
  stage: JobStage;
  message: string;
  currentPage: number;
  totalPages: number;
  bubbleTotal: number | null;
  pages: PageProgress[];
  done: boolean;
  error?: string;
  result?: ProcessResult;
}
