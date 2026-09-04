/**
 * Session history persistence (Phase 16). One JSON file per session plus a
 * small index. Text/metadata only — no audio, no screenshots.
 */

import { InterviewSessionData } from "./InterviewSession";
import { JsonFileStorage } from "../candidates/stores";
import { logger } from "../logger";

const PREFIX = "session-";
const SUFFIX = ".json";
const INDEX = "sessions-index.json";

export class SessionStore {
  private storage: JsonFileStorage;

  constructor(storage: JsonFileStorage) {
    this.storage = storage;
  }

  save(session: InterviewSessionData): void {
    try {
      this.storage.write(`${PREFIX}${sanitize(session.id)}${SUFFIX}`, session);
      this.updateIndex(session);
    } catch (e) {
      logger.warn("Session persist failed", String(e));
    }
  }

  load(id: string): InterviewSessionData | null {
    const raw = this.storage.read<InterviewSessionData | null>(`${PREFIX}${sanitize(id)}${SUFFIX}`, null);
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as InterviewSessionData).questions)) return null;
    const s = raw as InterviewSessionData;
    if (!Array.isArray(s.answers)) s.answers = [];
    return s;
  }

  delete(id: string): void {
    this.storage.remove(`${PREFIX}${sanitize(id)}${SUFFIX}`);
    const idx = this.index().filter((e) => e.id !== id);
    this.storage.write(INDEX, idx);
  }

  clearAll(): void {
    for (const f of this.storage.list(PREFIX, SUFFIX)) this.storage.remove(f);
    this.storage.write(INDEX, []);
  }

  index(): Array<{ id: string; startTime: number; status: string; questionCount: number; candidateMode: string }> {
    return this.storage.read(INDEX, []);
  }

  loadAll(): InterviewSessionData[] {
    const out: InterviewSessionData[] = [];
    for (const f of this.storage.list(PREFIX, SUFFIX)) {
      const id = f.slice(PREFIX.length, -SUFFIX.length);
      const s = this.load(id);
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.startTime - a.startTime);
  }

  private updateIndex(session: InterviewSessionData): void {
    const idx = this.index().filter((e) => e.id !== session.id);
    idx.unshift({
      id: session.id,
      startTime: session.startTime,
      status: session.status,
      questionCount: session.questions.length,
      candidateMode: session.candidateMode,
    });
    this.storage.write(INDEX, idx.slice(0, 200));
  }
}

function sanitize(id: string): string {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120) || "session";
}
