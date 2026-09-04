import * as fs from "fs";
import * as path from "path";
import { AppConfig } from "./config-types";

/**
 * Minimal .env support (no dependency): loads INTERVIA_* values from
 * INTERVIA_ENV_FILE or ./.env so API keys never live in source code.
 * Real environment variables always win; only INTERVIA_-prefixed keys are
 * accepted; failures never break boot.
 */
/** Pure KEY=VALUE application used by loadDotEnv (exported for tests). */
export function applyDotEnvText(raw: string): void {
  for (const line of String(raw || "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (!/^INTERVIA_[A-Z0-9_]+$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // real environment wins
    let val = t.slice(eq + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

function loadDotEnv(): void {
  try {
    const candidates = [process.env.INTERVIA_ENV_FILE || "", path.join(process.cwd(), ".env")];
    for (const f of candidates) {
      try {
        if (!f || !fs.existsSync(f)) continue;
        applyDotEnvText(fs.readFileSync(f, "utf8"));
        break;
      } catch {
        // try the next candidate
      }
    }
  } catch {
    // env loading never breaks boot
  }
}

loadDotEnv();

function num(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
}

function str(name: string, def: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : def;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  return raw === "1" || raw.toLowerCase() === "true";
}

function visionMode(name: string, def: "local" | "remote" | "disabled"): "local" | "remote" | "disabled" {
  const raw = (process.env[name] || "").toLowerCase();
  if (raw === "local" || raw === "remote" || raw === "disabled") return raw;
  return def;
}

const cfg: AppConfig = {
  provider: str("INTERVIA_STT_PROVIDER", "whisper-server"),
  whisper: {
    endpoint: str("INTERVIA_WHISPER_ENDPOINT", "http://127.0.0.1:8080"),
    timeoutMs: num("INTERVIA_WHISPER_TIMEOUT_MS", 30000),
  },
  groq: {
    apiKey: str("INTERVIA_GROQ_API_KEY", ""),
    endpoint: str("INTERVIA_GROQ_ENDPOINT", "https://api.groq.com/openai/v1"),
    model: str("INTERVIA_GROQ_MODEL", "whisper-large-v3"),
    timeoutMs: num("INTERVIA_GROQ_TIMEOUT_MS", 30000),
  },
  audio: {
    targetSampleRate: num("INTERVIA_AUDIO_SR", 16000),
    targetChannels: num("INTERVIA_AUDIO_CH", 1),
    chunkMs: num("INTERVIA_AUDIO_CHUNK_MS", 250),
    maxBufferMs: num("INTERVIA_AUDIO_MAX_BUFFER_MS", 15000),
  },
  vad: {
    enabled: (str("INTERVIA_VAD", "1") === "1"),
    rmsThreshold: num("INTERVIA_VAD_RMS", 0.012),
    silenceMs: num("INTERVIA_VAD_SILENCE_MS", 700),
    minSpeechMs: num("INTERVIA_VAD_MIN_SPEECH_MS", 250),
  },
  overlay: {
    width: num("INTERVIA_OVERLAY_W", 420),
    height: num("INTERVIA_OVERLAY_H", 320),
  },
  screen: {
    enabled: bool("INTERVIA_SCREEN_ENABLED", true),
    monitorIntervalMs: num("INTERVIA_SCREEN_INTERVAL_MS", 2500),
    downscaleWidth: num("INTERVIA_SCREEN_DOWNSCALE_W", 480),
    changeThresholdBits: num("INTERVIA_SCREEN_CHANGE_BITS", 6),
    dedupeWindowMs: num("INTERVIA_SCREEN_DEDUP_MS", 60000),
    minEventGapMs: num("INTERVIA_SCREEN_MIN_GAP_MS", 3000),
    fusionMaxAgeMs: num("INTERVIA_SCREEN_FUSION_MAX_AGE_MS", 120000),
    hotkey: str("INTERVIA_SCREEN_HOTKEY", "CommandOrControl+Shift+S"),
  },
  ocr: {
    provider: str("INTERVIA_OCR_PROVIDER", "tesseract"),
    timeoutMs: num("INTERVIA_OCR_TIMEOUT_MS", 20000),
  },
  vision: {
    provider: str("INTERVIA_VISION_PROVIDER", "mock"),
    mode: visionMode("INTERVIA_VISION_MODE", "local"),
    model: str("INTERVIA_VISION_MODEL", str("INTERVIA_GEMINI_MODEL", "gemini-2.5-flash")),
    endpoint: str("INTERVIA_VISION_ENDPOINT", "https://generativelanguage.googleapis.com"),
    apiKey: str("INTERVIA_GEMINI_API_KEY", ""),
    timeoutMs: num("INTERVIA_VISION_TIMEOUT_MS", 30000),
  },
  llm: {
    provider: str("INTERVIA_LLM_PROVIDER", "mock"),
    fastProvider: str("INTERVIA_LLM_FAST_PROVIDER", str("INTERVIA_LLM_PROVIDER", "mock")),
    strongProvider: str("INTERVIA_LLM_STRONG_PROVIDER", str("INTERVIA_LLM_PROVIDER", "mock")),
    fastModel: str("INTERVIA_LLM_FAST_MODEL", "gemini-2.5-flash"),
    strongModel: str("INTERVIA_LLM_STRONG_MODEL", "gemini-2.5-flash"),
    endpoint: str("INTERVIA_LLM_ENDPOINT", "https://generativelanguage.googleapis.com"),
    apiKey: str("INTERVIA_GEMINI_API_KEY", ""),
    timeoutMs: num("INTERVIA_LLM_TIMEOUT_MS", 45000),
  },
  minimax: {
    endpoint: str("INTERVIA_MINIMAX_ENDPOINT", "https://api.minimax.io/v1"),
    apiKey: str("INTERVIA_MINIMAX_API_KEY", ""),
    model: str("INTERVIA_MINIMAX_MODEL", "MiniMax-M2"),
    fastModel: str("INTERVIA_MINIMAX_FAST_MODEL", str("INTERVIA_MINIMAX_MODEL", "MiniMax-M2")),
    strongModel: str("INTERVIA_MINIMAX_STRONG_MODEL", str("INTERVIA_MINIMAX_MODEL", "MiniMax-M2")),
  },
  openrouter: {
    endpoint: str("INTERVIA_OPENROUTER_ENDPOINT", "https://openrouter.ai/api/v1"),
    apiKey: str("INTERVIA_OPENROUTER_API_KEY", ""),
    model: str("INTERVIA_OPENROUTER_MODEL", "openrouter/auto"),
    timeoutMs: num("INTERVIA_FREE_TIER_TIMEOUT_MS", num("INTERVIA_LLM_TIMEOUT_MS", 25000)),
  },
  geminiFree: {
    endpoint: str("INTERVIA_GEMINI_ENDPOINT", "https://generativelanguage.googleapis.com"),
    apiKey: str("INTERVIA_GEMINI_API_KEY", ""),
    model: str("INTERVIA_GEMINI_MODEL", str("INTERVIA_GEMINI_FREE_MODEL", str("INTERVIA_LLM_FAST_MODEL", "gemini-2.5-flash"))),
  },
  localAi: {
    enabled: bool("INTERVIA_LOCAL_AI_ENABLED", true),
  },
  reasoning: {
    enabled: bool("INTERVIA_REASONING_ENABLED", true),
    maxScreenChars: num("INTERVIA_REASONING_MAX_SCREEN_CHARS", 2000),
    maxRecentEntries: num("INTERVIA_REASONING_MAX_RECENT", 12),
    answerLength: ((): "short" | "medium" | "detailed" => {
      const v = (process.env.INTERVIA_ANSWER_LENGTH || "").toLowerCase();
      return v === "short" || v === "detailed" ? v : "medium";
    })(),
  },
  candidate: {
    profileFile: str("INTERVIA_CANDIDATE_FILE", ""),
    jobDescriptionFile: str("INTERVIA_JOB_FILE", ""),
  },
};

export { cfg as config };