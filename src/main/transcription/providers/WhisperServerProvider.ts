import * as http from "http";
import * as https from "https";
import * as url from "url";
import { logger } from "../../logger";
import {
  TranscriptionProvider,
  TranscriptionProviderStatus,
  TranscriptionRequest,
  TranscriptionResult,
} from "./TranscriptionProvider";
import { config } from "../../config";

export class WhisperServerProvider implements TranscriptionProvider {
  readonly name = "whisper-server";
  private ready = false;
  private lastError = "";
  private lastCheckAt = 0;

  constructor(private opts: { endpoint: string; timeoutMs: number } = {
    endpoint: config.whisper.endpoint,
    timeoutMs: config.whisper.timeoutMs,
  }) {}

  async init(): Promise<void> {
    try {
      const ok = await this.health();
      this.lastCheckAt = Date.now();
      if (ok) {
        this.ready = true;
        this.lastError = "";
        logger.info("WhisperServerProvider ready", this.opts.endpoint);
      } else {
        this.ready = false;
        if (!this.lastError) this.lastError = `not reachable at ${this.opts.endpoint} (is whisper-server running? INTERVIA_WHISPER_ENDPOINT)`;
        logger.warn("WhisperServerProvider not reachable - will use mock fallback", this.opts.endpoint);
      }
    } catch (e) {
      this.ready = false;
      this.lastCheckAt = Date.now();
      this.lastError = String((e as Error)?.message || e).slice(0, 300);
      logger.warn("WhisperServerProvider init failed", e);
    }
  }

  isReady(): boolean { return this.ready; }

  getStatus(): TranscriptionProviderStatus {
    return {
      name: this.name,
      kind: "local",
      endpoint: this.opts.endpoint,
      configured: this.opts.endpoint.length > 0,
      connected: this.ready,
      state: this.ready ? "CONNECTED" : "DISCONNECTED",
      lastError: this.lastError,
      lastCheckAt: this.lastCheckAt,
    };
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    if (!this.ready) {
      return this.mockResult(req);
    }
    try {
      const wav = pcm16ToWav(req.pcm, req.sampleRate);
      const url2 = this.opts.endpoint.replace(/\/$/, "") + "/inference";
      const resp = await postRaw(url2, wav, this.opts.timeoutMs);
      if (!resp || !resp.text) {
        this.markDown("empty response from " + url2);
        return this.mockResult(req);
      }
      return {
        text: resp.text.trim(),
        isFinal: req.partial ? false : true,
        language: resp.language,
        confidence: resp.confidence,
      };
    } catch (e) {
      this.markDown(String((e as Error)?.message || e));
      logger.warn("WhisperServerProvider transcribe failed", e);
      return this.mockResult(req);
    }
  }

  /**
   * Session end must NOT kill server reachability: ending one capture and
   * starting another (Start -> Stop -> Start) keeps a reachable server
   * usable. Only real failures flip readiness (see markDown).
   */
  async shutdown(): Promise<void> {
    // No-op by design: no per-session resources; readiness is re-checked on start().
  }

  private markDown(reason: string): void {
    this.ready = false;
    this.lastCheckAt = Date.now();
    this.lastError = `transcribe failed: ${reason}`.slice(0, 300);
  }

  private mockResult(req: TranscriptionRequest): TranscriptionResult {
    const dur = req.pcm.length / req.sampleRate;
    const rms = computeRms(req.pcm);
    const loud = rms > config.vad.rmsThreshold;
    const text = loud
      ? `[mock transcription — ${dur.toFixed(2)}s of audio]`
      : "";
    return { text, isFinal: req.partial ? false : true };
  }

  private health(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const u = new URL(this.opts.endpoint);
        const mod = u.protocol === "https:" ? https : http;
        const req = mod.get({ host: u.hostname, port: u.port || undefined, path: "/", timeout: 2000 }, (res) => {
          res.resume();
          resolve(res.statusCode !== undefined && res.statusCode < 500);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
      } catch {
        resolve(false);
      }
    });
  }
}

function computeRms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length);
}

function pcm16ToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const numSamples = pcm.length;
  const blockAlign = 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    buffer.writeInt16LE(pcm[i], 44 + i * 2);
  }
  return buffer;
}

function postRaw(target: string, body: Buffer, timeoutMs: number): Promise<{ text: string; language?: string; confidence?: number } | null> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(target); } catch { resolve(null); return; }
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request({
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + (parsed.search || ""),
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": body.length,
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { data += d; });
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          resolve({ text: j.text || j.transcript || "", language: j.language, confidence: j.confidence });
        } catch {
          resolve({ text: data.trim() });
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}