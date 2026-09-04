import { EventEmitter } from "events";
import { ContextEntry, SpeakerRole, TranscriptEvent } from "../../common/types";
import { ScreenContextEvent } from "../../common/screen-types";
import { logger } from "../logger";

let __idCounter = 0;
function nextId(): string { __idCounter += 1; return __idCounter.toString(36); }

export interface InterviewContextOptions {
  maxEntries: number;       // hard cap on buffered entries
  maxAgeMs: number;         // entries older than this are evicted
  evictionIntervalMs: number; // how often to scan for stale entries
}

const DEFAULTS: InterviewContextOptions = {
  maxEntries: 200,
  maxAgeMs: 30 * 60 * 1000,   // 30 minutes
  evictionIntervalMs: 5000,
};

export class InterviewContext extends EventEmitter {
  private opts: InterviewContextOptions;
  private entries: ContextEntry[] = [];
  private indexByTranscriptId: Map<string, string> = new Map(); // transcript id -> entry id
  private evictionTimer: NodeJS.Timeout | null = null;

  constructor(opts?: Partial<InterviewContextOptions>) {
    super();
    this.opts = { ...DEFAULTS, ...(opts || {}) };
  }

  start(): void {
    if (this.evictionTimer) return;
    this.evictionTimer = setInterval(() => this.evictStale(), this.opts.evictionIntervalMs);
  }

  stop(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
  }

  /**
    * Ingest a finalized transcript event.
    * If a non-final (partial) transcript with the same transcriptEventId already exists,
    * replace it in place with the final version. Otherwise append a new entry.
    */
  ingestTranscript(evt: TranscriptEvent): ContextEntry | null {
    if (!evt.isFinal) {
      // Partial events are stored as "in-progress" entries so the UI can render them,
      // but they are owned by the same transcript id and replaced when the final lands.
      return this.upsertPartial(evt);
    }
    return this.upsertFinal(evt);
  }

  private upsertPartial(evt: TranscriptEvent): ContextEntry {
    const existingEntryId = this.indexByTranscriptId.get(evt.id);
    if (existingEntryId) {
      const idx = this.entries.findIndex((e) => e.id === existingEntryId);
      if (idx >= 0) {
        this.entries[idx] = {
          ...this.entries[idx],
          text: evt.text,
          timestamp: evt.timestamp,
        };
        const updated = this.entries[idx];
        this.emit("update", updated);
        return updated;
      }
    }
    const entry = this.makeEntry(evt);
    this.pushBounded(entry);
    this.indexByTranscriptId.set(evt.id, entry.id);
    this.emit("add", entry);
    return entry;
  }

  private upsertFinal(evt: TranscriptEvent): ContextEntry | null {
    const text = (evt.text || "").trim();
    if (!text) return null;
    const existingEntryId = this.indexByTranscriptId.get(evt.id);
    if (existingEntryId) {
      const idx = this.entries.findIndex((e) => e.id === existingEntryId);
      if (idx >= 0) {
        const merged: ContextEntry = {
          ...this.entries[idx],
          text,
          timestamp: evt.timestamp,
        };
        this.entries[idx] = merged;
        this.emit("update", merged);
        return merged;
      }
    }
    const entry = this.makeEntry(evt);
    this.pushBounded(entry);
    this.indexByTranscriptId.set(evt.id, entry.id);
    this.emit("add", entry);
    return entry;
  }

  private makeEntry(evt: TranscriptEvent): ContextEntry {
    return {
      id: nextId(),
      speaker: evt.speaker,
      source: evt.source,
      text: (evt.text || "").trim(),
      timestamp: evt.timestamp,
      transcriptEventId: evt.id,
      kind: "transcript",
    };
  }

  /**
   * Ingest a screen-context event as a typed entry. Screen entries share the
   * same bounded buffer as transcripts (no unbounded growth) and store only
   * extracted text/summaries — never images.
   */
  ingestScreen(evt: ScreenContextEvent, maxChars = 2000): ContextEntry {
    const summary = (evt.detectedQuestion || evt.text || "").trim().slice(0, maxChars);
    const entry: ContextEntry = {
      id: nextId(),
      speaker: "interviewer",
      source: "system",
      text: summary,
      timestamp: evt.timestamp,
      transcriptEventId: `screen:${evt.id}`,
      kind: "screen",
      metadata: {
        screenEventId: evt.id,
        mode: evt.mode,
        origin: evt.origin,
        confidence: evt.confidence,
        hasCode: !!evt.code,
        hasDiagram: !!evt.diagramDescription,
        region: evt.region,
      },
    };
    this.pushBounded(entry);
    this.indexByTranscriptId.set(entry.transcriptEventId, entry.id);
    this.emit("add", entry);
    return entry;
  }

  /** Most recent screen entries (newest last), capped at maxN. */
  recentScreen(maxN: number): ContextEntry[] {
    const out: ContextEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < maxN; i--) {
      if ((this.entries[i].kind || "transcript") === "screen") out.push(this.entries[i]);
    }
    return out.reverse();
  }

  /** Most recent entries of any kinds (transcript default preserves history). */
  recentByKind(maxN: number, kinds: Array<ContextEntry["kind"]>): ContextEntry[] {
    const set = new Set(kinds);
    const out: ContextEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < maxN; i--) {
      if (set.has(this.entries[i].kind || "transcript")) out.push(this.entries[i]);
    }
    return out.reverse();
  }

  /**
   * Append a pre-built typed entry (question/answer/screen) through the same
   * bounded buffer + event path as everything else.
   */
  ingestTyped(entry: ContextEntry): ContextEntry {
    const full: ContextEntry = { ...entry, id: entry.id || nextId(), kind: entry.kind || "transcript" };
    this.pushBounded(full);
    if (full.transcriptEventId) this.indexByTranscriptId.set(full.transcriptEventId, full.id);
    this.emit("add", full);
    return full;
  }

  private pushBounded(entry: ContextEntry): void {
    this.entries.push(entry);
    while (this.entries.length > this.opts.maxEntries) {
      const dropped = this.entries.shift();
      if (dropped) this.indexByTranscriptId.delete(dropped.transcriptEventId);
    }
  }

  private evictStale(): void {
    const now = Date.now();
    const cutoff = now - this.opts.maxAgeMs;
    let changed = false;
    while (this.entries.length > 0 && this.entries[0].timestamp < cutoff) {
      const dropped = this.entries.shift();
      if (dropped) this.indexByTranscriptId.delete(dropped.transcriptEventId);
      changed = true;
    }
    if (changed) this.emit("evict");
  }

  recent(maxN: number): ContextEntry[] {
    if (this.entries.length <= maxN) return [...this.entries];
    return this.entries.slice(this.entries.length - maxN);
  }

  size(): number { return this.entries.length; }

  snapshot(): ContextEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.indexByTranscriptId.clear();
    this.emit("clear");
  }
}