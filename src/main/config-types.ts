export type AppConfig = {
  provider: string;
  whisper: { endpoint: string; timeoutMs: number };
  groq: { apiKey: string; endpoint: string; model: string; timeoutMs: number };
  audio: {
    targetSampleRate: number;
    targetChannels: number;
    chunkMs: number;
    maxBufferMs: number;
  };
  vad: {
    enabled: boolean;
    rmsThreshold: number;
    silenceMs: number;
    minSpeechMs: number;
  };
  overlay: { width: number; height: number };
  screen: {
    enabled: boolean;
    monitorIntervalMs: number;
    downscaleWidth: number;
    changeThresholdBits: number;
    /** Suppress repeated auto screen events for identical content. */
    dedupeWindowMs: number;
    /** Minimum gap between automatic screen-context events. */
    minEventGapMs: number;
    /** Screen content older than this is not fused with new audio. */
    fusionMaxAgeMs: number;
    /** Global hotkey that opens the manual region selector. */
    hotkey: string;
  };
  ocr: {
    provider: string;
    timeoutMs: number;
  };
  vision: {
    provider: string;
    /** "local" = on-device only (no uploads); "remote" = cloud vision allowed. */
    mode: "local" | "remote" | "disabled";
    model: string;
    endpoint: string;
    apiKey: string;
    timeoutMs: number;
  };
  llm: {
    provider: string;
    fastProvider: string;
    strongProvider: string;
    fastModel: string;
    strongModel: string;
    endpoint: string;
    apiKey: string;
    timeoutMs: number;
  };
  minimax: {
    endpoint: string;
    apiKey: string;
    model: string;
    fastModel: string;
    strongModel: string;
  };
  openrouter: {
    endpoint: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
  };
  geminiFree: {
    endpoint: string;
    apiKey: string;
    model: string;
  };
  localAi: {
    enabled: boolean;
  };
  reasoning: {
    enabled: boolean;
    maxScreenChars: number;
    maxRecentEntries: number;
    answerLength: "short" | "medium" | "detailed";
  };
  candidate: {
    /** Optional file paths whose contents ground the answers. */
    profileFile: string;
    jobDescriptionFile: string;
  };
};