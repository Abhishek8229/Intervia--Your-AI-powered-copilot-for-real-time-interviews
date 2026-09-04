export type AudioSource = "microphone" | "system";

export type TranscriptionStatus =
  | "idle"
  | "ready"
  | "listening"
  | "processing"
  | "error";

export interface TranscriptEvent {
  id: string;
  source: AudioSource;
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
}

export type AppStatusListener = (status: AppStatus) => void;
export type TranscriptListener = (event: TranscriptEvent) => void;