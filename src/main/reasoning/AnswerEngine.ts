/**
 * AnswerEngine: fast + strong answer generation with stale-generation
 * protection (same concept as the visual-job cancellation).
 *
 * Flow: question -> fast draft (fast provider) -> refined answer (strong
 * provider). Each answer() call bumps a generation counter; late results
 * from superseded generations are marked stale and never emitted as active.
 */

import { EventEmitter } from "events";
import { AnswerEvent, QuestionType } from "../../common/types";
import { ScreenContextEvent } from "../../common/screen-types";
import { ContextEntry } from "../../common/types";
import { CandidateProfile } from "../candidates/CandidateProfile";
import { Persona, CandidateMode } from "../candidates/Persona";
import { JobDescription } from "../candidates/JobDescription";
import { ModelRouter } from "./ModelRouter";
import { LLMProvider } from "./LLMProvider";
import { AnswerLength, buildAnswerPrompt } from "./PromptBuilder";
import { logger } from "../logger";

let __answerCounter = 0;
function nextAnswerId(): string {
  __answerCounter += 1;
  return `ans-${Date.now().toString(36)}-${__answerCounter.toString(36)}`;
}

export interface AnswerRequest {
  questionId: string;
  question: string;
  questionType?: QuestionType;
  recentContext?: ContextEntry[];
  screenEvents?: ScreenContextEvent[];
  candidateProfile?: string;
  jobDescription?: string;
  profile?: CandidateProfile;
  persona?: Persona;
  jobDesc?: JobDescription;
  candidateMode?: CandidateMode;
  answerLength?: AnswerLength;
  maxScreenChars?: number;
  maxRecentEntries?: number;
}

export interface AnswerResult {
  questionId: string;
  fast: string;
  strong: string;
  fastModel: string;
  strongModel: string;
}

export interface AnswerErrorEvent {
  questionId: string;
  question: string;
  message: string;
  timestamp: number;
}

/** Per-type answer strategies (Phase 20). */
export function strategySystemPrompt(type: QuestionType | undefined, fast: boolean): string {
  const base = "You are Intervia. ";
  const t = type || "general";
  switch (t) {
    case "behavioral":
      return base + "Use STAR-like reasoning internally (Situation, Task, Action, Result); speak naturally without reciting STAR headings." + (fast ? " Give a fast, short draft (2-4 sentences max)." : " Give a polished complete answer with a concrete example and outcome.");
    case "resume":
      return base + "Ground STRICTLY in the verified candidate facts provided. Never add employers, projects, or metrics not listed." + (fast ? " Fast short draft." : " Complete grounded answer.");
    case "technical":
      return base + "Give an accurate explanation with the key mechanism first, then brief detail." + (fast ? " Fast short draft." : " Complete answer.");
    case "coding":
      return base + "Give approach first, then code, then complexity and edge cases." + (fast ? " Fast: approach + key idea only." : " Complete: approach, code, complexity, edge cases.");
    case "system_design":
      return base + "Cover requirements, architecture, data flow, trade-offs, and scalability." + (fast ? " Fast: core architecture sketch." : " Complete structured design discussion.");
    case "follow_up":
      return base + "Build directly on the recent interview context; stay consistent with what was just said. Resolve pronouns (it/they/that/this) against the recent context — never treat a follow-up as a standalone question." + (fast ? " Fast short draft." : " Complete answer.");
    case "conceptual":
      return base + "Explain the concept clearly with a brief example." + (fast ? " Fast short draft." : " Complete answer.");
    default:
      return base + (fast ? "Give a fast, short draft answer (2-4 sentences max)." : "Give a polished, complete interview answer grounded in the context.");
  }
}

export class AnswerEngine extends EventEmitter {
  private router: ModelRouter;
  private generation = 0;
  private lastResult: AnswerResult | null = null;
  /** Abort handle for the in-flight HTTP generation (hard cancel, not just ignore). */
  private activeAbort: AbortController | null = null;

  constructor(router: ModelRouter) {
    super();
    this.router = router;
  }

  /** Cancel in-flight work: aborts HTTP + drops late results on arrival. */
  cancel(): void {
    this.generation += 1;
    try {
      this.activeAbort?.abort();
    } catch {
      // ignore
    }
    this.activeAbort = null;
  }

  /** Runtime provider swap (Setup configuration): cancels in-flight work first. */
  setProviders(fast: LLMProvider, strong?: LLMProvider): void {
    this.cancel();
    this.router.setProviders(fast, strong);
  }

  /** Live provider names for status/diagnostics (no network). */
  providerNames(): { fast: string; strong: string } {
    return { fast: this.activeName("fast"), strong: this.activeName("strong") };
  }

  private activeName(which: "fast" | "strong"): string {
    try {
      const p = which === "fast" ? this.router.route("fast-answer") : this.router.route("strong-answer");
      const r = p as unknown as Record<string, unknown>;
      if (typeof r["getLastModel"] === "function") {
        const m = String((r["getLastModel"] as () => unknown)() || "");
        if (m) return m;
      }
      if (typeof r["getLastTier"] === "function") {
        const t = String((r["getLastTier"] as () => unknown)() || "");
        if (t) return t;
      }
      return p.name;
    } catch {
      return which === "fast" ? this.router.getFastName() : this.router.getStrongName();
    }
  }

  currentGeneration(): number {
    return this.generation;
  }

  getLastResult(): AnswerResult | null {
    return this.lastResult;
  }

  /**
   * Run one generation through a provider: stream progressively when the
   * provider supports it (partial emission for the overlay), otherwise fall
   * back to a single await. Stream failures with no text yet fall back to
   * generate(); partial text already shown is kept and finished as final.
   */
  private async runGeneration(
    provider: LLMProvider,
    prompt: string,
    system: string,
    maxTokens: number,
    signal: AbortSignal,
    onPartial: (text: string) => void
  ): Promise<{ text: string; latencyMs: number; model: string }> {
    const t0 = Date.now();
    if (typeof provider.generateStream === "function") {
      try {
        const r = await provider.generateStream({ prompt, system, maxTokens, signal }, (delta) => {
          if (delta) onPartial(delta);
        });
        return { text: (r.text || "").trim(), latencyMs: r.latencyMs, model: r.model };
      } catch (e) {
        if (signal.aborted) throw e; // hard cancel: no fallback, caller checks staleness
      }
    }
    const r = await provider.generate({ prompt, system, maxTokens, signal });
    return { text: (r.text || "").trim(), latencyMs: r.latencyMs, model: r.model };
  }

  async answer(req: AnswerRequest): Promise<AnswerResult> {
    // A new question hard-cancels the previous HTTP generation first.
    try {
      this.activeAbort?.abort();
    } catch {
      // ignore
    }
    const gen = ++this.generation;
    const isStale = (): boolean => gen !== this.generation;
    const ctrl = new AbortController();
    this.activeAbort = ctrl;
    const length = req.answerLength || "medium";
    const fastPrompt = buildAnswerPrompt(
      {
        question: req.question,
        questionType: req.questionType,
        recentContext: req.recentContext || [],
        screenEvents: req.screenEvents || [],
        candidateProfile: req.candidateProfile,
        jobDescription: req.jobDescription,
        profile: req.profile,
        persona: req.persona,
        jobDesc: req.jobDesc,
        candidateMode: req.candidateMode,
        answerLength: "short",
        maxScreenChars: req.maxScreenChars,
        maxRecentEntries: req.maxRecentEntries,
      },
      { fast: true }
    );
    const strongPromptBase = buildAnswerPrompt({
      question: req.question,
      questionType: req.questionType,
      recentContext: req.recentContext || [],
      screenEvents: req.screenEvents || [],
      candidateProfile: req.candidateProfile,
      jobDescription: req.jobDescription,
      profile: req.profile,
      persona: req.persona,
      jobDesc: req.jobDesc,
      candidateMode: req.candidateMode,
      answerLength: length,
      maxScreenChars: req.maxScreenChars,
      maxRecentEntries: req.maxRecentEntries,
    });

    const fastProvider = this.router.route("fast-answer");
    const strongProvider = this.router.route("strong-answer");

    // Progressive fast emission: partials render in the overlay as they
    // arrive (throttled); only the final text enters history downstream.
    const partialId = nextAnswerId();
    let partialText = "";
    let lastPartialEmit = 0;
    const emitFastPartial = (delta: string): void => {
      partialText += delta;
      const now = Date.now();
      if (isStale() || ctrl.signal.aborted) return;
      if (now - lastPartialEmit < 250 && partialText.length < 40) return;
      lastPartialEmit = now;
      this.emit("fast-answer", {
        id: partialId,
        questionId: req.questionId,
        question: req.question,
        kind: "fast",
        text: partialText,
        model: fastProvider.name,
        timestamp: now,
        partial: true,
      } as AnswerEvent);
    };

    let fastText = "";
    let fastFailed = false;
    let fastLatency = 0;
    let fastModelUsed = fastProvider.name;
    try {
      const fast = await this.runGeneration(
        fastProvider,
        fastPrompt,
        strategySystemPrompt(req.questionType, true),
        220,
        ctrl.signal,
        emitFastPartial
      );
      fastText = fast.text;
      fastLatency = fast.latencyMs;
      if (fast.model) fastModelUsed = fast.model;
    } catch (e) {
      if (!ctrl.signal.aborted) logger.warn("AnswerEngine fast generation failed", String(e));
      fastFailed = true;
      fastText = partialText.trim();
    }
    if (fastText && !isStale()) {
      const evt: AnswerEvent = {
        id: nextAnswerId(),
        questionId: req.questionId,
        question: req.question,
        kind: "fast",
        text: fastText,
        model: fastModelUsed,
        timestamp: Date.now(),
        latencyMs: fastLatency,
      };
      this.emit("fast-answer", evt);
    }

    let strongText = "";
    let strongFailed = false;
    let strongLatency = 0;
    let strongModelUsed = strongProvider.name;
    const strongPartialId = nextAnswerId();
    let strongPartialText = "";
    let lastStrongPartialEmit = 0;
    try {
      const strong = await this.runGeneration(
        strongProvider,
        fastText ? `${strongPromptBase}\n\nFAST DRAFT (improve and expand on this):\n${fastText}` : strongPromptBase,
        strategySystemPrompt(req.questionType, false),
        length === "short" ? 300 : 600,
        ctrl.signal,
        (delta) => {
          strongPartialText += delta;
          const now = Date.now();
          if (isStale() || ctrl.signal.aborted) return;
          if (now - lastStrongPartialEmit < 250 && strongPartialText.length < 40) return;
          lastStrongPartialEmit = now;
          this.emit("strong-answer", {
            id: strongPartialId,
            questionId: req.questionId,
            question: req.question,
            kind: "strong",
            text: strongPartialText,
            model: strongProvider.name,
            timestamp: now,
            partial: true,
          } as AnswerEvent);
        }
      );
      strongText = strong.text;
      strongLatency = strong.latencyMs;
      if (strong.model) strongModelUsed = strong.model;
    } catch (e) {
      if (!ctrl.signal.aborted) logger.warn("AnswerEngine strong generation failed", String(e));
      strongFailed = true;
      strongText = strongPartialText.trim() || fastText;
      if (strongText === fastText) strongModelUsed = fastModelUsed;
    }

    // Offline/unavailable behavior (Phase 28): explicit error event so the UI
    // can show "Answer generation unavailable" while question/session/context
    // stay intact. Never throws out of answer().
    if (!fastText && !strongText) {
      const err: AnswerErrorEvent = {
        questionId: req.questionId,
        question: req.question,
        message: fastFailed || strongFailed ? "Answer generation unavailable" : "Answer generation returned empty",
        timestamp: Date.now(),
      };
      if (!isStale()) this.emit("answer-error", err);
    }

    if (this.activeAbort === ctrl) this.activeAbort = null;
    const result: AnswerResult = {
      questionId: req.questionId,
      fast: fastText,
      strong: strongText,
      fastModel: fastModelUsed,
      strongModel: strongModelUsed,
    };
    if (!isStale()) {
      this.lastResult = result;
      if (strongText) {
        const evt: AnswerEvent = {
          id: nextAnswerId(),
          questionId: req.questionId,
          question: req.question,
          kind: "strong",
          text: strongText,
          model: strongModelUsed,
          timestamp: Date.now(),
          latencyMs: strongLatency,
        };
        this.emit("strong-answer", evt);
      }
    } else {
      // Stale: notify for observability but flag it so UI ignores it.
      const evt: AnswerEvent = {
        id: nextAnswerId(),
        questionId: req.questionId,
        question: req.question,
        kind: strongText ? "strong" : "fast",
        text: strongText || fastText,
        model: strongText ? strongModelUsed : fastModelUsed,
        timestamp: Date.now(),
        stale: true,
      };
      this.emit("stale-answer", evt);
    }
    return result;
  }
}
