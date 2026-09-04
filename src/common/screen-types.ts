/**
 * Shared screen-context types (main <-> renderer).
 * Frames themselves are never sent to the renderer in full; only extracted
 * text/summaries travel through IPC. Raw pixels stay in the main process
 * memory and are never written to disk by the capture layer.
 */

export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ScreenFrameEncoding = "png" | "rgba";

export interface ScreenFrameSource {
  kind: "display" | "window";
  id: string;
  name?: string;
}

/**
 * In-memory frame representation. `data` is either a PNG buffer
 * (Electron desktopCapturer path) or raw RGBA bytes (synthetic/test path).
 */
export interface ScreenFrame {
  id: string;
  width: number;
  height: number;
  data: Buffer;
  encoding: ScreenFrameEncoding;
  timestamp: number;
  source: ScreenFrameSource;
  region?: ScreenRegion;
}

export type ScreenCaptureMode = "auto" | "manual" | "window";

export type ScreenContextOrigin = "ocr" | "vision" | "fusion";

export interface ScreenCodeBlock {
  language?: string;
  text: string;
}

export interface ScreenContextEvent {
  id: string;
  timestamp: number;
  /** How the capture was triggered. */
  source: ScreenCaptureMode;
  /** Same as `source`; kept so consumers can read either field. */
  mode: ScreenCaptureMode;
  /** Extracted useful text/summary (bounded length). Never a raw image. */
  text: string;
  visualSummary?: string;
  detectedQuestion?: string;
  code?: ScreenCodeBlock;
  diagramDescription?: string;
  region?: ScreenRegion;
  confidence: number;
  origin: ScreenContextOrigin;
}

export interface OCRBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OCRBlock {
  text: string;
  boundingBox?: OCRBoundingBox;
  confidence?: number;
}

export interface OCRResult {
  text: string;
  blocks: OCRBlock[];
  confidence: number;
  timestamp: number;
}

export interface VisionCodeBlock {
  language?: string;
  text: string;
}

export interface VisionResult {
  summary: string;
  visibleText?: string;
  detectedQuestion?: string;
  technicalElements?: string[];
  code?: VisionCodeBlock;
  diagramDescription?: string;
  confidence: number;
  providerName: string;
  timestamp: number;
  /** Deterministic content classification (question/code/diagram/...). */
  contentType?: string;
  /** Whether the screen content looks like it needs an interview answer. */
  needsAnswer?: boolean;
}

export type FusedOrigin = "audio" | "screen" | "fused";

export interface FusedQuestionContext {
  /** Best available question/context text for the AnswerEngine. */
  text: string;
  origin: FusedOrigin;
  confidence: number;
  screenRelated: boolean;
  reasons: string[];
  code?: VisionCodeBlock;
  diagramDescription?: string;
}

export type VisionProviderKind = "mock" | "gemini" | "openai-compatible" | "disabled";
export type OCRProviderKind = "mock" | "tesseract";
export type LLMProviderKind = "mock" | "gemini" | "openai-compatible" | "minimax" | "openrouter" | "openai" | "local";
