/**
 * QuestionContextFusion (Phase 11) + screen-derived question detection
 * (Phase 17).
 *
 * Deterministic heuristics only — no LLM per fusion operation. Combines the
 * most recent interviewer transcript with relevant screen text to produce an
 * enhanced question context for the AnswerEngine.
 *
 * Priority enforced here (also mirrored in PromptBuilder):
 *   spoken question >> manually selected screen > automatic screen.
 */

import { ContextEntry } from "../../common/types";
import { FusedQuestionContext, ScreenCodeBlock, ScreenContextEvent } from "../../common/screen-types";
import { QuestionDetector, normalizeQuestionText, tokenSimilarity } from "../conversation/QuestionDetector";

const VAGUE_PATTERNS = [
  /\bthis\s+(problem|question|task|exercise|challenge|one|code|diagram|figure|image|example)\b/i,
  /\bthese\s+(problems|examples)\b/i,
  /\bhere'?s\s+the\s+(problem|question|task|challenge)\b/i,
  /\bthe\s+(code|diagram|problem|question)\s+on\s+(the\s+)?screen\b/i,
  /\bwalk\s+me\s+through\s+(this|how\s+you('d| would))\b/i,
  /\bhow\s+would\s+you\s+(solve|approach|do)\s+this\b/i,
  /\bcan\s+you\s+(solve|do|walk|explain)\s+this\b/i,
  /\btake\s+a\s+look\b/i,
  /\blike\s+this\b/i,
  /\bshown\s+(here|above|below)\b/i,
  // Follow-up demonstratives: almost always reference prior visible content.
  /\belaborate\b/i,
  /\btell\s+me\s+more\b/i,
  /\bmore\s+(detail|details|about\s+that|on\s+that)\b/i,
  /\bthat\s+(cache|caching|code|function|component|service|layer|part|approach|design|diagram|query|schema|table|algorithm|api|endpoint)\b/i,
];

const CODE_SIGNALS = [
  /\b(def|function|return|import|from|class|const|let|var|if\s*\(|for\s*\(|while\s*\(|public\s+(static\s+)?(void|int|string)|=>|#include|package\s+\w+|func\s+\w+\()/,
  /[{};]\s*$/m,
  /^ {2,}\S/m, // indented block
  /```/,
];

const DIAGRAM_SIGNALS = [
  /\b(load balancer|database|cache|queue|api gateway|microservice|cdn|replica|shard|broker|cluster|frontend|backend|client\s*->|->\s*server)\b/i,
  /[|+]--+/,
  /--+>/,
  /\[.*\]\s*--/,
];

export function isVagueReference(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return true;
  return VAGUE_PATTERNS.some((re) => re.test(t));
}

export function looksLikeCode(text: string): boolean {
  const t = text || "";
  if (/```/.test(t)) return true;
  let hits = 0;
  for (const re of CODE_SIGNALS) if (re.test(t)) hits++;
  const lines = t.split("\n").filter((l) => l.trim().length > 0);
  const indented = lines.filter((l) => /^ {2,}|\t/.test(l)).length;
  if (lines.length >= 3 && indented >= 2) hits += 1;
  return hits >= 2;
}

export function looksLikeDiagram(text: string): boolean {
  const t = text || "";
  return DIAGRAM_SIGNALS.some((re) => re.test(t));
}

export function tokenOverlap(a: string, b: string): number {
  return tokenSimilarity(a, b);
}

function lastInterviewerText(recent: ContextEntry[]): string {
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (e.speaker === "interviewer" && (e.kind || "transcript") === "transcript" && e.text.trim()) {
      return e.text.trim();
    }
  }
  return "";
}

export interface FusionInput {
  recentContext: ContextEntry[];
  screen: ScreenContextEvent | null;
  screenMaxAgeMs?: number;
  now?: number;
  /** Minimum token overlap (0..1) to treat screen + audio as related. */
  relatedThreshold?: number;
}

const DEFAULT_MAX_AGE_MS = 120000;

export function fuseQuestionContext(input: FusionInput): FusedQuestionContext {
  const now = input.now ?? Date.now();
  const maxAge = input.screenMaxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const threshold = input.relatedThreshold ?? 0.25;
  const audio = lastInterviewerText(input.recentContext || []);
  const screen = input.screen && now - input.screen.timestamp <= maxAge ? input.screen : null;
  const screenText = (screen?.detectedQuestion || screen?.text || "").trim();

  if (!audio && !screenText) {
    return { text: "", origin: "audio", confidence: 0, screenRelated: false, reasons: ["no-audio-no-screen"] };
  }
  if (!audio && screenText) {
    const code = screen?.code ? { ...screen.code } : undefined;
    return {
      text: screenText,
      origin: "screen",
      confidence: Math.max(0.5, screen?.confidence ?? 0.5),
      screenRelated: true,
      reasons: ["screen-only"],
      code,
      diagramDescription: screen?.diagramDescription,
    };
  }
  if (audio && !screenText) {
    return { text: audio, origin: "audio", confidence: 0.8, screenRelated: false, reasons: ["audio-only"] };
  }

  // Both present.
  const overlap = tokenOverlap(audio, screenText);
  const vague = isVagueReference(audio);
  const screenIsQuestion = /[?]|^(implement|write|design|solve|given|return|create|build)\b/im.test(screenText);
  const related = overlap >= threshold || vague;

  if (vague && screenText.length >= 12) {
    const code = screen?.code ? { ...screen.code } : undefined;
    return {
      text: `${audio}\n\nOn-screen problem:\n${screenText}`,
      origin: "fused",
      confidence: 0.82,
      screenRelated: true,
      reasons: ["vague-audio+screen", `overlap=${overlap.toFixed(2)}`],
      code,
      diagramDescription: screen?.diagramDescription,
    };
  }
  if (screenIsQuestion && (related || overlap >= 0.15)) {
    const code = screen?.code ? { ...screen.code } : undefined;
    return {
      text: `${audio}\n\nRelated on-screen content:\n${screenText}`,
      origin: "fused",
      confidence: 0.75,
      screenRelated: true,
      reasons: ["screen-question+audio", `overlap=${overlap.toFixed(2)}`],
      code,
      diagramDescription: screen?.diagramDescription,
    };
  }
  // Spoken question takes priority when the screen looks unrelated.
  return {
    text: audio,
    origin: "audio",
    confidence: 0.85,
    screenRelated: false,
    reasons: ["audio-priority", `overlap=${overlap.toFixed(2)}`],
  };
}

// ---------------------------------------------------------------------------
// Screen-derived question detection (Phase 17).
// Splits screen text into candidate sentences, classifies each with the
// shared QuestionDetector, and returns the best candidate above threshold.
// Does NOT emit answers — callers debounce and fuse with audio first.
// ---------------------------------------------------------------------------

export interface ScreenQuestionCandidate {
  question: string;
  type: string;
  confidence: number;
  code?: ScreenCodeBlock;
  diagramDescription?: string;
}

function splitCandidates(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of (text || "").split("\n")) {
    const line = rawLine.trim();
    if (line.length < 8) continue;
    // Split long lines into sentences, keep code lines whole.
    if (/^[ \t]+/.test(rawLine) || /[{};=]$/.test(line)) {
      out.push(line);
    } else {
      for (const s of line.split(/(?<=[.?!])\s+/)) {
        const t = s.trim();
        if (t.length >= 8) out.push(t);
      }
    }
  }
  return out.slice(0, 40);
}

export function detectScreenQuestion(
  screenText: string,
  detector?: QuestionDetector,
  opts?: { minConfidence?: number; code?: ScreenCodeBlock; diagramDescription?: string }
): ScreenQuestionCandidate | null {
  const det = detector || new QuestionDetector();
  const minConf = opts?.minConfidence ?? 0.5;
  const candidates = splitCandidates(screenText);
  let best: ScreenQuestionCandidate | null = null;
  for (const c of candidates) {
    let cls: { isQuestion: boolean; type: string; confidence: number };
    try {
      cls = det.classify(c);
    } catch {
      continue;
    }
    if (!cls.isQuestion || cls.confidence < minConf) continue;
    if (!best || cls.confidence > best.confidence) {
      best = { question: c, type: cls.type, confidence: cls.confidence };
    }
  }
  if (!best) {
    // Screen-only coding prompt without question phrasing, e.g. "Given an
    // array of integers, return the longest increasing subsequence."
    const norm = normalizeQuestionText(screenText);
    if (/(implement|write a|given an? |return the|find the|design a)/.test(norm) && screenText.trim().length >= 20) {
      best = { question: screenText.trim().slice(0, 500), type: "coding", confidence: 0.6 };
    } else if (looksLikeDiagram(screenText) && screenText.trim().length >= 20) {
      best = { question: screenText.trim().slice(0, 500), type: "system_design", confidence: 0.55 };
    }
  }
  if (!best) return null;
  if (opts?.code || looksLikeCode(best.question) || looksLikeCode(screenText)) {
    best.code = opts?.code || { text: extractCodeBlock(screenText) || best.question };
  }
  if (opts?.diagramDescription || looksLikeDiagram(screenText)) {
    best.diagramDescription = opts?.diagramDescription || "diagram-like content detected on screen";
  }
  return best;
}

function extractCodeBlock(text: string): string {
  const lines = (text || "").split("\n");
  const codeLines = lines.filter((l) => /^[ \t]+/.test(l) || /[{};]$/.test(l.trim()) || /^(def|function|return|import|from|class|const|let|var|public|private|if|for|while)\b/.test(l.trim()));
  return codeLines.join("\n").slice(0, 2000).trim();
}

// ---------------------------------------------------------------------------
// Screen content classification + relevant-content extraction.
// Deterministic heuristics only — no model calls. Used to decide what the
// screen actually shows (question vs. code vs. diagram vs. UI chrome) and to
// keep surrounding platform UI (headers, timers, buttons) out of the
// question/answer pipeline while preserving problems, constraints, examples
// and code structure.
// ---------------------------------------------------------------------------

export type ScreenContentType =
  | "interview-question"
  | "coding-problem"
  | "system-design"
  | "resume"
  | "job-description"
  | "general-text"
  | "diagram"
  | "irrelevant-ui"
  | "unknown";

/** Whole-line platform/UI chrome that never carries interview meaning. */
const CHROME_LINE_PATTERNS = [
  /^(welcome to )?(hackerrank|leetcode|coderpad|codepad|hackerearth|interviewing\.io|glassdoor|linkedin|indeed)\b.*$/i,
  /^candidate\s*:.*$/i,
  /^(submit|next|previous|run(\s+code)?|continue|finish|cancel|close|start|stop|save|back|home|search)\s*$/i,
  /^round\s+\d+\s*$/i,
  /^(amazon|google|meta|microsoft|apple|netflix)\s+(interview|onsite|phone\s+screen)(\s+round\s*\d*)?\s*$/i,
  /^(time\s+(remaining|left|elapsed)|timer)(\s*:.*)?$/i,
  /^\d{1,2}:\d{2}(:\d{2})?(\s+(remaining|left|elapsed))?\s*$/,
  /^(score|points|progress|status)\s*:.*$/i,
  /^\d+\s*\/\s*\d+(\s+(test\s+cases?|passed|failed))?\s*$/,
  /^(page|question)\s+\d+\s+of\s+\d+\s*$/i,
  /^(copy\s+link|share\s+screen|mute|unmute|video\s+(on|off)|chat|participants|record(ing)?)\s*$/i,
];

/** Inline fragments (timer readouts) stripped wherever they appear. */
const CHROME_INLINE_PATTERNS = [
  /\btimer\s*:\s*\d{1,2}:\d{2}(:\d{2})?/gi,
  /\b\d{1,2}:\d{2}:\d{2}\s+(remaining|left|elapsed)/gi,
];

/** Section headers that structure a problem — always kept. */
const PROBLEM_SECTION_PATTERN = /^(problem|description|task|challenge|question|constraints?|examples?|sample\s+(input|output|tests?)|input|output|follow-?up|notes?|hints?)\s*:?\s*$/i;

function isChromeLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (t.length < 80 && CHROME_LINE_PATTERNS.some((re) => re.test(t))) return true;
  return false;
}

function stripInlineChrome(line: string): string {
  let out = line;
  for (const re of CHROME_INLINE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "");
  }
  // Platform buttons glued onto content lines by OCR line-joining ("...10^4
  // Submit", "Next" trailers). Matched case-sensitively at line edges only
  // so ordinary prose ("submit your answer") is never touched.
  out = out.replace(/\s+\b(Submit|Next|Previous|Run|Continue|Finish|Back)\s*$/, "").trim();
  out = out.replace(/^\b(Submit|Next|Previous|Run|Continue|Finish|Back)\b\s+/, "").trim();
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Classify already-extracted screen text. Pure heuristics; the AnswerEngine
 * prompt layer makes the final use decision.
 */
export function classifyScreenContent(text: string): ScreenContentType {
  const t = (text || "").trim();
  if (!t) return "unknown";
  if (t.length < 12) return "unknown";
  const code = looksLikeCode(t);
  const diagram = looksLikeDiagram(t);
  if (code || /(^|\n)\s*(given an? |constraints?\s*:|examples?\s*:|sample\s+(input|output)|time\s+complexity|space\s+complexity)/i.test(t)) {
    return "coding-problem";
  }
  if (diagram || /(^|\n)\s*(design a|architect|scalab|load\s+balanc|microservices?|api\s+gateway|message\s+queue|read\s+replicas?|shard|consistent\s+hash)/i.test(t)) {
    return "system-design";
  }
  if (/(years?\s+of\s+experience|work\s+experience|technical\s+skills|employment\s+history|education\s*:|^\s*resume\s*$|curriculum\s+vitae)/im.test(t) ||
    (/\S+@\S+\.\S+/.test(t) && /(\+?\d[\d\s\-()]{7,}\d|experience|skills)/.test(t))) {
    return "resume";
  }
  if (/(job\s+description|responsibilities\s*:|requirements\s*:|qualifications\s*:|we(\s+are|'re)\s+hiring|about\s+the\s+role|nice\s+to\s+have|what\s+you('ll| will)\s+do)/i.test(t)) {
    return "job-description";
  }
  if (/[?]\s*$/.test(t) || /^(tell me|describe|explain|what|why|how|can you|have you|could you|walk me)/im.test(t)) {
    return "interview-question";
  }
  if (/^(implement|write a|given an? |return the|find the|design a)/i.test(t.trim()) && t.length >= 20) {
    return "coding-problem";
  }
  return "general-text";
}

export interface RelevantScreenContent {
  relevantText: string;
  contentType: ScreenContentType;
  droppedChrome: boolean;
}

/**
 * Remove surrounding platform/UI chrome and return the interview-relevant
 * core (problem statement, question, constraints, examples, code). Section
 * headers and code layout are preserved; ordering is kept.
 */
export function extractRelevantScreenContent(text: string, maxChars = 2000): RelevantScreenContent {
  const raw = String(text || "").replace(/\r/g, "");
  if (!raw.trim()) return { relevantText: "", contentType: "unknown", droppedChrome: false };
  const kept: string[] = [];
  let dropped = 0;
  for (const rawLine of raw.split("\n")) {
    if (!rawLine.trim()) continue;
    const line = stripInlineChrome(rawLine);
    if (!line) {
      dropped++;
      continue;
    }
    if (!PROBLEM_SECTION_PATTERN.test(line) && isChromeLine(line)) {
      dropped++;
      continue;
    }
    kept.push(rawLine.trim().length > 0 && /^[ \t]/.test(rawLine) ? rawLine.replace(/\s+$/g, "") : line);
  }
  let relevant = kept.join("\n").trim();
  if (relevant.length > maxChars) relevant = relevant.slice(0, maxChars).trim() + "\n…[truncated]";
  if (!relevant) return { relevantText: "", contentType: "irrelevant-ui", droppedChrome: dropped > 0 };
  return { relevantText: relevant, contentType: classifyScreenContent(relevant), droppedChrome: dropped > 0 };
}
