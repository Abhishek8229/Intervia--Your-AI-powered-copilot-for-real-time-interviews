/**
 * Resume import: PDF + DOCX (+ plain text) extraction and normalization
 * (Phase 3). Uses established libraries (pdf-parse, mammoth) — no hand-rolled
 * PDF parsing. Stores only extracted text + page metadata, never raw files.
 */

import * as fs from "fs";
import * as path from "path";

export type ResumeFileKind = "pdf" | "docx" | "txt";

export interface ResumeText {
  text: string;
  pages: number;
  fileName: string;
  kind: ResumeFileKind;
  /** Per-page char counts where the extractor provides page info. */
  pageLengths: number[];
}

export class ResumeParseError extends Error {
  code: "unsupported-type" | "unreadable" | "empty" | "failed";
  constructor(code: ResumeParseError["code"], message: string) {
    super(message);
    this.name = "ResumeParseError";
    this.code = code;
  }
}

export function detectResumeKind(fileName: string): ResumeFileKind | null {
  const ext = path.extname(fileName || "").toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".txt" || ext === ".md") return "txt";
  return null;
}

export async function extractResumeText(filePath: string): Promise<ResumeText> {
  const fileName = path.basename(filePath);
  const kind = detectResumeKind(fileName);
  if (!kind) {
    throw new ResumeParseError("unsupported-type", `unsupported resume type: ${fileName} (use PDF, DOCX, or TXT)`);
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    throw new ResumeParseError("unreadable", `cannot read file: ${fileName}`);
  }
  if (buf.length === 0) throw new ResumeParseError("empty", `file is empty: ${fileName}`);
  if (buf.length > 20 * 1024 * 1024) throw new ResumeParseError("unreadable", `file too large (>20MB): ${fileName}`);
  return extractResumeBuffer(buf, fileName, kind);
}

export async function extractResumeBuffer(buf: Buffer, fileName: string, kind: ResumeFileKind): Promise<ResumeText> {
  if (kind === "pdf") return extractPdf(buf, fileName);
  if (kind === "docx") return extractDocx(buf, fileName);
  const text = buf.toString("utf8");
  const normalized = normalizeResumeText(text);
  if (!normalized) throw new ResumeParseError("empty", `no text extracted from ${fileName}`);
  return { text: normalized, pages: 1, fileName, kind, pageLengths: [normalized.length] };
}

async function extractPdf(buf: Buffer, fileName: string): Promise<ResumeText> {
  let raw = "";
  let pages = 1;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PDFParse } = require("pdf-parse") as {
      PDFParse: new (opts: { data: Buffer }) => {
        getText: () => Promise<{ text?: string; pages?: Array<unknown> } | string>;
        destroy: () => Promise<void>;
      };
    };
    const parser = new PDFParse({ data: buf });
    try {
      const out = await parser.getText();
      if (typeof out === "string") {
        raw = out;
      } else {
        raw = out.text || "";
        if (Array.isArray(out.pages)) pages = Math.max(1, out.pages.length);
      }
    } finally {
      try {
        await parser.destroy();
      } catch {
        // ignore
      }
    }
  } catch (e) {
    throw new ResumeParseError("failed", `PDF extraction failed for ${fileName}: ${messageOf(e)}`);
  }
  const text = normalizeResumeText(raw);
  if (!text) throw new ResumeParseError("empty", `no text extracted from ${fileName} (scanned image PDF?)`);
  return { text, pages, fileName, kind: "pdf", pageLengths: splitPageLengths(text, pages) };
}

async function extractDocx(buf: Buffer, fileName: string): Promise<ResumeText> {
  let raw = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mammoth = require("mammoth") as {
      extractRawText: (input: { buffer: Buffer }) => Promise<{ value?: string } | string>;
    };
    const out = await mammoth.extractRawText({ buffer: buf });
    raw = typeof out === "string" ? out : out.value || "";
  } catch (e) {
    throw new ResumeParseError("failed", `DOCX extraction failed for ${fileName}: ${messageOf(e)}`);
  }
  const text = normalizeResumeText(raw);
  if (!text) throw new ResumeParseError("empty", `no text extracted from ${fileName}`);
  return { text, pages: 1, fileName, kind: "docx", pageLengths: [text.length] };
}

function splitPageLengths(text: string, pages: number): number[] {
  if (pages <= 1) return [text.length];
  const per = Math.ceil(text.length / pages);
  const out: number[] = [];
  for (let i = 0; i < pages; i++) {
    out.push(Math.min(per, text.length - i * per));
  }
  return out;
}

/**
 * Normalize extracted text: unify newlines, de-hyphenate wrapped words,
 * collapse whitespace runs, drop duplicated consecutive lines (headers/
 * footers repeated per page), trim. Preserves line structure (important for
 * the deterministic extractor).
 */
export function normalizeResumeText(raw: string): string {
  if (!raw) return "";
  let t = raw.replace(/\r\n?/g, "\n");
  // De-hyphenate: "experi-\nence" -> "experience".
  t = t.replace(/(\w)-\n(\w)/g, "$1$2");
  // Join single wrapped lines conservatively is the extractor's job; here
  // just collapse 3+ newlines and horizontal whitespace.
  t = t.replace(/[ \t\u00a0]+/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");
  const lines = t.split("\n").map((l) => l.trim());
  // Drop duplicated consecutive lines (page headers/footers).
  const deduped: string[] = [];
  for (const l of lines) {
    if (l && deduped.length > 0 && deduped[deduped.length - 1] === l) continue;
    deduped.push(l);
  }
  // Drop empty runs but keep paragraph breaks.
  const cleaned: string[] = [];
  let blank = false;
  for (const l of deduped) {
    if (!l) {
      if (!blank) cleaned.push("");
      blank = true;
    } else {
      cleaned.push(l);
      blank = false;
    }
  }
  return cleaned.join("\n").trim().slice(0, 60000);
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
