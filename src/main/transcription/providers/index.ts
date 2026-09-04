import { TranscriptionProvider } from "./TranscriptionProvider";
import { WhisperServerProvider } from "./WhisperServerProvider";
import { GroqWhisperProvider } from "./GroqWhisperProvider";
import { config } from "../../config";
import { logger } from "../../logger";

export function createProvider(name?: string): TranscriptionProvider {
  const which = (name || config.provider || "whisper-server").toLowerCase();
  switch (which) {
    case "whisper-server":
    case "whisper_cpp":
    case "whispercpp":
      return new WhisperServerProvider();
    case "groq":
      return new GroqWhisperProvider();
    default:
      logger.warn("Unknown provider, defaulting to whisper-server", which);
      return new WhisperServerProvider();
  }
}

export { TranscriptionProvider, TranscriptionProviderStatus, TranscriptionRequest, TranscriptionResult } from "./TranscriptionProvider";
export { WhisperServerProvider } from "./WhisperServerProvider";
export { GroqWhisperProvider } from "./GroqWhisperProvider";