/**
 * ScreenContextManager (Phases 9, 10, 17, 18, 20, 23).
 *
 * Pipeline: capture -> change detection -> OCR -> (vision when needed) ->
 * ScreenContextEvent -> InterviewContext -> fusion -> question pipeline.
 *
 * - Bounded memory: only extracted text/summaries are stored (config-
 *   capped); raw frames are dropped after processing.
 * - Debounce/dedup: unchanged frames are skipped upstream; identical OCR
 *   text within the dedup window emits nothing (manual captures always emit).
 * - Cancellation: every visual job carries a job id + AbortSignal; stale jobs
 *   never overwrite newer results (same stale-generation concept as the
 *   AnswerEngine).
 * - Privacy: remote vision runs ONLY when visionMode === "remote" and the
 *   provider is remote + available. Local-first otherwise.
 */

import { EventEmitter } from "events";
import {
  ScreenContextEvent,
  ScreenCaptureMode,
  ScreenFrame,
  ScreenRegion,
} from "../../common/screen-types";
import { QuestionDetectedEvent } from "../../common/types";
import { MonitoredFrame } from "./ScreenCaptureManager";
import { OCRProvider } from "./ocr";
import { VisionProvider } from "./vision";
import { InterviewContext } from "../conversation/InterviewContext";
import { QuestionDetector, normalizeQuestionText } from "../conversation/QuestionDetector";
import {
  fuseQuestionContext,
  detectScreenQuestion,
  looksLikeCode,
  looksLikeDiagram,
  extractRelevantScreenContent,
} from "./QuestionContextFusion";
import { truncateOcrText, cleanOcrText } from "./ocr";
import { frameFingerprint } from "./ChangeDetector";
import { logger } from "../logger";

let __screenEventCounter = 0;
function nextScreenEventId(): string {
  __screenEventCounter += 1;
  return `scr-${Date.now().toString(36)}-${__screenEventCounter.toString(36)}`;
}

let __screenQuestionCounter = 0;
function nextScreenQuestionId(): string {
  __screenQuestionCounter += 1;
  return `sq-${Date.now().toString(36)}-${__screenQuestionCounter.toString(36)}`;
}

export interface CaptureLike {
  capturePrimaryDisplay(): Promise<ScreenFrame>;
  captureRegion(r: ScreenRegion): Promise<ScreenFrame>;
  startMonitoring(cb: (m: MonitoredFrame) => void): void;
  stopMonitoring(): void;
  isMonitoring(): boolean;
  cancelPending(): void;
}

export type VisionMode = "local" | "remote" | "disabled";

export interface ScreenContextManagerOptions {
  visionMode?: VisionMode;
  dedupeWindowMs?: number;
  minEventGapMs?: number;
  fusionMaxAgeMs?: number;
  maxScreenChars?: number;
  /** Below this OCR length, auto mode tries vision (possible diagram/image). */
  visionMinTextChars?: number;
  questionMinConfidence?: number;
}

const DEFAULTS: Required<ScreenContextManagerOptions> = {
  visionMode: "local",
  dedupeWindowMs: 60000,
  minEventGapMs: 3000,
  fusionMaxAgeMs: 120000,
  maxScreenChars: 2000,
  visionMinTextChars: 30,
  questionMinConfidence: 0.5,
};

export type ScreenProcessorState = "ready" | "processing" | "error" | "unavailable";

export type ScreenFailureStage =
  | "source"
  | "capture"
  | "change"
  | "ocr"
  | "vision"
  | "empty"
  | "emit";

export interface ScreenFailureInfo {
  stage: ScreenFailureStage;
  message: string;
  at: number;
}

export type OcrKindLabel = "MOCK OCR" | "REAL OCR" | "UNAVAILABLE";

/** Provider-name based honesty label (never claims mock output is real). */
export function ocrKindLabel(providerName: string, available: boolean): OcrKindLabel {
  if (!available) return "UNAVAILABLE";
  const n = (providerName || "").toLowerCase();
  if (n.includes("tesseract")) return "REAL OCR";
  if (n.includes("mock")) return "MOCK OCR";
  return "REAL OCR";
}

/**
 * Stage-by-stage diagnostic trace for "Test Screen Capture & OCR".
 * Proves A(source) B(frame) C(dims) D(bytes) E(change) F(OCR) G(event).
 * Never includes raw pixels — only metadata + truncated text previews.
 */
export interface ScreenDiagnosticTrace {
  source: { found: boolean; name: string; idPresent: boolean };
  capture: { ok: boolean; width: number; height: number; bytes: number; nonEmpty: boolean; error: string };
  change: { verdict: "CHANGED" | "UNCHANGED" | "SKIPPED"; reason: string };
  ocr: { provider: string; kind: OcrKindLabel; call: "EXECUTED" | "SKIPPED"; chars: number; preview: string; error: string };
  vision: { provider: string; mode: VisionMode; attempted: boolean; note: string };
  event: { emitted: boolean; id: string; textChars: number };
  failureStage: ScreenFailureStage | null;
  pass: boolean;
}

interface FrameTracer {
  ocrCall: "EXECUTED" | "SKIPPED";
  ocrChars: number;
  ocrPreview: string;
  ocrError: string;
  ocrAvailable: boolean;
  visionAttempted: boolean;
  visionNote: string;
}

export interface ScreenManagerStatus {
  monitoring: boolean;
  ocr: ScreenProcessorState;
  vision: ScreenProcessorState;
  visionMode: VisionMode;
  lastText?: string;
  lastEventAt?: number;
}

export class ScreenContextManager extends EventEmitter {
  private capture: CaptureLike;
  private ocr: OCRProvider;
  private vision: VisionProvider;
  private context: InterviewContext;
  private detector: QuestionDetector;
  private opts: Required<ScreenContextManagerOptions>;

  private jobSeq = 0;
  private visionCtrl: AbortController | null = null;
  private seen: Array<{ normalized: string; ts: number }> = [];
  private lastEmitAt = 0;
  private recentEvents: ScreenContextEvent[] = [];
  private ocrState: ScreenProcessorState = "ready";
  private visionState: ScreenProcessorState = "ready";
  private lastText = "";
  private lastEventAt = 0;
  private lastTraceFingerprint: string | null = null;
  /** Metadata of the most recently processed frame (for region-report diagnostics). */
  lastFrameInfo: { width: number; height: number; bytes: number } | null = null;

  /** Local-first backend summary for the Setup UI (presence-only, no pixels). */
  async describeBackends(): Promise<{
    ocrName: string;
    ocrAvailable: boolean;
    ocrLabel: OcrKindLabel;
    visionName: string;
    visionAvailable: boolean;
    visionMode: VisionMode;
  }> {
    const ocrName = this.getOcrName();
    const visionName = this.getVisionName();
    let ocrAvailable = false;
    let visionAvailable = false;
    try {
      ocrAvailable = !!(await this.ocr.isAvailable());
    } catch {
      ocrAvailable = false;
    }
    try {
      visionAvailable = !!(await this.vision.isAvailable());
    } catch {
      visionAvailable = false;
    }
    return {
      ocrName,
      ocrAvailable,
      ocrLabel: ocrKindLabel(ocrName, ocrAvailable),
      visionName,
      visionAvailable,
      visionMode: this.opts.visionMode,
    };
  }

  constructor(
    capture: CaptureLike,
    ocr: OCRProvider,
    vision: VisionProvider,
    context: InterviewContext,
    detector: QuestionDetector,
    opts?: ScreenContextManagerOptions
  ) {
    super();
    this.capture = capture;
    this.ocr = ocr;
    this.vision = vision;
    this.context = context;
    this.detector = detector;
    this.opts = { ...DEFAULTS, ...(opts || {}) };
  }

  getStatus(): ScreenManagerStatus {    return {
      monitoring: this.capture.isMonitoring(),
      ocr: this.ocrState,
      vision: this.vision.remote ? this.visionState : this.visionState === "processing" ? "processing" : "ready",
      visionMode: this.opts.visionMode,
      lastText: this.lastText ? this.lastText.slice(0, 160) : undefined,
      lastEventAt: this.lastEventAt || undefined,
    };
  }

  getRecentEvents(maxN = 10): ScreenContextEvent[] {
    return this.recentEvents.slice(-maxN);
  }

  /** Swap the OCR backend at runtime (e.g. auto-upgrade mock -> tesseract). */
  setOcrProvider(ocr: OCRProvider): void {
    this.ocr = ocr;
    if (this.ocrState === "unavailable" || this.ocrState === "error") this.ocrState = "ready";
    this.emitStatus();
  }

  /** Runtime vision-mode switch (Setup configuration; local stays upload-free). */
  setVisionMode(mode: VisionMode): void {
    if (mode !== "local" && mode !== "remote" && mode !== "disabled") return;
    this.opts.visionMode = mode;
    if (mode !== "remote") {
      try {
        this.visionCtrl?.abort();
      } catch {
        // ignore
      }
      this.visionCtrl = null;
    }
    this.emitStatus();
  }

  /** Runtime vision-backend swap (Setup configuration). */
  setVisionProvider(v: VisionProvider): void {
    if (!v) return;
    try {
      this.visionCtrl?.abort();
    } catch {
      // ignore
    }
    this.visionCtrl = null;
    this.vision = v;
    if (this.visionState === "unavailable" || this.visionState === "error") this.visionState = "ready";
    this.emitStatus();
  }

  getOcrName(): string {
    try {
      return this.ocr?.name || "none";
    } catch {
      return "none";
    }
  }

  getVisionName(): string {
    try {
      return this.vision?.name || "none";
    } catch {
      return "none";
    }
  }

  /** MODE A — start automatic monitoring (change-gated). */
  startAutoMonitoring(): void {
    this.capture.startMonitoring((m) => {
      void this.handleMonitorFrame(m);
    });
    this.emitStatus();
  }

  stopAutoMonitoring(): void {
    this.capture.stopMonitoring();
    this.emitStatus();
  }

  /** MODE B — user-triggered full-screen inspection. */
  async captureNow(): Promise<ScreenContextEvent | null> {
    const frame = await this.capture.capturePrimaryDisplay();
    return this.processFrame(frame, "auto", { forceVision: false, forceEmit: false });
  }

  /** MODE B — manually selected region. Always analyzed + always emitted. */
  async captureManualRegion(region: ScreenRegion): Promise<ScreenContextEvent | null> {
    const frame = await this.capture.captureRegion(region);
    return this.processFrame(frame, "manual", { forceVision: true, forceEmit: true });
  }

  /** MODE C — capture a specific window/source. */
  async captureWindowSource(captureWindow: () => Promise<ScreenFrame>): Promise<ScreenContextEvent | null> {
    const frame = await captureWindow();
    return this.processFrame(frame, "window", { forceVision: false, forceEmit: false });
  }

  /**
   * Developer diagnostic: one full pass (source -> frame -> change -> OCR ->
   * vision -> event) with a per-stage trace. Each stage is verified, not
   * assumed: a non-empty frame must reach OCR, and only an actually-emitted
   * ScreenContextEvent counts as pass. Diagnostics bypass dedup/min-gap
   * (forceEmit) so every click proves the path end to end.
   */
  async runDiagnosticTrace(): Promise<ScreenDiagnosticTrace> {
    const trace: ScreenDiagnosticTrace = {
      source: { found: false, name: "(none)", idPresent: false },
      capture: { ok: false, width: 0, height: 0, bytes: 0, nonEmpty: false, error: "" },
      change: { verdict: "SKIPPED", reason: "no-frame" },
      ocr: { provider: this.getOcrName(), kind: "UNAVAILABLE", call: "SKIPPED", chars: 0, preview: "", error: "" },
      vision: { provider: this.getVisionName(), mode: this.opts.visionMode, attempted: false, note: "local mode: remote vision disabled by design" },
      event: { emitted: false, id: "", textChars: 0 },
      failureStage: null,
      pass: false,
    };
    // --- A. source + B/C/D. capture ---
    let frame: ScreenFrame;
    try {
      frame = await this.capture.capturePrimaryDisplay();
    } catch (e) {
      const msg = String((e as Error)?.message || e).slice(0, 300);
      trace.capture.error = msg;
      trace.failureStage = /no-source|unsupported/i.test(msg) ? "source" : "capture";
      try {
        this.emit("screen-failure", { stage: trace.failureStage, message: msg, at: Date.now() } as ScreenFailureInfo);
      } catch {
        // ignore
      }
      return trace;
    }
    const bytes = frame?.data?.length || 0;
    const w = frame?.width || 0;
    const h = frame?.height || 0;
    trace.source = {
      found: !!(frame?.source?.id),
      name: String(frame?.source?.name || frame?.source?.id || "(none)").replace(/[\r\n\t]+/g, " ").slice(0, 120) || "(none)",
      idPresent: !!(frame?.source?.id),
    };
    trace.capture = {
      ok: bytes > 0 && w > 0 && h > 0,
      width: w,
      height: h,
      bytes,
      nonEmpty: sampleNonEmpty(frame?.data),
      error: "",
    };
    if (!trace.source.found) {
      trace.failureStage = "source";
      return trace;
    }
    if (!trace.capture.ok) {
      trace.capture.error = "frame has zero width/height or zero bytes";
      trace.failureStage = "capture";
      return trace;
    }
    // --- E. change detection (trace-local baseline; monitor untouched) ---
    try {
      const fp = frameFingerprint(frame);
      if (this.lastTraceFingerprint === null) {
        trace.change = { verdict: "CHANGED", reason: "first-frame" };
      } else if (this.lastTraceFingerprint === fp) {
        trace.change = { verdict: "UNCHANGED", reason: "exact-match" };
      } else {
        trace.change = { verdict: "CHANGED", reason: "bytes-differ" };
      }
      this.lastTraceFingerprint = fp;
    } catch (e) {
      trace.change = { verdict: "SKIPPED", reason: String(e).slice(0, 120) };
    }
    // --- F/G. OCR (+vision) -> event, with per-stage instrumentation ---
    const tracer: FrameTracer = {
      ocrCall: "SKIPPED",
      ocrChars: 0,
      ocrPreview: "",
      ocrError: "",
      ocrAvailable: false,
      visionAttempted: false,
      visionNote: this.opts.visionMode === "remote" ? "" : "local mode: remote vision disabled by design",
    };
    try {
      trace.ocr.provider = this.getOcrName();
      trace.ocr.kind = ocrKindLabel(this.getOcrName(), await safeAvailable(this.ocr));
    } catch {
      // keep defaults
    }
    let event: ScreenContextEvent | null = null;
    try {
      event = await this.processFrame(frame, "auto", { forceVision: false, forceEmit: true }, tracer);
    } catch (e) {
      trace.ocr.error = String((e as Error)?.message || e).slice(0, 300);
      trace.failureStage = "emit";
      return trace;
    }
    trace.ocr.call = tracer.ocrCall;
    trace.ocr.chars = tracer.ocrChars;
    trace.ocr.preview = tracer.ocrPreview;
    trace.ocr.error = tracer.ocrError;
    trace.vision.attempted = tracer.visionAttempted;
    if (tracer.visionNote) trace.vision.note = tracer.visionNote;
    else if (tracer.visionAttempted) trace.vision.note = "remote vision executed";
    if (event) {
      trace.event = { emitted: true, id: event.id, textChars: (event.text || "").length };
      trace.pass = true;
    } else {
      trace.event = { emitted: false, id: "", textChars: tracer.ocrChars };
      trace.failureStage = tracer.ocrCall === "SKIPPED" ? "ocr" : "empty";
    }
    return trace;
  }

  /** Cancel in-flight visual jobs; stale results are dropped on arrival. */
  cancelPending(): void {
    this.jobSeq += 1;
    try {
      this.capture.cancelPending();
    } catch {
      // ignore
    }
    if (this.visionCtrl) {
      try {
        this.visionCtrl.abort(new Error("superseded by newer visual job"));
      } catch {
        // ignore
      }
      this.visionCtrl = null;
    }
    if (this.ocrState === "processing") this.ocrState = "ready";
    if (this.visionState === "processing") this.visionState = "ready";
  }

  /**
   * Fresh-interview reset: forgets seen-content dedup, recent screen events
   * and last-text so a restarted interview never suppresses or reuses the
   * previous interview's screen state. Bounded stores only; providers and
   * vision mode are untouched.
   */
  resetHistory(): void {
    this.seen = [];
    this.recentEvents = [];
    this.lastText = "";
    this.lastEventAt = 0;
    this.lastEmitAt = 0;
    this.lastTraceFingerprint = null;
    this.emitStatus();
  }

  private async handleMonitorFrame(m: MonitoredFrame): Promise<void> {
    if (!m.comparison.changed) return; // Phase 3: skip unchanged frames.
    await this.processFrame(m.frame, "auto", { forceVision: false, forceEmit: false });
  }

  private async processFrame(
    frame: ScreenFrame,
    mode: ScreenCaptureMode,
    opts: { forceVision: boolean; forceEmit: boolean },
    tracer?: FrameTracer
  ): Promise<ScreenContextEvent | null> {
    const jobId = ++this.jobSeq;
    const isStale = (): boolean => jobId !== this.jobSeq;
    const now = Date.now();
    try {
      this.lastFrameInfo = { width: frame?.width || 0, height: frame?.height || 0, bytes: frame?.data?.length || 0 };
    } catch {
      // ignore
    }
    const fail = (stage: ScreenFailureStage, message: string): void => {
      try {
        this.emit("screen-failure", { stage, message: String(message || "").slice(0, 500), at: Date.now() } as ScreenFailureInfo);
      } catch {
        // ignore
      }
    };

    // --- OCR (local first: cleaned text feeds everything downstream) ---
    this.ocrState = "processing";
    this.emitStatus();
    let ocrText = "";
    let ocrConfidence = 0;
    try {
      const available = await this.ocr.isAvailable();
      if (tracer) tracer.ocrAvailable = !!available;
      if (!available) {
        this.ocrState = "unavailable";
        if (tracer) tracer.ocrCall = "SKIPPED";
        fail("ocr", `OCR provider unavailable (${this.getOcrName()})`);
      } else {
        if (tracer) tracer.ocrCall = "EXECUTED";
        const res = await this.ocr.recognize({ data: frame.data, encoding: frame.encoding, width: frame.width, height: frame.height });
        if (isStale()) return null;
        // Cleaned OCR (not raw) is the single source of truth downstream:
        // noise stays out of context, detection, fusion and answers, while
        // code structure (operators, brackets, indentation) is preserved.
        ocrText = truncateOcrText(cleanOcrText(res.text || ""), this.opts.maxScreenChars);
        ocrConfidence = res.confidence ?? 0;
        this.ocrState = "ready";
        if (tracer) {
          tracer.ocrChars = ocrText.length;
          tracer.ocrPreview = ocrText.slice(0, 200);
        }
      }
    } catch (e) {
      if (isStale()) return null;
      logger.warn("Screen OCR failed", String(e));
      this.ocrState = "error";
      ocrText = "";
      const msg = String(e);
      if (tracer) {
        tracer.ocrCall = "EXECUTED";
        tracer.ocrError = msg.slice(0, 300);
      }
      fail("ocr", msg);
    }
    this.emitStatus();

    // --- Relevant-content extraction (strip platform/UI chrome) ---
    // A busy screen carries headers, timers and buttons around the actual
    // interview content. Only the relevant core becomes event text and the
    // question-detection input; the full cleaned OCR still reaches vision as
    // fallback context.
    const relevant = extractRelevantScreenContent(ocrText, this.opts.maxScreenChars);
    const relevantText = relevant.relevantText;

    // --- Vision (gated: only when OCR cannot carry the meaning alone) ---
    // Local OCR stays the default path. Remote vision runs only for manual
    // region captures or when the cleaned text signals genuinely visual
    // content: diagrams, code whose structure OCR lost, or suspiciously
    // short text that may be a label on a richer visual.
    const codeSignal = looksLikeCode(relevantText || ocrText);
    const diagramSignal = looksLikeDiagram(relevantText || ocrText);
    const wantVision =
      opts.forceVision ||
      diagramSignal ||
      (codeSignal && ocrLooksLossy(ocrText, ocrConfidence)) ||
      (relevantText.trim().length > 0 && relevantText.trim().length < this.opts.visionMinTextChars);
    let visionSummary: string | undefined;
    let visionQuestion: string | undefined;
    let visionCode: ScreenContextEvent["code"];
    let visionDiagram: string | undefined;
    let visionConfidence = 0;
    let origin: ScreenContextEvent["origin"] = "ocr";

    if (wantVision && this.opts.visionMode === "remote" && this.vision.remote) {
      let available = false;
      try {
        available = await this.vision.isAvailable();
      } catch {
        available = false;
      }
      if (tracer) tracer.visionAttempted = available;
      if (available) {
        this.visionState = "processing";
        this.emitStatus();
        const ctrl = new AbortController();
        this.visionCtrl = ctrl;
        try {
          const res = await this.vision.analyzeImage(
            { data: frame.data, mimeType: "image/png" },
            {
              screenText: relevantText || ocrText || undefined,
              recentTranscript: lastInterviewText(this.context, 800),
            },
            { signal: ctrl.signal }
          );
          if (isStale()) return null;
          visionSummary = (res.summary || "").slice(0, this.opts.maxScreenChars);
          visionQuestion = res.detectedQuestion?.slice(0, 1000);
          if (res.code?.text) visionCode = { language: res.code.language, text: res.code.text.slice(0, 2000) };
          visionDiagram = res.diagramDescription?.slice(0, 1500);
          visionConfidence = res.confidence ?? 0;
          origin = "vision";
          this.visionState = "ready";
        } catch (e) {
          if (isStale()) return null;
          logger.warn("Screen vision failed", String(e));
          this.visionState = "error";
          if (tracer) tracer.visionNote = String(e).slice(0, 300);
          fail("vision", String(e));
        } finally {
          if (this.visionCtrl === ctrl) this.visionCtrl = null;
        }
        this.emitStatus();
      }
    }

    if (isStale()) return null;

    // Vision summaries are already structured; otherwise the relevant
    // extracted core (not raw OCR, not UI chrome) becomes the event text.
    const text = truncateOcrText(visionSummary || relevantText, this.opts.maxScreenChars);
    if (!text && !visionQuestion && !visionCode) {
      fail("empty", "capture + OCR produced no usable text (empty frame or blank screen?)");
      return null; // Nothing useful extracted.
    }

    const detected = detectScreenQuestion(visionQuestion || text, this.detector, {
      minConfidence: this.opts.questionMinConfidence,
      code: visionCode,
      diagramDescription: visionDiagram,
    });

    const event: ScreenContextEvent = {
      id: nextScreenEventId(),
      timestamp: now,
      source: mode,
      mode,
      text,
      visualSummary: visionSummary,
      detectedQuestion: detected?.question || visionQuestion,
      code: detected?.code || visionCode,
      diagramDescription: detected?.diagramDescription || visionDiagram,
      region: frame.region ? { ...frame.region } : undefined,
      confidence: Math.max(ocrConfidence, visionConfidence, detected?.confidence ?? 0),
      origin,
    };

    // --- Debounce / dedup (Phase 18) ---
    if (!opts.forceEmit) {
      if (now - this.lastEmitAt < this.opts.minEventGapMs) return null;
      if (this.isDuplicate(event.text, now)) return null;
    }
    this.remember(event.text, now);

    // --- Store bounded screen context (Phase 10) ---
    this.context.ingestScreen(event);
    this.recentEvents.push(event);
    while (this.recentEvents.length > 20) this.recentEvents.shift();
    this.lastText = event.detectedQuestion || event.text;
    this.lastEmitAt = now;
    this.lastEventAt = now;
    this.emit("screen-context", event);
    this.emitStatus();

    // --- Fusion -> shared question pipeline (Phases 11, 17) ---
    this.maybeEmitQuestion(event, detected?.type);
    return event;
  }

  private maybeEmitQuestion(event: ScreenContextEvent, detectedType?: string): void {
    const recent = this.context.recent(10);
    const fused = fuseQuestionContext({
      recentContext: recent,
      screen: event,
      screenMaxAgeMs: this.opts.fusionMaxAgeMs,
    });
    // Emit only when the screen actually contributes a question.
    if (fused.origin === "audio" || !fused.text) return;
    const cls = this.detector.classify(fused.text);
    const type = (detectedType as QuestionDetectedEvent["type"]) ||
      (cls.isQuestion ? cls.type : looksLikeCode(fused.text) ? "coding" : looksLikeDiagram(fused.text) ? "system_design" : "general");
    const confidence = Math.max(cls.confidence || 0, fused.confidence, 0.55);
    if (!this.detector.shouldEmit(fused.text, event.timestamp)) return;
    const q: QuestionDetectedEvent = {
      id: nextScreenQuestionId(),
      question: fused.text.length > 800 ? fused.text.slice(0, 800) : fused.text,
      speaker: "interviewer",
      source: "system",
      type,
      confidence: Math.min(confidence, 0.99),
      timestamp: event.timestamp,
      transcriptEventId: `screen:${event.id}`,
      recentContext: recent.slice(-6),
      screenContextIds: [event.id],
      origin: fused.origin,
      fusedContext: fused.origin === "fused" ? fused.text.slice(0, 1200) : undefined,
    };
    this.detector.remember(fused.text, q.id, event.timestamp);
    this.emit("screen-question", q);
  }

  private isDuplicate(text: string, now: number): boolean {
    const normalized = normalizeQuestionText(text).slice(0, 500);
    if (!normalized) return true;
    for (let i = this.seen.length - 1; i >= 0; i--) {
      const s = this.seen[i];
      if (now - s.ts > this.opts.dedupeWindowMs) {
        this.seen.splice(i, 1);
        continue;
      }
      if (s.normalized === normalized) return true;
    }
    return false;
  }

  private remember(text: string, now: number): void {
    const normalized = normalizeQuestionText(text).slice(0, 500);
    if (!normalized) return;
    this.seen.push({ normalized, ts: now });
    while (this.seen.length > 64) this.seen.shift();
  }

  private emitStatus(): void {
    this.emit("status", this.getStatus());
  }
}

function lastInterviewText(context: InterviewContext, maxChars: number): string {
  const recent = context.recent(6);
  const parts: string[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (e.speaker === "interviewer" && (e.kind || "transcript") === "transcript") {
      parts.push(e.text);
      if (parts.join(" ").length >= maxChars) break;
    }
  }
  return parts.reverse().join(" ").slice(0, maxChars);
}

/**
 * True when cleaned OCR likely lost the visual structure (low provider
 * confidence, replacement characters, or a code signal with almost no
 * surviving code lines). Only then is a code screenshot worth a gated
 * vision call; well-extracted code stays fully local.
 */
export function ocrLooksLossy(ocrText: string, confidence: number): boolean {
  const t = ocrText || "";
  if (Number.isFinite(confidence) && confidence < 0.35 && t.trim().length > 0) return true;
  if (/�/.test(t)) return true;
  const lines = t.split("\n").filter((l) => l.trim().length > 0);
  const codeLines = lines.filter(
    (l) => /^[ \t]+/.test(l) || /[{};]$/.test(l.trim()) || /```/.test(l)
  ).length;
  if (lines.length >= 4 && codeLines <= 1) return true;
  return false;
}

/** Sampled non-zero check (content proof without touching every byte). */
function sampleNonEmpty(data: Buffer | undefined | null): boolean {
  if (!data || data.length === 0) return false;
  const step = Math.max(1, Math.floor(data.length / 4096));
  for (let i = 0; i < data.length; i += step) {
    if ((data as Buffer)[i] !== 0) return true;
  }
  return false;
}

async function safeAvailable(provider: { isAvailable(): Promise<boolean> | boolean }): Promise<boolean> {
  try {
    return !!(await provider.isAvailable());
  } catch {
    return false;
  }
}
