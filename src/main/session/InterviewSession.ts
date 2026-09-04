/**
 * InterviewSession model + lifecycle (Phases 14-15, 18).
 * Stores extracted text/metadata only — never raw audio or screenshots.
 */

import { EventEmitter } from "events";
import { QuestionType } from "../../common/types";
import { CandidateMode } from "../candidates/Persona";

let __sessionCounter = 0;
function nextSessionId(): string {
  __sessionCounter += 1;
  return `sess-${Date.now().toString(36)}-${__sessionCounter.toString(36)}`;
}

export type SessionStatus = "created" | "running" | "paused" | "ended";

export interface SessionSettings {
  answerLength?: "short" | "medium" | "detailed";
  visionMode?: "local" | "remote" | "disabled";
  notes?: string;
}

export interface SessionQuestionRecord {
  id: string;
  text: string;
  type: QuestionType;
  timestamp: number;
  source: string;
  confidence: number;
  origin?: "audio" | "screen" | "fused" | "manual";
}

export interface SessionAnswerRecord {
  id: string;
  questionId: string;
  role: "fast" | "strong";
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
  timestamp: number;
  status: "ok" | "error" | "unavailable";
  stale?: boolean;
}

export interface SessionModels {
  fastProvider: string;
  fastModel: string;
  strongProvider: string;
  strongModel: string;
}

export interface InterviewSessionData {
  id: string;
  status: SessionStatus;
  startTime: number;
  endTime?: number;
  candidateProfileId?: string;
  personaId?: string;
  candidateMode: CandidateMode;
  jobDescriptionId?: string;
  settings: SessionSettings;
  models?: SessionModels;
  questions: SessionQuestionRecord[];
  answers: SessionAnswerRecord[];
  metadata: Record<string, unknown>;
}

export interface CreateSessionOptions {
  candidateProfileId?: string;
  personaId?: string;
  candidateMode?: CandidateMode;
  jobDescriptionId?: string;
  settings?: SessionSettings;
  models?: SessionModels;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, InterviewSessionData>();
  private activeId: string | null = null;

  createSession(opts?: CreateSessionOptions): InterviewSessionData {
    const now = Date.now();
    const s: InterviewSessionData = {
      id: nextSessionId(),
      status: "created",
      startTime: now,
      candidateProfileId: opts?.candidateProfileId,
      personaId: opts?.personaId,
      candidateMode: opts?.candidateMode || "real",
      jobDescriptionId: opts?.jobDescriptionId,
      settings: { ...(opts?.settings || {}) },
      models: opts?.models ? { ...opts.models } : undefined,
      questions: [],
      answers: [],
      metadata: {},
    };
    this.sessions.set(s.id, s);
    this.emit("created", s);
    return s;
  }

  /** Register an externally created/restored session (e.g. loaded from disk). */
  attach(session: InterviewSessionData): InterviewSessionData {
    this.sessions.set(session.id, session);
    return session;
  }

  startSession(id: string): InterviewSessionData | null {
    const s = this.sessions.get(id);
    if (!s || s.status === "ended") return null;
    s.status = "running";
    if (!s.startTime) s.startTime = Date.now();
    this.activeId = id;
    this.emit("started", s);
    this.emit("active", s);
    return s;
  }

  pauseSession(id: string): InterviewSessionData | null {
    const s = this.sessions.get(id);
    if (!s || s.status !== "running") return null;
    s.status = "paused";
    this.emit("paused", s);
    return s;
  }

  resumeSession(id: string): InterviewSessionData | null {
    const s = this.sessions.get(id);
    if (!s || s.status !== "paused") return null;
    s.status = "running";
    this.activeId = id;
    this.emit("resumed", s);
    this.emit("active", s);
    return s;
  }

  endSession(id: string): InterviewSessionData | null {
    const s = this.sessions.get(id);
    if (!s || s.status === "ended") return s || null;
    s.status = "ended";
    s.endTime = Date.now();
    if (this.activeId === id) {
      this.activeId = null;
      this.emit("active", null);
    }
    this.emit("ended", s);
    return s;
  }

  clearSession(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (this.activeId === id) {
      this.activeId = null;
      this.emit("active", null);
    }
    this.sessions.delete(id);
    this.emit("cleared", id);
    return true;
  }

  getSession(id: string): InterviewSessionData | null {
    return this.sessions.get(id) || null;
  }

  getActiveSession(): InterviewSessionData | null {
    return (this.activeId && this.sessions.get(this.activeId)) || null;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  listSessions(): InterviewSessionData[] {
    return [...this.sessions.values()].sort((a, b) => b.startTime - a.startTime);
  }

  recordQuestion(sessionId: string, q: SessionQuestionRecord): SessionQuestionRecord | null {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === "ended") return null;
    if (s.questions.some((x) => x.id === q.id)) return q; // idempotent
    s.questions.push(q);
    this.emit("question", { sessionId, question: q });
    return q;
  }

  recordAnswer(sessionId: string, a: SessionAnswerRecord): SessionAnswerRecord | null {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === "ended") return null;
    if (s.answers.some((x) => x.id === a.id)) return a;
    s.answers.push(a);
    this.emit("answer", { sessionId, answer: a });
    return a;
  }

  /** Answers for one question, fast first. */
  answersFor(sessionId: string, questionId: string): SessionAnswerRecord[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return s.answers.filter((a) => a.questionId === questionId);
  }

  /**
   * Mark all answers recorded for a superseded fragment question as stale
   * (a merged continuation replaced it). Returns the number marked.
   */
  markAnswersStale(sessionId: string, questionId: string): number {
    const s = this.sessions.get(sessionId);
    if (!s) return 0;
    let n = 0;
    for (const a of s.answers) {
      if (a.questionId === questionId && !a.stale) {
        a.stale = true;
        n += 1;
      }
    }
    return n;
  }
}
