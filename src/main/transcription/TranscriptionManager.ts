import { EventEmitter } from "events";
import { logger } from "../logger";
import { config } from "../config";
import { Vad } from "./Vad";
import {
  createProvider,
  TranscriptionProvider,
  TranscriptionProviderStatus,
  TranscriptionRequest,
} from "./providers";
import { AudioSource, SpeakerRole, TranscriptEvent } from "../../common/types";

let __idCounter = 0;
function nextId(): string {
  __idCounter += 1;
  return __idCounter.toString(36);
}

/**
 * Deterministic ASR-garbage filter (production transcript quality).
 * Drops finals that carry no speech content: known whisper non-speech tags
 * ([BLANK_AUDIO], [MUSIC], ...), pure punctuation, single characters, and
 * pathological repetitions ("aaaaaaa"). Narrow by design: real words,
 * fillers ("um"), and mock-labeled test transcripts always pass through —
 * filler suppression belongs to the question detector, not here.
 */
export function isTranscriptGarbage(text: unknown): boolean {
  const t = String(text || "").trim();
  if (!t) return true;
  const inner = t.replace(/^\[(.+)\]$/, "$1").trim().toLowerCase().replace(/[\s_]+/g, " ");
  if (t.startsWith("[") && t.endsWith("]")) {
    if (["blank audio", "music", "silence", "background noise", "noise", "inaudible", "unintelligible"].includes(inner)) {
      return true;
    }
  }
  const letters = t.replace(/[^\p{L}\p{N}]/gu, "");
  if (letters.length <= 1) return true;
  // One character repeated 6+ times (e.g. "aaaaaaa", "……").
  if (/^(.)\1{5,}$/u.test(t.replace(/\s+/g, ""))) return true;
  return false;
}

interface SourceState {
  buffer: Int16Array[];
  bufferLen: number;
  bufferMaxSamples: number;
  partialThresholdSamples: number;
  lastSpeechEndMs: number;
  vad: Vad;
  active: boolean;
  inSpeech: boolean;
  lastPartialDispatchMs: number;
  /**
   * Stable id for the current utterance. All partials AND the final of one
   * speech segment share it, so InterviewContext can merge instead of
   * accumulating overlapping duplicates. Reset when the final is emitted.
   */
  utteranceId: string | null;
}

export class TranscriptionManager extends EventEmitter {
  private provider: TranscriptionProvider;
  private sources: Record<AudioSource, SourceState>;
  private flushTimer: NodeJS.Timeout | null = null;
  private started = false;
  /**
   * Dispatch epoch. Bumped on stop() so in-flight provider calls from a
   * previous session can never emit transcripts into the next one
   * (zombie-request protection). stop() flushes leftovers with the NEW
   * epoch explicitly so trailing words are still delivered.
   */
  private epoch = 0;
  private partialTimers: Partial<Record<AudioSource, NodeJS.Timeout>> = {};
  private attributeSpeaker: (source: AudioSource) => SpeakerRole;
  private errorHandler: ((source: string, message: string) => void) | null = null;

  /** Optional sink so STT failures enter the diagnostics error ring. */
  setErrorHandler(cb: ((source: string, message: string) => void) | null): void {
    this.errorHandler = cb;
  }

  constructor(provider?: TranscriptionProvider, opts?: { attributeSpeaker?: (source: AudioSource) => SpeakerRole }) {
    super();
    this.provider = provider || createProvider();
    this.attributeSpeaker = opts?.attributeSpeaker || (() => "unknown" as SpeakerRole);
    const maxSamples = Math.floor((config.audio.targetSampleRate * config.audio.maxBufferMs) / 1000);
    const initState = (): SourceState => ({
      buffer: [],
      bufferLen: 0,
      bufferMaxSamples: maxSamples,
      partialThresholdSamples: Math.floor((config.audio.targetSampleRate * 2000) / 1000),
      lastSpeechEndMs: 0,
      vad: new Vad({ sampleRate: config.audio.targetSampleRate }),
      active: false,
      inSpeech: false,
      lastPartialDispatchMs: 0,
      utteranceId: null,
    });
    this.sources = { microphone: initState(), system: initState() };
    for (const src of ["microphone", "system"] as AudioSource[]) {
      this.sources[src].vad.onEvent((e) => {
        if (e.type === "speech-start") {
          this.sources[src].inSpeech = true;
          // New speech segment -> new stable utterance id.
          this.sources[src].utteranceId = nextId();
        } else if (e.type === "speech-end") {
          this.sources[src].inSpeech = false;
          this.sources[src].lastSpeechEndMs = e.timestamp;
          this.flushSource(src, true);
        }
      });
    }
  }

  getProviderName(): string { return this.provider.name; }

  /**
   * Runtime STT provider swap (Setup configuration). Allowed only while
   * stopped so in-flight audio/epochs can never straddle two backends.
   * Returns false when busy (caller keeps the old provider).
   */
  async setProvider(p: TranscriptionProvider): Promise<boolean> {
    if (this.started || !p) return false;
    try {
      await this.provider.shutdown().catch(() => undefined);
    } catch {
      // ignore
    }
    this.provider = p;
    try {
      await this.provider.init();
    } catch {
      // init records its own status; swap still applies
    }
    return true;
  }

  /** Explicit backend status for diagnostics (null when the provider predates the API). */
  getProviderStatus(): TranscriptionProviderStatus | null {
    try {
      const p = this.provider as unknown as { getStatus?: () => TranscriptionProviderStatus };
      if (typeof p.getStatus === "function") return p.getStatus();
    } catch {
      // ignore
    }
    return null;
  }

  /** True when the STT backend is actually reachable (not mock-fallback). */
  isProviderReady(): boolean {
    try {
      if (typeof (this.provider as unknown as { isReady?: unknown }).isReady === "function") {
        return !!((this.provider as unknown as { isReady(): boolean }).isReady());
      }
      // Providers without a readiness signal (e.g. groq with key) count as
      // configured; providers that throw in isAvailable count as down.
      if (typeof (this.provider as unknown as { isAvailable?: unknown }).isAvailable === "function") {
        const v = (this.provider as unknown as { isAvailable(): unknown }).isAvailable();
        if (typeof v === "boolean") return v;
      }
      return true;
    } catch {
      return false;
    }
  }

  async init(): Promise<void> {
    await this.provider.init();
    this.emit("ready", this.provider);
    logger.info("TranscriptionManager initialized with provider", this.provider.name);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Re-check backend reachability in the background on every Start: a
    // whisper-server (re)started while the app was idle is picked up without
    // an app restart, and a server that died flips status honestly. Never
    // blocks capture; init() only flips the readiness flag + lastError.
    try {
      void Promise.resolve()
        .then(() => this.provider.init())
        .catch(() => undefined);
    } catch {
      // ignore (provider keeps its last known state)
    }
    this.flushTimer = setInterval(() => {
      for (const src of ["microphone", "system"] as AudioSource[]) {
        const s = this.sources[src];
        if (s.bufferLen > 0 && !s.inSpeech) {
          const idleMs = Date.now() - s.lastSpeechEndMs;
          if (idleMs > 2000) this.flushSource(src, true);
        }
      }
    }, 500);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Bump the epoch FIRST so in-flight provider calls from this session can
    // never emit into the next one; then flush leftovers with the new epoch
    // so trailing words are still delivered once.
    this.epoch += 1;
    const keepEpoch = this.epoch;
    for (const src of ["microphone", "system"] as AudioSource[]) {
      this.flushSource(src, true, keepEpoch);
      this.sources[src].vad.reset();
      this.sources[src].buffer = [];
      this.sources[src].bufferLen = 0;
      this.sources[src].active = false;
      this.sources[src].inSpeech = false;
      this.sources[src].utteranceId = null;
    }
    for (const k of Object.keys(this.partialTimers) as AudioSource[]) {
      if (this.partialTimers[k]) clearTimeout(this.partialTimers[k]!);
      this.partialTimers[k] = undefined;
    }
    this.provider.shutdown().catch(() => undefined);
  }

  feed(source: AudioSource, pcm: Int16Array): void {
    if (!this.started) return;
    const s = this.sources[source];
    s.active = true;
    let isAbove = false;
    if (config.vad.enabled) {
      s.vad.feed(pcm);
      isAbove = s.vad.computeRms(pcm) >= config.vad.rmsThreshold;
      if (isAbove && !s.inSpeech) {
        // VAD just transitioned to speech - drop any buffered silence.
        s.buffer = [];
        s.bufferLen = 0;
      }
    } else {
      isAbove = true;
    }
    if (isAbove) {
      if (!s.utteranceId) s.utteranceId = nextId(); // covers VAD-disabled mode
      s.buffer.push(pcm);
      s.bufferLen += pcm.length;
    }
    // Partial dispatch: emit when enough buffered speech has accumulated since last partial
    // AND this feed added new audio (so we don't fire on stale buffer during trailing silence).
    if (isAbove && s.inSpeech && s.bufferLen >= s.partialThresholdSamples &&
        (Date.now() - s.lastPartialDispatchMs) >= 800) {
      const merged = drainToInt16(s.buffer, s.bufferLen);
      s.buffer = [];
      s.bufferLen = 0;
      s.lastPartialDispatchMs = Date.now();
      this.dispatch(source, merged, false, s.utteranceId || nextId());
    }
    while (s.bufferLen >= s.bufferMaxSamples) {
      const merged = new Int16Array(s.bufferLen);
      let off = 0;
      for (const c of s.buffer) { merged.set(c, off); off += c.length; }
      const half = Math.floor(s.bufferLen / 2);
      const head = merged.subarray(0, half);
      const tail = merged.subarray(half);
      s.buffer = [tail];
      s.bufferLen = tail.length;
      this.dispatch(source, head, false, s.utteranceId || nextId());
    }
    if (this.partialTimers[source]) clearTimeout(this.partialTimers[source]!);
    this.partialTimers[source] = setTimeout(() => {
      if (s.bufferLen > 0 && s.inSpeech) {
        const merged = drainToInt16(s.buffer, s.bufferLen);
        s.buffer = [];
        s.bufferLen = 0;
        s.lastPartialDispatchMs = Date.now();
        this.dispatch(source, merged, false, s.utteranceId || nextId());
      }
    }, 800);
  }

  private flushSource(source: AudioSource, final: boolean, epoch?: number): void {
    const s = this.sources[source];
    if (s.bufferLen === 0) return;
    const merged = drainToInt16(s.buffer, s.bufferLen);
    s.buffer = [];
    s.bufferLen = 0;
    const id = s.utteranceId || nextId();
    if (final) s.utteranceId = null; // utterance complete; next speech gets a new id
    this.dispatch(source, merged, final, id, epoch);
  }

  private async dispatch(source: AudioSource, pcm: Int16Array, final: boolean, utteranceId: string, epoch?: number): Promise<void> {
    if (pcm.length === 0) return;
    const myEpoch = epoch ?? this.epoch;
    const req: TranscriptionRequest = { pcm, sampleRate: config.audio.targetSampleRate, partial: !final };
    try {
      const result = await this.provider.transcribe(req);
      if (myEpoch !== this.epoch) return; // superseded by stop(): drop silently
      if (!result.text || result.text.trim().length === 0) return;
      if (isTranscriptGarbage(result.text)) return; // non-speech ASR output: never enters context
      const evt: TranscriptEvent = {
        id: utteranceId,
        source,
        speaker: this.attributeSpeaker(source),
        text: result.text,
        timestamp: Date.now(),
        isFinal: !!result.isFinal && final,
        confidence: result.confidence,
        language: result.language,
      };
      this.emit("transcript", evt);
    } catch (e) {
      logger.warn("dispatch failed", e);
      try {
        this.errorHandler?.(`transcription:${source}`, String((e as Error)?.message || e).slice(0, 500));
      } catch {
        // ignore
      }
    }
  }
}

function drainToInt16(chunks: Int16Array[], total: number): Int16Array {
  const out = new Int16Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}