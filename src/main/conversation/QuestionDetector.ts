import { EventEmitter } from "events";
import { QuestionDetectedEvent, QuestionType, ContextEntry, TranscriptEvent } from "../../common/types";
import { logger } from "../logger";

let __idCounter = 0;
function nextId(): string { __idCounter += 1; return __idCounter.toString(36); }

export interface QuestionDetectorOptions {
  contextWindow: number;       // # of recent entries to attach
  dedupeWindowMs: number;      // suppress identical questions within this window
  dedupeSimilarity: number;    // 0..1 threshold for normalized-text similarity
}

const DEFAULTS: QuestionDetectorOptions = {
  contextWindow: 6,
  dedupeWindowMs: 8000,
  dedupeSimilarity: 0.85,
};

const CODING_KEYWORDS = [
  "write a function", "write a method", "write a class", "write a script",
  "write a program", "write code", "implement", "code a", "code this",
  "in python", "in javascript", "in java", "in c++", "in go", "in rust",
  "in typescript", "algorithm", "solve this", "sort an array", "reverse a linked",
  "binary search", "two sum", "fizzbuzz", "fibonacci", "palindrome",
  "merge two", "find duplicates", "find the missing", "leetcode",
];

const SYSTEM_DESIGN_KEYWORDS = [
  "design a", "how would you design", "system design", "scale ", "scale?",
  "architecture", "distributed", "load balancer", "sharding", "cache",
  "high availability", "throughput", "latency", "design twitter", "design url",
  "design instagram", "design uber", "design dropbox", "design youtube",
  "design netflix", "design whatsapp", "design slack", "design tiktok",
  "design airbnb", "design yelp",
];

const TECHNICAL_KEYWORDS = [
  "difference between", "what is ", "what's ", "explain", "how does ",
  "why does ", "what are ", "what happens when ", "what would happen",
  "how is ", "how do ", "what's the difference", "compare ", "trade-off",
  "tradeoff", "complexity", "time complexity", "space complexity",
  "big o", "big-o", "useeffect", "usememo", "usecallback", "usestate",
  "virtual dom", "react", "vue", "angular", "node.js", "nodejs",
  "rest api", "graphql", "sql", "nosql", "postgres", "mongodb",
  "kafka", "redis", "docker", "kubernetes", "aws", "azure", "gcp",
  "thread", "threading", "mutex", "race condition", "deadlock",
  "memory leak", "garbage collection", "http", "https", "tcp", "udp",
];

const BEHAVIORAL_KEYWORDS = [
  "tell me about a time", "tell me about a situation", "tell me about a project",
  "tell me about yourself", "difficult project", "challenging project",
  "difficult situation", "challenging situation",
  "describe a situation", "describe a time",
  "describe a project", "describe a challenge", "describe a conflict",
  "biggest challenge", "most difficult", "most challenging", "toughest",
  "failed", "failure", "mistake", "what did you learn", "what would you do differently",
  "worked with a team", "disagreement", "conflict with", "leadership",
  "lead a team", "stakeholder", "mentor", "initiative", "ownership",
  "prioritize", "deadline", "pressure", "feedback", "constructive criticism",
];

const RESUME_KEYWORDS = [
  "your experience", "your background", "your resume", "your previous role",
  "your last project", "your role at", "responsibilities at", "why did you leave",
  "why are you leaving", "what did you do at", "what was your role",
  "years of experience", "worked on at", "your contribution",
];

const FOLLOWUP_INDICATORS = [
  "follow up", "follow-up", "you mentioned", "going back to", "earlier you said",
  "as you said", "regarding that", "about that", "elaborate", "can you explain that",
  "tell me more", "more on that", "more about that", "can you go deeper",
  "can you elaborate", "what about ", "and why", "how so", "why specifically",
  "specifically", "more detail", "in more detail",
];

const NON_QUESTION_PHRASES = [
  "okay", "ok ", "yeah", "yes ", "no ", "sure", "right", "exactly",
  "got it", "i see", "makes sense", "sounds good", "cool", "great",
  "interesting", "let's continue", "let me explain", "give me a second",
  "one moment", "hold on", "moving on", "next question", "thank you",
];

const STATEMENT_PREFIXES = [
  "let me ", "i will ", "i'll ", "i would ", "i want to ", "i'd like to ",
  "here is ", "here's ", "so basically", "moving on",
];

const POSITIVE_FILLERS = ["um", "uh", "hmm", "well", "so ", "let's see", "let me think"];

/**
 * Words that almost never end a complete interview question. A fragment
 * ending in one of these ("Can you tell me", "What about the") is held
 * briefly for its continuation instead of triggering an answer alone.
 */
const CONTINUATION_WORDS = new Set([
  "about", "to", "with", "for", "of", "and", "or", "the", "a", "an",
  "your", "you", "me", "my", "that", "this", "these", "those",
  "in", "on", "at", "from", "into", "how", "what", "which",
  "explain", "describe", "tell",
]);

const FRAGMENT_HOLD_MS = 8000;

function hasTerminalPunctuation(text: string): boolean {
  return /[?!.…:]\s*$/.test((text || "").trim());
}

/**
 * Weak-fragment test: classified as a question only by a low-confidence
 * heuristic, with no terminal punctuation, trailing into a continuation.
 * Such fragments are HELD (not emitted) until the rest arrives or the
 * window expires — this is what merges "Can you tell me" + "about X?".
 */
export function isWeakFragment(
  text: string,
  cls: { isQuestion: boolean; confidence: number }
): boolean {
  if (!cls.isQuestion || cls.confidence >= 0.85) return false;
  const cleaned = (text || "").trim();
  if (!cleaned || hasTerminalPunctuation(cleaned)) return false;
  const words = normalizeQuestionText(cleaned).split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 12) return false;
  return CONTINUATION_WORDS.has(words[words.length - 1]);
}

export function normalizeQuestionText(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeQuestionText(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeQuestionText(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

export class QuestionDetector extends EventEmitter {
  private opts: QuestionDetectorOptions;
  private recentQuestions: Array<{ text: string; normalized: string; ts: number; id: string }> = [];
  /** Weak fragment awaiting its continuation (never emitted yet). */
  private pendingFragment: {
    text: string;
    cls: { isQuestion: boolean; type: QuestionType; confidence: number; reason: string };
    speaker: string;
    source: string;
    ts: number;
    merges: number;
  } | null = null;
  /** Last EMITTED question (for post-emit continuation merges). */
  private lastEmitted: { text: string; ts: number; speaker: string; source: string; id: string } | null = null;

  constructor(opts?: Partial<QuestionDetectorOptions>) {
    super();
    this.opts = { ...DEFAULTS, ...(opts || {}) };
  }

  /**
    * Classify a single interviewer utterance and decide whether it is a question.
    * Pure function (no event emission) so it is testable in isolation.
    */
  classify(text: string): { isQuestion: boolean; type: QuestionType; confidence: number; reason: string } {
    const cleaned = (text || "").trim();
    if (!cleaned) {
      return { isQuestion: false, type: "general", confidence: 0, reason: "empty" };
    }
    const lower = " " + cleaned.toLowerCase() + " ";
    const stripped = lower
      .replace(/[^\w\s?]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // First: short non-question phrases.
    if (NON_QUESTION_PHRASES.some((p) => stripped === p.trim() || stripped.startsWith(p.trim() + " ") || stripped.endsWith(" " + p.trim()))) {
      const veryShort = stripped.split(" ").length <= 4;
      if (veryShort) {
        return { isQuestion: false, type: "general", confidence: 0.95, reason: "acknowledgement" };
      }
    }

    // Statement prefixes: "let me explain...", "i will...", etc. These are not questions
    // even if they contain technical keywords.
    if (STATEMENT_PREFIXES.some((p) => stripped.startsWith(p))) {
      return { isQuestion: false, type: "general", confidence: 0.9, reason: "statement-prefix" };
    }

    let confidence = 0;
    let type: QuestionType = "general";
    let reason = "";

    const hasQuestionMark = cleaned.includes("?");
    if (hasQuestionMark) { confidence += 0.5; reason = "?"; }

    if (BEHAVIORAL_KEYWORDS.some((k) => stripped.includes(k))) {
      type = "behavioral"; confidence = Math.max(confidence, 0.92); reason = reason || "behavioral-keyword";
    } else if (RESUME_KEYWORDS.some((k) => stripped.includes(k))) {
      type = "resume"; confidence = Math.max(confidence, 0.9); reason = reason || "resume-keyword";
    } else if (CODING_KEYWORDS.some((k) => stripped.includes(k))) {
      type = "coding"; confidence = Math.max(confidence, 0.94); reason = reason || "coding-keyword";
    } else if (SYSTEM_DESIGN_KEYWORDS.some((k) => stripped.includes(k))) {
      type = "system_design"; confidence = Math.max(confidence, 0.94); reason = reason || "system-design-keyword";
    } else if (TECHNICAL_KEYWORDS.some((k) => stripped.includes(k))) {
      type = "technical"; confidence = Math.max(confidence, 0.85); reason = reason || "technical-keyword";
    }

    if (FOLLOWUP_INDICATORS.some((k) => stripped.includes(k))) {
      // Follow-up overrides unless already a strong behavioral/technical match.
      if (type === "general" || confidence < 0.9) {
        type = "follow_up"; confidence = Math.max(confidence, 0.78);
      }
      reason = reason ? reason + "+followup" : "followup-keyword";
    }

    // Heuristic for interview questions without punctuation: leading wh-words or "tell me".
    if (!hasQuestionMark) {
      const startsWithWh = /^\s*(what|why|how|when|where|who|which|can you|could you|would you|do you|did you|are you|is there|tell me|describe|explain|walk me through|give me an example)\b/i.test(cleaned);
      const imperativeVerb = /^\s*(tell me|describe|explain|walk me through|share|give me|show me|list|name)\b/i.test(cleaned);
      if (startsWithWh || imperativeVerb) {
        confidence = Math.max(confidence, 0.7);
        if (!reason) reason = "interview-imperative";
      }
    }

    // Strip leading fillers that shouldn't count as substance.
    const fillerStripped = POSITIVE_FILLERS.some((f) => stripped.startsWith(f.trim() + " ")) ? stripped : stripped;

    // Final decision: above threshold and at least some confidence.
    const isQuestion = confidence >= 0.5;
    return { isQuestion, type, confidence: Math.min(confidence, 0.99), reason: reason || "below-threshold" };
  }

  shouldEmit(text: string, now: number = Date.now()): boolean {
    const normalized = normalizeQuestionText(text);
    if (!normalized) return false;
    for (let i = this.recentQuestions.length - 1; i >= 0; i--) {
      const q = this.recentQuestions[i];
      if (now - q.ts > this.opts.dedupeWindowMs) {
        this.recentQuestions.splice(i, 1);
        continue;
      }
      if (q.normalized === normalized) return false;
      if (tokenSimilarity(q.normalized, normalized) >= this.opts.dedupeSimilarity) return false;
    }
    return true;
  }

  remember(text: string, id: string, now: number = Date.now()): void {
    this.recentQuestions.push({ text, normalized: normalizeQuestionText(text), ts: now, id });
    while (this.recentQuestions.length > 32) this.recentQuestions.shift();
  }

  /**
    * Process a finalized interviewer transcript and emit a QuestionDetectedEvent when applicable.
    *
    * Fragment assembly: a weak fragment ("Can you tell me") is held, not
    * emitted; the continuation ("about a difficult project?") completes it
    * into ONE logical question. A strong fragment that already emitted can
    * still be superseded when its unpunctuated tail continues ("Tell me
    * about your experience" + "at your last company") — the merged event
    * carries `supersedes` so history marks the fragment's answers stale.
    */
  handle(evt: TranscriptEvent, recentContext: ContextEntry[]): QuestionDetectedEvent | null {
    if (!evt.isFinal) return null;
    if (evt.speaker !== "interviewer") return null;
    const now = evt.timestamp;
    const text = evt.text.trim();

    // 1. Expired / foreign pending fragment flushes through the normal path.
    let flushed: QuestionDetectedEvent | null = null;
    if (this.pendingFragment) {
      const p = this.pendingFragment;
      const foreign = p.speaker !== evt.speaker || p.source !== evt.source;
      if (foreign || now - p.ts > FRAGMENT_HOLD_MS) {
        this.pendingFragment = null;
        flushed = this.emitQuestion(p.text, p.cls, evt, recentContext, now);
      }
    }

    const cls = this.classify(text);

    // 2a. Live pending fragment from the same voice: extend and re-evaluate.
    if (this.pendingFragment && !flushed) {
      const p = this.pendingFragment;
      if (p.speaker === evt.speaker && p.source === evt.source && now - p.ts <= FRAGMENT_HOLD_MS) {
        const combined = `${p.text} ${text}`.replace(/\s+/g, " ").trim().slice(0, 1000);
        const combinedCls = this.classify(combined);
        this.pendingFragment = null;
        if (combinedCls.isQuestion) {
          if (isWeakFragment(combined, combinedCls) && p.merges < 1) {
            this.pendingFragment = { text: combined, cls: combinedCls, speaker: evt.speaker, source: evt.source, ts: now, merges: p.merges + 1 };
            return flushed;
          }
          this.remember(p.text, `frag-${now.toString(36)}`, now);
          return this.emitQuestion(combined, combinedCls, evt, recentContext, now) || flushed;
        }
        // Combined is not a question (e.g. "Okay" + "right") — evaluate the
        // new fragment on its own; the stale pending dies quietly.
        if (!cls.isQuestion) return flushed;
      } else {
        this.pendingFragment = null;
      }
    }

    // 2b. Post-emit continuation: the tail alone is NOT a standalone
    // question, but appended to the unpunctuated emitted question it
    // completes it ("...experience" + "at your last company."). A tail that
    // IS a full question on its own is never swallowed — it emits normally.
    if (
      !cls.isQuestion &&
      this.lastEmitted &&
      this.lastEmitted.speaker === evt.speaker &&
      this.lastEmitted.source === evt.source &&
      now - this.lastEmitted.ts <= FRAGMENT_HOLD_MS &&
      !hasTerminalPunctuation(this.lastEmitted.text)
    ) {
      const combined = `${this.lastEmitted.text} ${text}`.replace(/\s+/g, " ").trim().slice(0, 1000);
      const combinedCls = this.classify(combined);
      if (combinedCls.isQuestion && this.shouldEmit(combined, now)) {
        const supersedes = this.lastEmitted.id;
        this.remember(combined, `mrg-${now.toString(36)}`, now);
        const question: QuestionDetectedEvent = {
          id: nextId(),
          question: combined,
          speaker: evt.speaker,
          source: evt.source,
          type: combinedCls.type,
          confidence: combinedCls.confidence,
          timestamp: now,
          transcriptEventId: evt.id,
          recentContext: recentContext.slice(-this.opts.contextWindow),
          origin: "audio",
          supersedes,
        };
        this.lastEmitted = { text: combined, ts: now, speaker: evt.speaker, source: evt.source, id: question.id };
        this.emit("question", question);
        return question;
      }
      return flushed;
    }

    if (!cls.isQuestion) return flushed;

    // 2c. Weak fragment: hold for continuation instead of answering alone.
    if (isWeakFragment(text, cls)) {
      this.pendingFragment = { text, cls, speaker: evt.speaker, source: evt.source, ts: now, merges: 0 };
      return flushed;
    }

    return this.emitQuestion(text, cls, evt, recentContext, now) || flushed;
  }

  private emitQuestion(
    text: string,
    cls: { isQuestion: boolean; type: QuestionType; confidence: number; reason: string },
    evt: TranscriptEvent,
    recentContext: ContextEntry[],
    now: number
  ): QuestionDetectedEvent | null {
    if (!this.shouldEmit(text, now)) return null;
    const question: QuestionDetectedEvent = {
      id: nextId(),
      question: text.trim(),
      speaker: evt.speaker,
      source: evt.source,
      type: cls.type,
      confidence: cls.confidence,
      timestamp: now,
      transcriptEventId: evt.id,
      recentContext: recentContext.slice(-this.opts.contextWindow),
      origin: "audio",
    };
    this.remember(text, question.id, now);
    this.lastEmitted = { text: text.trim(), ts: now, speaker: evt.speaker, source: evt.source, id: question.id };
    this.emit("question", question);
    return question;
  }

  resetDedup(): void {
    this.recentQuestions = [];
    this.pendingFragment = null;
    this.lastEmitted = null;
  }
}