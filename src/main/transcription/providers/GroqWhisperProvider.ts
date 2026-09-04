import * as https from "https";
import * as http from "http";
import * as url from "url";
import { logger } from "../../logger";
import {
  TranscriptionProvider,
  TranscriptionProviderStatus,
  TranscriptionRequest,
  TranscriptionResult,
} from "./TranscriptionProvider";
import { config } from "../../config";

export class GroqWhisperProvider implements TranscriptionProvider {
  readonly name = "groq";
  private ready = false;
  private lastError = "";
  private lastCheckAt = 0;

  constructor(private opts: {
    apiKey: string;
    endpoint: string;
    model: string;
    timeoutMs: number;
  } = {
    apiKey: config.groq.apiKey,
    endpoint: config.groq.endpoint,
    model: config.groq.model,
    timeoutMs: config.groq.timeoutMs,
  }) {}

  async init(): Promise<void> {
    this.lastCheckAt = Date.now();
    this.ready = !!this.opts.apiKey;
    if (!this.ready) {
      this.lastError = "missing INTERVIA_GROQ_API_KEY";
      logger.warn("GroqWhisperProvider: missing API key, will not be ready");
    } else {
      this.lastError = "";
      logger.info("GroqWhisperProvider ready");
    }
  }

  isReady(): boolean { return this.ready; }

  /** Status carries endpoint/model only — the API key is NEVER exposed. */
  getStatus(): TranscriptionProviderStatus {
    const configured = this.opts.apiKey.length > 0 && this.opts.endpoint.length > 0;
    return {
      name: this.name,
      kind: "cloud",
      endpoint: this.opts.endpoint,
      model: this.opts.model,
      configured,
      connected: this.ready,
      state: this.ready ? "CONNECTED" : configured ? "DISCONNECTED" : "ERROR",
      lastError: this.lastError,
      lastCheckAt: this.lastCheckAt,
    };
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    if (!this.ready) return { text: "", isFinal: req.partial ? false : true };
    try {
      const wav = pcm16ToWav(req.pcm, req.sampleRate);
      const body = buildMultipart(wav, "audio.wav", this.opts.model);
      const resp = await postMultipart(
        this.opts.endpoint.replace(/\/$/, "") + "/audio/transcriptions",
        body,
        { Authorization: `Bearer ${this.opts.apiKey}` },
        this.opts.timeoutMs
      );
      if (!resp) {
        this.ready = false;
        this.lastCheckAt = Date.now();
        this.lastError = "empty response from Groq transcriptions endpoint";
        return { text: "", isFinal: req.partial ? false : true };
      }
      return { text: (resp.text || "").trim(), isFinal: req.partial ? false : true, language: resp.language };
    } catch (e) {
      this.ready = false;
      this.lastCheckAt = Date.now();
      this.lastError = String((e as Error)?.message || e).slice(0, 300);
      logger.warn("GroqWhisperProvider failed", e);
      return { text: "", isFinal: req.partial ? false : true };
    }
  }

  /** Session end keeps key-based readiness (see whisper-server rationale). */
  async shutdown(): Promise<void> {
    // No-op by design; readiness is re-checked on start().
  }
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

export function buildMultipart(wav: Buffer, filename: string, model: string): { body: Buffer; boundary: string } {
  const boundary = "----intervia" + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: audio/wav\r\n\r\n`
  );
  const modelPart = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `${model}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
    `json\r\n` +
    `--${boundary}--\r\n`
  );
  return { body: Buffer.concat([head, wav, modelPart]), boundary };
}

function postMultipart(
  target: string,
  payload: { body: Buffer; boundary: string },
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ text?: string; language?: string } | null> {
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
        ...headers,
        "Content-Type": `multipart/form-data; boundary=${payload.boundary}`,
        "Content-Length": payload.body.length,
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { data += d; });
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          resolve({ text: j.text || "", language: j.language });
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(payload.body);
    req.end();
  });
}