export type AudioSource = "microphone" | "system";

export type SpeakerRole = "candidate" | "interviewer" | "unknown";

export type TranscriptionStatus =
  | "idle"
  | "ready"
  | "listening"
  | "processing"
  | "error";

export interface TranscriptEvent {
  id: string;
  source: AudioSource;
  speaker: SpeakerRole;
  text: string;
  timestamp: number;
  isFinal: boolean;
  confidence?: number;
  language?: string;
}

export interface AudioCaptureStatus {
  source: AudioSource;
  active: boolean;
  sampleRate: number;
  channels: number;
  format: string;
  error?: string;
}

export interface AppStatus {
  transcription: TranscriptionStatus;
  microphone: AudioCaptureStatus | null;
  system: AudioCaptureStatus | null;
  providerName: string;
  errorMessage?: string;
  screen?: ScreenSubsystemStatus;
  /** Name of the active answer/vision LLM provider (if reasoning is enabled). */
  answerProviderName?: string;
  /** Compact candidate/session state for the overlay (Phase 30). */
  profileName?: string;
  personaLabel?: string;
  jobTitle?: string;
  sessionStatus?: "none" | "running" | "paused" | "ended";
  sessionQuestionCount?: number;
}

export type AppStatusListener = (status: AppStatus) => void;
export type TranscriptListener = (event: TranscriptEvent) => void;

export type QuestionType =
  | "behavioral"
  | "resume"
  | "technical"
  | "coding"
  | "system_design"
  | "conceptual"
  | "follow_up"
  | "general";

export interface ContextEntry {
  id: string;
  speaker: SpeakerRole;
  source: AudioSource;
  text: string;
  timestamp: number;
  transcriptEventId: string;
  /**
   * Typed context kind. Older entries (and all audio transcripts) default to
   * "transcript" when absent, so existing persisted snapshots keep working.
   */
  kind?: ContextKind;
  metadata?: Record<string, unknown>;
}

export type ContextKind = "transcript" | "screen" | "question" | "answer";

export interface QuestionDetectedEvent {
  id: string;
  question: string;
  speaker: SpeakerRole;
  source: AudioSource;
  type: QuestionType;
  confidence: number;
  timestamp: number;
  transcriptEventId: string;
  recentContext: ContextEntry[];
  /** Screen-context entry ids that contributed to this question, if any. */
  screenContextIds?: string[];
  /** Where the question text primarily came from. Defaults to "audio". */
  origin?: "audio" | "screen" | "fused";
  /**
   * When a fragmented utterance ("Can you tell me" + "about X?") is merged
   * into one logical question, the merged event carries the id of the
   * earlier fragment event it replaces so history can mark it superseded.
   */
  supersedes?: string;
  /** Fused audio+screen context text when origin is "fused". */
  fusedContext?: string;
}

export type QuestionListener = (event: QuestionDetectedEvent) => void;
export type ContextListener = (entry: ContextEntry) => void;

export type ScreenMonitorState = boolean;

export type ScreenProcessorState =
  | "ready"
  | "processing"
  | "error"
  | "unavailable";

export interface ScreenSubsystemStatus {
  monitoring: ScreenMonitorState;
  ocr: ScreenProcessorState;
  vision: ScreenProcessorState;
  visionMode: "local" | "remote" | "disabled";
  lastText?: string;
  lastEventAt?: number;
}

export interface AnswerEvent {
  id: string;
  questionId: string;
  question: string;
  kind: "fast" | "strong";
  text: string;
  model: string;
  timestamp: number;
  latencyMs?: number;
  stale?: boolean;
  /**
   * Progressive streaming chunk (accumulated text so far). The final event
   * for a generation always has partial falsy; session/context recording
   * must only use final events.
   */
  partial?: boolean;
}

export type AnswerListener = (event: AnswerEvent) => void;

export const IPC = {
  toggleCapture: "intervia:capture:toggle",
  startCapture: "intervia:capture:start",
  stopCapture: "intervia:capture:stop",
  statusUpdate: "intervia:status:update",
  transcriptEvent: "intervia:transcript:event",
  contextEvent: "intervia:context:event",
  questionEvent: "intervia:question:event",
  getStatus: "intervia:status:get",
  hideOverlay: "intervia:overlay:hide",
  screenStart: "intervia:screen:start",
  screenStop: "intervia:screen:stop",
  screenCaptureNow: "intervia:screen:capture-now",
  screenSelectRegion: "intervia:screen:select-region",
  screenRegionSelected: "intervia:screen:region-selected",
  screenSelectCancelled: "intervia:screen:select-cancelled",
  screenEvent: "intervia:screen:event",
  screenSnapshot: "intervia:screen:snapshot",
  answerEvent: "intervia:answer:event",
  answerError: "intervia:answer:error",
  settingsOpen: "intervia:settings:open",
} as const;