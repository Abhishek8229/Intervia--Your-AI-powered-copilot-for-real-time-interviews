import { config } from "../config";

export interface VadEvent {
  type: "speech-start" | "speech-end";
  timestamp: number;
}

export interface VadOptions {
  rmsThreshold: number;
  silenceMs: number;
  minSpeechMs: number;
  sampleRate: number;
}

export class Vad {
  private opts: VadOptions;
  private inSpeech = false;
  private speechStartMs = 0;
  private lastAboveThresholdMs = 0;
  private listener: ((e: VadEvent) => void) | null = null;

  constructor(opts?: Partial<VadOptions>) {
    this.opts = {
      rmsThreshold: opts?.rmsThreshold ?? config.vad.rmsThreshold,
      silenceMs: opts?.silenceMs ?? config.vad.silenceMs,
      minSpeechMs: opts?.minSpeechMs ?? config.vad.minSpeechMs,
      sampleRate: opts?.sampleRate ?? config.audio.targetSampleRate,
    };
  }

  setSampleRate(sr: number): void {
    this.opts.sampleRate = sr;
  }

  onEvent(listener: (e: VadEvent) => void): void {
    this.listener = listener;
  }

  reset(): void {
    this.inSpeech = false;
    this.speechStartMs = 0;
    this.lastAboveThresholdMs = 0;
  }

  feed(pcm: Int16Array): void {
    if (pcm.length === 0) return;
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / pcm.length);
    const frameMs = (pcm.length / this.opts.sampleRate) * 1000;
    const now = Date.now();
    const above = rms >= this.opts.rmsThreshold;

    if (above) {
      this.lastAboveThresholdMs = now;
      if (!this.inSpeech) {
        this.inSpeech = true;
        this.speechStartMs = now;
        this.listener?.({ type: "speech-start", timestamp: now });
      }
    } else if (this.inSpeech) {
      const silenceFor = now - this.lastAboveThresholdMs;
      const speechDur = now - this.speechStartMs;
      if (silenceFor >= this.opts.silenceMs && speechDur >= this.opts.minSpeechMs) {
        this.inSpeech = false;
        this.listener?.({ type: "speech-end", timestamp: now });
        this.speechStartMs = 0;
      } else if (silenceFor >= this.opts.silenceMs) {
        this.inSpeech = false;
        this.speechStartMs = 0;
      }
    }
  }

  isSpeech(): boolean { return this.inSpeech; }

  computeRms(pcm: Int16Array): number {
    if (pcm.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] / 32768;
      sum += v * v;
    }
    return Math.sqrt(sum / pcm.length);
  }
}