/**
 * PromptBuilder: reasoning prompt with explicit context priority (Phases 15-16, 19).
 *
 * Priority (highest first):
 *   CURRENT QUESTION
 *   RECENT CONVERSATION
 *   RELEVANT CANDIDATE FACTS (verified, question-specific subset)
 *   RELEVANT EXPERIENCE / PROJECTS
 *   RELEVANT JD INFORMATION
 *   PERSONA / SPEAKING STYLE
 *   SCREEN CONTEXT
 *   GENERAL KNOWLEDGE
 *
 * Verified facts are labeled by source so the model can distinguish VERIFIED
 * CANDIDATE FACT vs GENERAL KNOWLEDGE vs its own wording. Missing personal
 * facts must never be invented (see grounding rules).
 */

import { ContextEntry, QuestionType } from "../../common/types";
import { ScreenContextEvent } from "../../common/screen-types";
import { CandidateProfile } from "../candidates/CandidateProfile";
import { Persona, CandidateMode } from "../candidates/Persona";
import { JobDescription } from "../candidates/JobDescription";
import { selectRelevantContext, formatRelevantFacts } from "../candidates/Relevance";

export type AnswerLength = "short" | "medium" | "detailed";

export interface AnswerPromptInput {
  question: string;
  questionType?: QuestionType;
  recentContext: ContextEntry[];
  screenEvents: ScreenContextEvent[];
  /** Legacy inline candidate text (kept working; structured `profile` preferred). */
  candidateProfile?: string;
  /** Legacy inline JD text (kept working; structured `jobDesc` preferred). */
  jobDescription?: string;
  profile?: CandidateProfile;
  persona?: Persona;
  jobDesc?: JobDescription;
  candidateMode?: CandidateMode;
  answerLength?: AnswerLength;
  maxScreenChars?: number;
  maxRecentEntries?: number;
}

export function truncate(s: string, max: number): string {
  const t = (s || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…[truncated]";
}

function kindRank(e: ContextEntry): number {
  if (e.kind === "screen") return 4;
  if (e.speaker === "interviewer") return 2;
  if (e.speaker === "candidate") return 5;
  return 8;
}

export function formatRecentContext(entries: ContextEntry[], maxEntries: number): string {
  const list = entries.slice(-maxEntries);
  if (list.length === 0) return "(none)";
  const sorted = [...list].sort((a, b) => a.timestamp - b.timestamp);
  return sorted
    .map((e) => {
      const who = e.kind === "screen" ? "screen" : e.speaker;
      return `- [${who}] ${truncate(e.text, 400)}`;
    })
    .join("\n");
}

export function formatScreenContext(events: ScreenContextEvent[], maxChars: number): string {
  if (!events || events.length === 0) return "";
  // Manual selections outrank automatic captures.
  const sorted = [...events].sort((a, b) => {
    const rank = (s: ScreenContextEvent): number => (s.source === "manual" ? 0 : s.source === "window" ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return b.timestamp - a.timestamp;
  });
  const parts: string[] = [];
  let budget = maxChars;
  for (const e of sorted) {
    if (budget <= 0) break;
    const label = e.source === "manual" ? "manually selected" : e.source === "window" ? "interview window" : "automatic";
    let chunk = `[${label}] ${e.text || ""}`;
    if (e.visualSummary && e.visualSummary !== e.text) chunk += `\nVisual: ${e.visualSummary}`;
    if (e.code?.text) chunk += `\nCode${e.code.language ? ` (${e.code.language})` : ""}:\n${e.code.text}`;
    if (e.diagramDescription) chunk += `\nDiagram: ${e.diagramDescription}`;
    chunk = truncate(chunk, budget);
    budget -= chunk.length;
    parts.push(chunk);
  }
  return parts.join("\n---\n");
}

function lengthGuidance(length: AnswerLength, fast: boolean): string {
  if (fast) return "Keep it SHORT: 2-4 spoken sentences, key points only.";
  if (length === "short") return "SHORT: roughly 2-4 spoken sentences. Stop there.";
  if (length === "detailed") return "DETAILED: a complete explanation with specifics, but stay speakable (no 2000-word document, no repeated conclusions). Coding/system-design questions may include compact code or structure where it helps speech.";
  return "MEDIUM: roughly 4-8 spoken sentences — direct response plus brief reasoning. Conversational, not robotic.";
}

/**
 * Compact per-type answer shaping. Behavioral STAR reasoning already lives
 * in the strategy prompt; this keeps coding and system-design answers
 * practical and speakable without forcing rigid templates.
 */
function typeShaping(type: QuestionType): string {
  if (type === "coding") {
    return "CODING SHAPING: lead with the approach in one or two sentences, then give compact code only when it helps speech, then complexity and the key edge cases briefly. No giant tutorials.";
  }
  if (type === "system_design") {
    return "SYSTEM-DESIGN SHAPING: cover only the areas relevant to the question — requirements, scale, components, APIs, database, cache, queues, reliability, consistency, trade-offs. Concise and conversational, never an exhaustive checklist.";
  }
  return "ANSWER SHAPING: answer the exact question asked; keep every sentence speakable.";
}

export function buildAnswerPrompt(input: AnswerPromptInput, opts?: { fast?: boolean }): string {
  const maxScreen = input.maxScreenChars ?? 2000;
  const maxRecent = input.maxRecentEntries ?? 12;
  const mode: CandidateMode = input.candidateMode || "real";
  const length: AnswerLength = input.answerLength || "medium";
  const type = input.questionType || "general";
  const screen = formatScreenContext(input.screenEvents, maxScreen);
  const lines: string[] = [];
  lines.push("You are Intervia, a real-time interview copilot. Answer as the candidate, concisely and confidently.");
  lines.push("SPOKEN STYLE: this answer will be SPOKEN by the candidate in a live interview. Speak as 'I' in natural first-person language a person would actually say out loud (e.g. \"I've worked with...\", \"One example was...\", \"The main challenge there was...\", \"What I ended up doing was...\"). Be direct — no assistant preamble ('As an AI', 'Certainly, here is'), no meta-commentary about where facts came from, minimal markdown, no walls of headings. Short/medium answers: 2-8 spoken sentences unless the question needs technical depth.");
  lines.push(lengthGuidance(length, opts?.fast === true));
  lines.push(typeShaping(type));
  lines.push("");
  lines.push("CURRENT QUESTION");
  lines.push(truncate(input.question, 1000));
  lines.push("");
  lines.push("RECENT INTERVIEW CONTEXT");
  lines.push(formatRecentContext(input.recentContext, maxRecent));

  // Structured candidate knowledge (preferred) with deterministic relevance.
  if (input.profile) {
    const rel = selectRelevantContext(input.question, type, input.profile, input.jobDesc || null);
    const facts = formatRelevantFacts(rel);
    lines.push("");
    if (mode === "mock") {
      lines.push("MOCK-CANDIDATE KNOWLEDGE (FICTIONAL persona facts — use freely as the character; they are not real)");
    } else {
      lines.push("RELEVANT CANDIDATE FACTS (VERIFIED — ground personal claims ONLY in these)");
    }
    lines.push(facts || "(no directly relevant verified facts)");
    if (rel.jdPoints.length > 0) {
      lines.push("");
      lines.push("RELEVANT JD INFORMATION");
      lines.push(rel.jdPoints.map((p) => `- ${truncate(p, 300)}`).join("\n"));
    }
  } else {
    if (input.candidateProfile) {
      lines.push("");
      lines.push("CANDIDATE CONTEXT (ground your answer in these facts; do not invent other experience)");
      lines.push(truncate(input.candidateProfile, 1500));
    }
    if (input.jobDescription) {
      lines.push("");
      lines.push("JOB DESCRIPTION");
      lines.push(truncate(input.jobDescription, 1500));
    } else if (input.jobDesc) {
      lines.push("");
      lines.push("JOB DESCRIPTION");
      lines.push(truncate(`Role: ${input.jobDesc.title}${input.jobDesc.company ? ` at ${input.jobDesc.company}` : ""}\nRequired: ${(input.jobDesc.requiredSkills || []).join(", ")}`, 1500));
    }
  }

  if (input.persona) {
    lines.push("");
    lines.push("PERSONA / SPEAKING STYLE");
    const bits: string[] = [];
    if (input.persona.role) bits.push(`Role: ${input.persona.role}`);
    if (input.persona.speakingStyle) bits.push(`Style: ${input.persona.speakingStyle}`);
    if (input.persona.personalityNotes) bits.push(`Notes: ${input.persona.personalityNotes}`);
    if (input.persona.customInstructions) bits.push(`Instructions: ${input.persona.customInstructions}`);
    if (mode === "real") bits.push("Use this persona for TONE ONLY. Resume/manual facts above remain the only authoritative experience.");
    else bits.push("MOCK MODE: treat persona-linked knowledge as FICTIONAL character facts, not real history.");
    lines.push(bits.join("\n") || input.persona.name);
  }

  if (screen) {
    lines.push("");
    lines.push("SCREEN CONTEXT");
    lines.push(screen);
    lines.push("");
    lines.push("Screen-context rules: this text may be incomplete or misread; do not assume unreadable text is accurate; do not invent unseen information; prioritize the current interviewer question; use screen context only when relevant; ignore unrelated desktop content.");
  }
  lines.push("");
  lines.push(
    "Grounding rules: [verified:*] lines are VERIFIED CANDIDATE FACTS — you may state them as your experience. " +
    "Everything else you know is GENERAL KNOWLEDGE — use it for explanations, never as personal history. " +
    "Your phrasing is MODEL-GENERATED WORDING around those two sources. " +
    "If the question needs a personal fact (employer, project, metric) NOT listed above, do NOT invent one: say you lack that specific detail and answer the general/transferable part instead."
  );
  lines.push("");
  lines.push("Answer directly. If screen context is irrelevant to the question, ignore it.");
  return lines.join("\n");
}

/** Exposed for tests: priority rank used when ordering context. Lower = higher priority. */
export function contextPriorityRank(entry: ContextEntry): number {
  return kindRank(entry);
}
