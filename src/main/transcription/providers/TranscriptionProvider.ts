export interface TranscriptionRequest {
  pcm: Int16Array;
  sampleRate: number;
  language?: string;
  partial?: boolean;
}

export interface TranscriptionResult {
  text: string;
  isFinal: boolean;
  confidence?: number;
  language?: string;
}

/**
 * Explicit STT backend status for diagnostics (Phase: real pipeline).
 * `state` vocabulary is fixed so the UI can render it without guessing:
 * CONNECTED = frames will really be transcribed; DISCONNECTED = backend
 * unreachable (mock-labeled fallback only); ERROR = misconfigured.
 * `lastError` carries the human reason; never any secret material.
 */
export interface TranscriptionProviderStatus {
  name: string;
  kind: "local" | "cloud";
  endpoint: string;
  model?: string;
  configured: boolean;
  connected: boolean;
  state: "CONNECTED" | "DISCONNECTED" | "ERROR";
  lastError: string;
  lastCheckAt: number;
}

export interface TranscriptionProvider {
  readonly name: string;
  init(): Promise<void>;
  isReady(): boolean;
  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult>;
  shutdown(): Promise<void>;
  getStatus?(): TranscriptionProviderStatus;
}