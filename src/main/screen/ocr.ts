/**
 * Replaceable OCR provider abstraction (Phase 4).
 *
 * First local implementation: TesseractOCRProvider, which shells out to a
 * `tesseract` binary when one is installed on Windows. If no binary is
 * present the provider reports unavailable (no crash) and the app falls back
 * to vision/manual flow. MockOCRProvider drives deterministic tests and the
 * no-dependency default path.
 *
 * OCR output is structured ({ text, blocks, boundingBoxes, confidence,
 * timestamp }) and bounded — huge payloads are truncated before they reach
 * the UI or the reasoning prompt.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OCRResult, OCRBlock, OCRProviderKind } from "../../common/screen-types";
import { logger } from "../logger";

export interface OCRImage {
  data: Buffer;
  /** Image encoding. Only PNG is supported by the tesseract path. */
  encoding: "png" | "rgba";
  width?: number;
  height?: number;
}

export interface OCROptions {
  timeoutMs?: number;
  /** 0..1 hint; providers may ignore. */
  minConfidence?: number;
}

export interface OCRProvider {
  readonly name: string;
  isAvailable(): Promise<boolean> | boolean;
  recognize(image: OCRImage, opts?: OCROptions): Promise<OCRResult>;
}

export function truncateOcrText(text: string, maxChars = 4000): string {
  const t = (text || "").replace(/\r/g, "").trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n…[truncated]";
}

/**
 * Deterministic OCR text cleanup (production screen quality).
 * - normalizes whitespace, drops empty lines and exact-duplicate lines
 * - joins hyphenated line-breaks ("experi- ence" -> "experience")
 * - joins short prose fragments into sentences
 * - PRESERVES code-like lines verbatim (indented, braces/semicolons,
 *   keywords, operators, brackets) so on-screen code survives cleanup for
 *   Phase P prompts. Standalone code tokens ({ } [ ] ( ) ; : == === !=
 *   >= <= => ->) are never dropped as "garbage".
 * - drops obvious garbage lines (single stray symbols, long alpha-soup runs)
 */
export function cleanOcrText(text: string): string {
  const rawLines = String(text || "").replace(/\r/g, "").split("\n");
  const isCodeLine = (l: string): boolean =>
    /^[ \t]+/.test(l) ||
    /[{};]$/.test(l.trim()) ||
    /^(def|function|return|import|from|class|const|let|var|public|private|if|for|while|=>|#include)\b/.test(l.trim()) ||
    /```/.test(l) ||
    isCodeTokenLine(l.trim());
  // A line made only of code punctuation/operators (braces, brackets,
  // comparison/arrow operators, semicolons...) is code structure, not noise.
  const isGarbageLine = (l: string): boolean => {
    const t = l.trim();
    if (!t) return true;
    if (isCodeTokenLine(t)) return false;
    if (t.length === 1 && /[^a-zA-Z0-9]/.test(t)) return true;
    if (/^[^a-zA-Z0-9]*$/.test(t) && t.length < 4) return true;
    // Long run of consonants without vowels/spaces (OCR alpha-soup).
    const nospace = t.replace(/\s+/g, "");
    if (nospace.length >= 12 && !/[aeiouAEIOU0-9]/.test(nospace)) return true;
    return false;
  };
  const out: string[] = [];
  const seen = new Set<string>();
  let pending = "";
  let prevLine = "";
  const flushPending = (): void => {
    const p = pending.trim();
    pending = "";
    if (!p || isGarbageLine(p)) return;
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const raw of rawLines) {
    const line = raw.replace(/[ \t]+/g, " ").replace(/^\s+|\s+$/g, "");
    if (!line) continue;
    // OCR line stutter ("scalable payment" twice in a row): drop repeats.
    if (line === prevLine) continue;
    prevLine = line;
    if (isCodeLine(raw)) {
      flushPending();
      const key = `code:${line}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(raw.replace(/\s+$/g, ""));
      }
      continue;
    }
    if (isGarbageLine(line)) continue;
    // Hyphenated break: "experi-" + "ence" -> "experience".
    if (pending.endsWith("-")) {
      pending = pending.slice(0, -1) + line;
      if (/[.?!:]$/.test(line) || pending.length > 200) flushPending();
      continue;
    }
    if (/[-–—]\s*$/.test(pending)) {
      pending = pending.replace(/[-–—]\s*$/, "") + line;
      continue;
    }
    pending = pending ? `${pending} ${line}` : line;
    if (/[.?!:]$/.test(line) || pending.length > 220) flushPending();
  }
  flushPending();
  return out.join("\n");
}

/** Deterministic scripted provider for tests and the no-dependency default path. */
export class MockOCRProvider implements OCRProvider {
  readonly name = "mock-ocr";
  private scripted: OCRResult[];
  private cursor = 0;
  private defaultResult: OCRResult;
  /** Byte length of the most recent input image (proves frames reach the adapter). */
  lastInputBytes = 0;

  constructor(scripted?: OCRResult[], defaultResult?: Partial<OCRResult>) {
    this.scripted = scripted || [];
    this.defaultResult = {
      text: "",
      blocks: [],
      confidence: 0,
      timestamp: Date.now(),
      ...(defaultResult || {}),
    };
  }

  isAvailable(): boolean {
    return true;
  }

  async recognize(image: OCRImage): Promise<OCRResult> {
    const bytes = image?.data?.length || 0;
    this.lastInputBytes = bytes;
    if (this.cursor < this.scripted.length) {
      const r = this.scripted[this.cursor];
      this.cursor += 1;
      return { ...r, timestamp: Date.now() };
    }
    const fallback = { ...this.defaultResult, timestamp: Date.now() };
    if (fallback.text) return fallback;
    // Frame-aware end-to-end path: with a real captured frame but no scripted
    // text, emit a clearly-labeled MOCK result so the pipeline (capture ->
    // OCR -> ScreenContextEvent) is provably exercised. Never confuse with
    // real OCR: the text is always prefixed [mock-ocr].
    if (bytes > 0) {
      const w = image.width || 0;
      const h = image.height || 0;
      const label = `[mock-ocr ${w}x${h} ${bytes}B — no real OCR engine installed; frame verified]`;
      return { text: label, blocks: [{ text: label }], confidence: 0.5, timestamp: Date.now() };
    }
    return fallback;
  }

  reset(): void {
    this.cursor = 0;
  }
}

/** Provider that always fails — used to verify error handling. */
export class FailingOCRProvider implements OCRProvider {
  readonly name = "failing-ocr";
  isAvailable(): boolean {
    return true;
  }
  async recognize(): Promise<OCRResult> {
    throw new Error("mock OCR failure");
  }
}

/**
 * Local OCR via the Tesseract CLI (`tesseract` on PATH).
 * The screenshot is staged through a transient temp file that is deleted
 * immediately after recognition; frames otherwise stay in memory.
 */
export class TesseractOCRProvider implements OCRProvider {
  readonly name = "tesseract";
  private availableCache: boolean | null = null;
  private timeoutMs: number;

  constructor(opts?: { timeoutMs?: number }) {
    this.timeoutMs = opts?.timeoutMs ?? 20000;
  }

  async isAvailable(): Promise<boolean> {
    if (this.availableCache !== null) return this.availableCache;
    this.availableCache = await checkBinaryPresent("tesseract");
    if (!this.availableCache) {
      logger.warn("Tesseract binary not found on PATH; local OCR unavailable");
    }
    return this.availableCache;
  }

  async recognize(image: OCRImage, opts?: OCROptions): Promise<OCRResult> {
    const ok = await this.isAvailable();
    if (!ok) throw new Error("tesseract binary not available");
    if (!image || !image.data || image.data.length === 0) throw new Error("empty image");
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const png = image.encoding === "png" ? image.data : rgbaToPngPlaceholder(image);
    const tmp = await stageTempPng(png);
    try {
      const stdout = await runTesseract(tmp, timeoutMs);
      const text = truncateOcrText(cleanOcrText(stdout));
      const blocks: OCRBlock[] = text ? [{ text }] : [];
      return {
        text,
        blocks,
        // Tesseract stdout path gives no word confidences; report neutral 0.6
        // when text was found, 0 when nothing recognized.
        confidence: text ? 0.6 : 0,
        timestamp: Date.now(),
      };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

function checkBinaryPresent(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === "win32" ? "where" : "which";
    // windowsHide: no console-window flash on real Windows desktops.
    execFile(probe, [bin], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(String(stdout || "").trim().length > 0);
    });
  });
}

function stageTempPng(png: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const dir = os.tmpdir();
    const file = path.join(dir, `intervia-ocr-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}.png`);
    fs.writeFile(file, png, (err) => {
      if (err) reject(err);
      else resolve(file);
    });
  });
}

function runTesseract(pngPath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // windowsHide: no console-window flash on real Windows desktops.
    execFile("tesseract", [pngPath, "stdout", "--psm", "6"], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error("tesseract failed: " + String((stderr as unknown as string) || err.message || err)));
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

/**
 * The tesseract path needs an encoded PNG. RGBA test frames never reach the
 * real binary in production (captures are PNG); if one ever does, fail loudly
 * instead of silently producing garbage.
 */
function rgbaToPngPlaceholder(_image: OCRImage): Buffer {
  throw new Error("tesseract provider requires PNG input (got RGBA test frame)");
}

/**
 * True when a trimmed line consists only of code punctuation/operators:
 * braces, brackets, parentheses, semicolons, colons, quotes, dots,
 * comparison and arrow operators (== === != >= <= => ->). Such lines carry
 * code structure (e.g. a lone "{" or "});") and must survive cleanup.
 */
export function isCodeTokenLine(t: string): boolean {
  if (!t || t.length > 24) return false;
  if (/[a-zA-Z0-9]/.test(t)) return false;
  return /^[{}[\](){};:,.'"_\-+=*/!@#$%^&|\\?<>~`\s]+$/.test(t) && /[{}\[\](){};:=><-]/.test(t);
}

export function createOCRProvider(kind?: string, opts?: { timeoutMs?: number }): OCRProvider {
  const k = ((kind || process.env.INTERVIA_OCR_PROVIDER || "tesseract") as string).toLowerCase() as OCRProviderKind;
  switch (k) {
    case "tesseract":
      return new TesseractOCRProvider(opts);
    case "mock":
      return new MockOCRProvider();
    default:
      logger.warn("Unknown OCR provider, defaulting to tesseract", k);
      return new TesseractOCRProvider(opts);
  }
}
