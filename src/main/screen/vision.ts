/**
 * Vision model abstraction (Phases 6-8).
 *
 * analyzeImage(image, context) -> structured VisionResult. The interface is
 * provider-agnostic: one real multimodal adapter (Gemini) plus a generic
 * OpenAI-compatible adapter (covers OpenAI-compatible endpoints and
 * OpenRouter multimodal models). Local-only mode disables remote vision
 * entirely so screenshots are never uploaded silently.
 *
 * Privacy: remote vision uploads happen ONLY when vision.mode === "remote"
 * and a remote provider is configured. ScreenContextManager enforces this.
 */

import { VisionResult, VisionProviderKind } from "../../common/screen-types";
import { logger } from "../logger";

export interface VisionImage {
  data: Buffer;
  mimeType?: string; // default image/png
}

export interface VisionRequestContext {
  recentTranscript?: string;
  screenText?: string;
  questionHint?: string;
}

export interface VisionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  model?: string;
}

export interface VisionProvider {
  readonly name: string;
  readonly remote: boolean;
  isAvailable(): Promise<boolean> | boolean;
  analyzeImage(image: VisionImage, context?: VisionRequestContext, opts?: VisionOptions): Promise<VisionResult>;
}

function baseResult(providerName: string): VisionResult {
  return {
    summary: "",
    confidence: 0,
    providerName,
    timestamp: Date.now(),
  };
}

/** Deterministic scripted provider for tests / offline default. */
export class MockVisionProvider implements VisionProvider {
  readonly name = "mock-vision";
  readonly remote = false;
  private scripted: Array<Partial<VisionResult>>;
  private cursor = 0;
  /** Byte length of the most recent input image (proves frames reach the adapter). */
  lastImageBytes = 0;

  constructor(scripted?: Array<Partial<VisionResult>>) {
    this.scripted = scripted || [];
  }

  isAvailable(): boolean {
    return true;
  }

  async analyzeImage(image: VisionImage): Promise<VisionResult> {
    const bytes = image?.data?.length || 0;
    this.lastImageBytes = bytes;
    if (!image || bytes === 0) throw new Error("mock vision: empty image (no frame bytes reached the adapter)");
    const next = this.cursor < this.scripted.length ? this.scripted[this.cursor] : {};
    this.cursor += 1;
    return {
      ...baseResult(this.name),
      summary: "mock visual summary",
      confidence: 0.5,
      ...next,
      providerName: this.name,
      timestamp: Date.now(),
    };
  }

  reset(): void {
    this.cursor = 0;
  }
}

/** Provider that always fails — used to verify error handling. */
export class FailingVisionProvider implements VisionProvider {
  readonly name = "failing-vision";
  readonly remote = false;
  isAvailable(): boolean {
    return true;
  }
  async analyzeImage(): Promise<VisionResult> {
    throw new Error("mock vision failure");
  }
}

const VISION_JSON_INSTRUCTIONS = [
  "You are assisting a job candidate in a live technical interview.",
  "Describe ONLY what is visible in the screenshot. Do not invent unseen information.",
  "If the image is unclear, say so and lower the confidence.",
  "Preserve code exactly (indentation, identifiers). Detect the language if obvious.",
  "For diagrams describe components, arrows/data flow, databases, services, queues, APIs, clients, load balancers, caches, and notable labels.",
  'Reply with a single JSON object and nothing else, using keys: summary, visibleText, detectedQuestion, technicalElements (array), code {language, text}, diagramDescription, confidence (0..1).',
].join(" ");

function buildVisionPrompt(context?: VisionRequestContext): string {
  let p = VISION_JSON_INSTRUCTIONS;
  if (context?.screenText) p += `\n\nOCR text already extracted from this screen (may be incomplete):\n${context.screenText.slice(0, 1500)}`;
  if (context?.recentTranscript) p += `\n\nRecent interview audio (for relevance only, do not quote as screen content):\n${context.recentTranscript.slice(0, 1000)}`;
  if (context?.questionHint) p += `\n\nCurrent question hint:\n${context.questionHint.slice(0, 500)}`;
  return p;
}

/** Extract the first {...} JSON object from a model reply (tolerates fences). */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const t = (text || "").replace(/```json/gi, "```").replace(/```/g, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(t.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function strField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 4000) : undefined;
}

function numField(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.min(1, v));
  return undefined;
}

/** Map free-form model JSON (or raw text fallback) onto VisionResult. */
export function toVisionResult(providerName: string, rawText: string): VisionResult {
  const out = baseResult(providerName);
  const obj = extractJsonObject(rawText);
  if (!obj) {
    out.summary = (rawText || "").trim().slice(0, 4000) || "no description available";
    out.confidence = 0.4;
    out.contentType = classifyVisionContent(out.summary);
    out.needsAnswer = needsVisionAnswer(out.contentType, out.summary);
    return out;
  }
  out.summary = strField(obj, "summary") || strField(obj, "visibleText") || "no description available";
  const visibleText = strField(obj, "visibleText");
  if (visibleText) out.visibleText = visibleText;
  const detectedQuestion = strField(obj, "detectedQuestion");
  if (detectedQuestion) out.detectedQuestion = detectedQuestion;
  const te = obj["technicalElements"];
  if (Array.isArray(te)) {
    out.technicalElements = te.filter((x): x is string => typeof x === "string").slice(0, 32);
  }
  const code = obj["code"];
  if (code && typeof code === "object") {
    const c = code as Record<string, unknown>;
    const text = strField(c, "text");
    if (text) {
      const language = strField(c, "language");
      out.code = language ? { language, text } : { text };
    }
  } else if (typeof code === "string" && code.trim()) {
    out.code = { text: code.trim().slice(0, 4000) };
  }
  const diagram = strField(obj, "diagramDescription") || strField(obj, "diagram");
  if (diagram) out.diagramDescription = diagram;
  out.confidence = numField(obj, "confidence") ?? 0.6;
  // A returned code block means a coding screen even when the prose around
  // it is terse; diagrams take precedence only without code.
  out.contentType = out.code
    ? "coding-problem"
    : out.diagramDescription
      ? "system-design"
      : classifyVisionContent([out.detectedQuestion, out.visibleText, out.summary].filter(Boolean).join("\n"));
  out.needsAnswer = needsVisionAnswer(out.contentType, out.detectedQuestion || out.summary);
  return out;
}

/**
 * Lightweight deterministic classification for structured vision output
 * (mirrors the screen-text classifier without pulling in the fusion
 * module, keeping this adapter dependency-free).
 */
function classifyVisionContent(text: string): string {
  const t = (text || "").trim();
  if (!t) return "unknown";
  if (/```|^\s{2,}\S|[{;}]\s*$/m.test(t) || /\b(def|function|return|const|let|class|import)\b/.test(t)) return "coding-problem";
  if (/(load\s+balanc|database|microservice|api\s+gateway|queue|cache|diagram|architect)/i.test(t)) return "system-design";
  if (/[?]\s*$/.test(t) || /^(tell me|describe|explain|what|why|how|can you)/im.test(t)) return "interview-question";
  return "general-text";
}

function needsVisionAnswer(contentType: string, text: string): boolean {
  if (contentType === "interview-question" || contentType === "coding-problem" || contentType === "system-design") return true;
  return /[?]|^(implement|write|design|solve|given|tell me|explain)/im.test(text || "");
}

function withTimeout(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("vision request timed out")), timeoutMs);
  const onAbort = (): void => {
    clearTimeout(timer);
    ctrl.abort((parent as AbortSignal | undefined)?.reason);
  };
  if (parent) {
    if (parent.aborted) {
      clearTimeout(timer);
      ctrl.abort(parent.reason);
    } else {
      parent.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(timer);
      if (parent) parent.removeEventListener("abort", onAbort);
    },
  };
}

async function postJson(url: string, body: unknown, opts: VisionOptions, headers?: Record<string, string>): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const t = withTimeout(opts.signal, timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(headers || {}) },
      body: JSON.stringify(body),
      signal: t.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`vision request failed (${res.status}): ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("vision response was not JSON");
    }
  } finally {
    t.dispose();
  }
}

/**
 * Gemini multimodal adapter reusing the existing Gemini configuration.
 * Model resolves through the shared free-tier chain (explicit value, then
 * INTERVIA_GEMINI_MODEL / INTERVIA_VISION_MODEL, then the stable Flash
 * default) and the API key is the same INTERVIA_GEMINI_API_KEY used by the
 * answer stack — no separate key system. API keys are never logged.
 */
export class GeminiVisionAdapter implements VisionProvider {
  readonly name = "gemini-vision";
  readonly remote = true;
  private endpoint: string;
  private model: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(opts?: { endpoint?: string; model?: string; apiKey?: string; timeoutMs?: number }) {
    this.endpoint = (opts?.endpoint || process.env.INTERVIA_VISION_ENDPOINT || process.env.INTERVIA_GEMINI_ENDPOINT || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
    this.model = opts?.model || process.env.INTERVIA_GEMINI_MODEL || process.env.INTERVIA_VISION_MODEL || "gemini-2.5-flash";
    this.apiKey = opts?.apiKey ?? (process.env.INTERVIA_GEMINI_API_KEY || "");
    this.timeoutMs = opts?.timeoutMs ?? Number(process.env.INTERVIA_VISION_TIMEOUT_MS || 30000);
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  /** Multimodal request payload (also used by tests to validate the format). */
  buildRequest(image: VisionImage, context?: VisionRequestContext): Record<string, unknown> {
    return {
      contents: [
        {
          parts: [
            { text: buildVisionPrompt(context) },
            {
              inlineData: {
                mimeType: image.mimeType || "image/png",
                data: image.data.toString("base64"),
              },
            },
          ],
        },
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    };
  }

  async analyzeImage(image: VisionImage, context?: VisionRequestContext, opts?: VisionOptions): Promise<VisionResult> {
    if (!this.isAvailable()) throw new Error("gemini vision unavailable (missing INTERVIA_GEMINI_API_KEY)");
    const model = opts?.model || this.model;
    const url = `${this.endpoint}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = (await postJson(
      url,
      this.buildRequest(image, context),
      { timeoutMs: this.timeoutMs, signal: opts?.signal },
      { "x-goog-api-key": this.apiKey }
    )) as Record<string, unknown>;
    const text = extractGeminiText(res);
    if (!text) throw new Error("gemini vision returned no text");
    const out = toVisionResult(this.name, text);
    out.timestamp = Date.now();
    return out;
  }
}

function extractGeminiText(res: Record<string, unknown>): string {
  try {
    const cands = res["candidates"] as Array<Record<string, unknown>> | undefined;
    const parts = cands?.[0]?.["content"] as Record<string, unknown> | undefined;
    const arr = parts?.["parts"] as Array<Record<string, unknown>> | undefined;
    const txt = arr?.map((p) => (typeof p["text"] === "string" ? (p["text"] as string) : "")).join("\n") || "";
    return txt.trim();
  } catch {
    return "";
  }
}

/**
 * Generic OpenAI-compatible chat-completions vision adapter. Covers
 * OpenAI-compatible endpoints and OpenRouter multimodal models without
 * hardcoding any single vendor into the screen subsystem.
 */
export class OpenAICompatibleVisionAdapter implements VisionProvider {
  readonly name = "openai-compatible-vision";
  readonly remote = true;
  private endpoint: string;
  private model: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(opts?: { endpoint?: string; model?: string; apiKey?: string; timeoutMs?: number }) {
    this.endpoint = (opts?.endpoint || process.env.INTERVIA_VISION_ENDPOINT || "https://openrouter.ai/api").replace(/\/+$/, "");
    this.model = opts?.model || process.env.INTERVIA_VISION_MODEL || "";
    this.apiKey = opts?.apiKey ?? (process.env.INTERVIA_VISION_API_KEY || process.env.INTERVIA_GEMINI_API_KEY || "");
    this.timeoutMs = opts?.timeoutMs ?? Number(process.env.INTERVIA_VISION_TIMEOUT_MS || 30000);
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0 && this.model.length > 0;
  }

  buildRequest(image: VisionImage, context?: VisionRequestContext): Record<string, unknown> {
    const dataUrl = `data:${image.mimeType || "image/png"};base64,${image.data.toString("base64")}`;
    return {
      model: this.model,
      temperature: 0.2,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildVisionPrompt(context) },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    };
  }

  async analyzeImage(image: VisionImage, context?: VisionRequestContext, opts?: VisionOptions): Promise<VisionResult> {
    if (!this.isAvailable()) throw new Error("openai-compatible vision unavailable (missing key/model)");
    const url = `${this.endpoint}/v1/chat/completions`;
    const res = (await postJson(
      url,
      this.buildRequest(image, context),
      { timeoutMs: this.timeoutMs, signal: opts?.signal },
      { Authorization: `Bearer ${this.apiKey}` }
    )) as Record<string, unknown>;
    const text = extractOpenAIText(res);
    if (!text) throw new Error("vision provider returned no text");
    const out = toVisionResult(this.name, text);
    out.timestamp = Date.now();
    return out;
  }
}

function extractOpenAIText(res: Record<string, unknown>): string {
  try {
    const choices = res["choices"] as Array<Record<string, unknown>> | undefined;
    const msg = choices?.[0]?.["message"] as Record<string, unknown> | undefined;
    const content = msg?.["content"];
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((p) => (p && typeof p === "object" && typeof (p as Record<string, unknown>)["text"] === "string" ? String((p as Record<string, unknown>)["text"]) : ""))
        .join("\n")
        .trim();
    }
    return "";
  } catch {
    return "";
  }
}

export function createVisionProvider(kind?: string): VisionProvider {
  const k = ((kind || process.env.INTERVIA_VISION_PROVIDER || "mock") as string).toLowerCase();
  switch (k) {
    case "gemini":
      return new GeminiVisionAdapter();
    case "openai-compatible":
    case "openai":
    case "openrouter":
      return new OpenAICompatibleVisionAdapter();
    case "disabled":
      return new MockVisionProvider([]);
    case "mock":
      return new MockVisionProvider();
    default:
      logger.warn("Unknown vision provider, defaulting to mock", k);
      return new MockVisionProvider();
  }
}

export function visionKindOf(p: VisionProvider): VisionProviderKind {
  if (p instanceof GeminiVisionAdapter) return "gemini";
  if (p instanceof OpenAICompatibleVisionAdapter) return "openai-compatible";
  return "mock";
}
