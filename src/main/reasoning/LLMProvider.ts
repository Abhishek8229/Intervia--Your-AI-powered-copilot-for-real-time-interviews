/**
 * Minimal LLM provider abstraction for the reasoning pipeline.
 *
 * NOTE (honesty): no LLM/answer stack existed in the repo before the
 * screen-context phase — only the transcription provider abstraction did.
 * This module introduces the text-generation side reusing the same
 * configuration style (endpoint + model + key from env, never logged).
 * Resume parsing / candidate-profile extraction remain out of scope;
 * PromptBuilder accepts optional profile/JD text loaded from files.
 */

import { LLMProviderKind } from "../../common/screen-types";
import { logger } from "../logger";
import {
  GEMINI_ENDPOINT_DEFAULT,
  OPENROUTER_ENDPOINT_DEFAULT,
  OPENROUTER_FREE_MODEL_DEFAULT,
  PRIMARY_GEMINI_MODEL_DEFAULT,
} from "./FreeTierConfig";

export interface LLMRequest {
  prompt: string;
  system?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  model?: string;
}

export interface LLMResult {
  text: string;
  model: string;
  latencyMs: number;
}

export interface LLMProvider {
  readonly name: string;
  isAvailable(): Promise<boolean> | boolean;
  generate(req: LLMRequest): Promise<LLMResult>;
  /**
   * Optional progressive generation. Calls onChunk with text DELTAS as they
   * arrive and resolves with the full accumulated result (same contract as
   * generate). Absence means "no streaming support" — callers fall back to
   * generate(). Abortion via req.signal must reject promptly.
   */
  generateStream?(req: LLMRequest, onChunk: (delta: string) => void): Promise<LLMResult>;
}

/**
 * Split an SSE byte-buffer into complete `data:` payloads, returning any
 * trailing incomplete line for the next chunk. Malformed lines are skipped
 * (never throw on provider wire noise).
 */
export function splitSsePayloads(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    payloads.push(payload);
  }
  return { payloads, rest };
}

function timed<T>(fn: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const t0 = Date.now();
  return fn().then((value) => ({ value, latencyMs: Date.now() - t0 }));
}

/**
 * Offline/placeholder provider. Produces extractive, clearly-scoped drafts
 * from the actual prompt question so the end-to-end pipeline (fast + strong,
 * staleness, UI) works without credentials. Not a substitute for a real
 * model — used only until a key is configured.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = "mock-llm";
  private role: "fast" | "strong";
  private delayMs: number;

  constructor(role: "fast" | "strong" = "fast", delayMs = 5) {
    this.role = role;
    this.delayMs = delayMs;
  }

  isAvailable(): boolean {
    return true;
  }

  async generate(req: LLMRequest): Promise<LLMResult> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (req.signal?.aborted) throw new Error("llm request aborted");
    const text = this.compose(req);
    return { text, model: `mock-${this.role}`, latencyMs: this.delayMs };
  }

  /** Chunked twin of generate() so engine/overlay streaming is testable offline. */
  async generateStream(req: LLMRequest, onChunk: (delta: string) => void): Promise<LLMResult> {
    const t0 = Date.now();
    const text = this.compose(req);
    // Deterministic word-chunks (no timers beyond the initial delay).
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const words = text.split(/(\s+)/);
    let buf = "";
    for (const w of words) {
      if (req.signal?.aborted) throw new Error("llm request aborted");
      buf += w;
      if (buf.length >= 24 || w === words[words.length - 1]) {
        onChunk(buf);
        buf = "";
      }
    }
    if (buf) onChunk(buf);
    return { text, model: `mock-${this.role}`, latencyMs: Date.now() - t0 };
  }

  private compose(req: LLMRequest): string {
    const question = extractQuestionLine(req.prompt);
    const screen = extractSection(req.prompt, "SCREEN CONTEXT");
    return this.role === "fast"
      ? `Quick take: ${question}` +
        (screen ? ` (using on-screen context: ${screen.slice(0, 140)}${screen.length > 140 ? "…" : ""})` : "") +
        ` — key points first, details in the refined answer.`
      : `Refined answer to "${question}":\n1) Direct response grounded in your experience.\n2) Reasoning / trade-offs.` +
        (screen ? `\n3) On-screen specifics addressed: ${screen.slice(0, 200)}${screen.length > 200 ? "…" : ""}` : "") +
        `\nClose with a concise summary.`;
  }
}

function extractQuestionLine(prompt: string): string {
  const m = prompt.match(/CURRENT QUESTION\s*\n([\s\S]*?)(?:\n\n|\n[A-Z][A-Z ]+\n|$)/);
  const line = (m?.[1] || "").trim().split("\n")[0].trim();
  return line || "the interviewer's question";
}

function extractSection(prompt: string, name: string): string {
  const re = new RegExp(name + "\\s*\\n([\\s\\S]*?)(?:\\n\\n[A-Z][A-Z /]+\\n|$)");
  const m = prompt.match(re);
  return (m?.[1] || "").trim();
}

/** Provider that always fails — verifies error paths. */
export class FailingLLMProvider implements LLMProvider {
  readonly name = "failing-llm";
  isAvailable(): boolean {
    return true;
  }
  async generate(): Promise<LLMResult> {
    throw new Error("mock llm failure");
  }
}

/** Gemini text generation reusing the shared Gemini configuration. */
export class GeminiLLMProvider implements LLMProvider {
  readonly name: string = "gemini-llm";
  private endpoint: string;
  private model: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(opts?: { endpoint?: string; model?: string; apiKey?: string; timeoutMs?: number }) {
    this.endpoint = (opts?.endpoint || process.env.INTERVIA_LLM_ENDPOINT || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
    this.model = opts?.model || process.env.INTERVIA_LLM_FAST_MODEL || "gemini-2.0-flash";
    this.apiKey = opts?.apiKey ?? (process.env.INTERVIA_GEMINI_API_KEY || process.env.INTERVIA_LLM_API_KEY || "");
    this.timeoutMs = opts?.timeoutMs ?? Number(process.env.INTERVIA_LLM_TIMEOUT_MS || 45000);
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async generate(req: LLMRequest): Promise<LLMResult> {
    if (!this.isAvailable()) throw new Error("gemini llm unavailable (missing INTERVIA_GEMINI_API_KEY)");
    const model = req.model || this.model;
    const url = `${this.endpoint}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const { value, latencyMs } = await timed(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error("llm timeout")), this.timeoutMs);
      const onAbort = (): void => ctrl.abort(req.signal?.reason);
      req.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify({
            systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
            contents: [{ parts: [{ text: req.prompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: req.maxTokens ?? 512 },
          }),
          signal: req.signal ? anySignal([req.signal, ctrl.signal]) : ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`gemini request failed (${res.status}): ${text.slice(0, 300)}`);
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const out = extractGeminiText(parsed);
        if (!out) throw new Error("gemini returned no text");
        return out;
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
      }
    });
    return { text: value, model, latencyMs };
  }

  /**
   * Progressive generation via streamGenerateContent SSE. Falls back to
   * throwing (caller uses generate()) when the stream yields no text —
   * an empty stream is a failure, never an empty answer.
   */
  async generateStream(req: LLMRequest, onChunk: (delta: string) => void): Promise<LLMResult> {
    if (!this.isAvailable()) throw new Error("gemini llm unavailable (missing INTERVIA_GEMINI_API_KEY)");
    const model = req.model || this.model;
    const url = `${this.endpoint}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("llm timeout")), this.timeoutMs);
    const onAbort = (): void => ctrl.abort(req.signal?.reason);
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey, Accept: "text/event-stream" },
        body: JSON.stringify({
          systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
          contents: [{ parts: [{ text: req.prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: req.maxTokens ?? 512 },
        }),
        signal: req.signal ? anySignal([req.signal, ctrl.signal]) : ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        throw new Error(`gemini stream failed (${res.status}): ${body.slice(0, 300)}`);
      }
      let full = "";
      let rest = "";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
        const split = splitSsePayloads(rest);
        rest = split.rest;
        for (const payload of split.payloads) {
          let delta = "";
          try {
            delta = extractGeminiText(JSON.parse(payload) as Record<string, unknown>);
          } catch {
            continue; // malformed chunk: skip, keep the stream alive
          }
          if (delta) {
            full += delta;
            onChunk(delta);
          }
        }
      }
      try { await reader.cancel().catch(() => undefined); } catch { /* ignore */ }
      if (!full.trim()) throw new Error("gemini stream returned no text");
      return { text: full.trim(), model, latencyMs: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

function extractGeminiText(res: Record<string, unknown>): string {
  try {
    const cands = res["candidates"] as Array<Record<string, unknown>> | undefined;
    const content = cands?.[0]?.["content"] as Record<string, unknown> | undefined;
    const parts = content?.["parts"] as Array<Record<string, unknown>> | undefined;
    return (parts?.map((p) => (typeof p["text"] === "string" ? (p["text"] as string) : "")).join("\n") || "").trim();
  } catch {
    return "";
  }
}

/**
 * Generic OpenAI-compatible chat-completions text provider.
 */
export class OpenAICompatibleLLMProvider implements LLMProvider {
  readonly name: string = "openai-compatible-llm";
  private endpoint: string;
  private model: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(opts?: { endpoint?: string; model?: string; apiKey?: string; timeoutMs?: number }) {
    this.endpoint = (opts?.endpoint || process.env.INTERVIA_LLM_ENDPOINT || "").replace(/\/+$/, "");
    this.model = opts?.model || process.env.INTERVIA_LLM_FAST_MODEL || "";
    this.apiKey = opts?.apiKey ?? (process.env.INTERVIA_VISION_API_KEY || process.env.INTERVIA_LLM_API_KEY || "");
    this.timeoutMs = opts?.timeoutMs ?? Number(process.env.INTERVIA_LLM_TIMEOUT_MS || 45000);
  }

  isAvailable(): boolean {
    return this.endpoint.length > 0 && this.apiKey.length > 0 && this.model.length > 0;
  }

  async generate(req: LLMRequest): Promise<LLMResult> {
    if (!this.isAvailable()) throw new Error("openai-compatible llm unavailable (missing endpoint/key/model)");
    const model = req.model || this.model;
    const { value, latencyMs } = await timed(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error("llm timeout")), this.timeoutMs);
      try {
        const messages: Array<Record<string, string>> = [];
        if (req.system) messages.push({ role: "system", content: req.system });
        messages.push({ role: "user", content: req.prompt });
        const res = await fetch(`${this.endpoint}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: req.maxTokens ?? 512 }),
          signal: req.signal ? anySignal([req.signal, ctrl.signal]) : ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`llm request failed (${res.status}): ${text.slice(0, 300)}`);
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const choices = parsed["choices"] as Array<Record<string, unknown>> | undefined;
        const msg = choices?.[0]?.["message"] as Record<string, unknown> | undefined;
        const out = typeof msg?.["content"] === "string" ? (msg["content"] as string).trim() : "";
        if (!out) throw new Error("llm returned no text");
        return out;
      } finally {
        clearTimeout(timer);
      }
    });
    return { text: value, model, latencyMs };
  }

  /** Progressive generation via OpenAI-style SSE (`stream: true`). */
  async generateStream(req: LLMRequest, onChunk: (delta: string) => void): Promise<LLMResult> {
    if (!this.isAvailable()) throw new Error("openai-compatible llm unavailable (missing endpoint/key/model)");
    const model = req.model || this.model;
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("llm timeout")), this.timeoutMs);
    try {
      const messages: Array<Record<string, string>> = [];
      if (req.system) messages.push({ role: "system", content: req.system });
      messages.push({ role: "user", content: req.prompt });
      const res = await fetch(`${this.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}`, Accept: "text/event-stream" },
        body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: req.maxTokens ?? 512, stream: true }),
        signal: req.signal ? anySignal([req.signal, ctrl.signal]) : ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        throw new Error(`llm stream failed (${res.status}): ${body.slice(0, 300)}`);
      }
      let full = "";
      let rest = "";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
        const split = splitSsePayloads(rest);
        rest = split.rest;
        for (const payload of split.payloads) {
          let delta = "";
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            const choices = parsed["choices"] as Array<Record<string, unknown>> | undefined;
            const d = choices?.[0]?.["delta"] as Record<string, unknown> | undefined;
            delta = typeof d?.["content"] === "string" ? (d["content"] as string) : "";
          } catch {
            continue; // malformed chunk: skip, keep the stream alive
          }
          if (delta) {
            full += delta;
            onChunk(delta);
          }
        }
      }
      try { await reader.cancel().catch(() => undefined); } catch { /* ignore */ }
      if (!full.trim()) throw new Error("llm stream returned no text");
      return { text: full.trim(), model, latencyMs: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * MiniMax adapter (Phase 25). MiniMax exposes an OpenAI-compatible
 * /v1/chat/completions endpoint, so this reuses that protocol with MiniMax
 * defaults. It plugs into the generic LLM abstraction and ModelRouter —
 * no separate answer path. Kept as an internal reusable adapter; it is no
 * longer part of the normal 3-tier user-facing configuration.
 */
export class MiniMaxLLMProvider extends OpenAICompatibleLLMProvider {
  override readonly name = "minimax-llm";

  constructor(opts?: { endpoint?: string; model?: string; apiKey?: string; timeoutMs?: number }) {
    super({
      endpoint: opts?.endpoint || process.env.INTERVIA_MINIMAX_ENDPOINT || "https://api.minimax.io/v1",
      model: opts?.model || process.env.INTERVIA_MINIMAX_MODEL || "MiniMax-M2",
      apiKey: opts?.apiKey ?? (process.env.INTERVIA_MINIMAX_API_KEY || ""),
      timeoutMs: opts?.timeoutMs ?? Number(process.env.INTERVIA_LLM_TIMEOUT_MS || 45000),
    });
  }
}

/**
 * Gemini Free — primary cloud tier. Same Gemini wire protocol as
 * GeminiLLMProvider, but the model id resolves through the free-tier
 * configuration layer (explicit value, then env, then the stable Flash
 * default) so a future model swap is configuration, not redesign.
 */
export class GeminiFreeProvider extends GeminiLLMProvider {
  override readonly name = "gemini-free-llm";

  constructor(opts?: { endpoint?: string; model?: string; apiKey?: string; timeoutMs?: number }) {
    const model =
      (opts?.model || "").trim() ||
      (process.env.INTERVIA_GEMINI_MODEL || "").trim() ||
      (process.env.INTERVIA_GEMINI_FREE_MODEL || "").trim() ||
      (process.env.INTERVIA_LLM_FAST_MODEL || "").trim() ||
      PRIMARY_GEMINI_MODEL_DEFAULT;
    super({
      endpoint: opts?.endpoint || process.env.INTERVIA_GEMINI_ENDPOINT || GEMINI_ENDPOINT_DEFAULT,
      model,
      apiKey: opts?.apiKey ?? (process.env.INTERVIA_GEMINI_API_KEY || process.env.INTERVIA_LLM_API_KEY || ""),
      timeoutMs: opts?.timeoutMs ?? Number(process.env.INTERVIA_FREE_TIER_TIMEOUT_MS || process.env.INTERVIA_LLM_TIMEOUT_MS || 25000),
    });
  }
}

/**
 * OpenRouter Free — backup cloud tier. OpenAI-compatible protocol pointed
 * at OpenRouter with a free route default (`openrouter/auto`). The router
 * never upgrades to a paid model on its own: the default is a free route
 * and any explicit model is used exactly as configured.
 */
export class OpenRouterFreeProvider extends OpenAICompatibleLLMProvider {
  override readonly name = "openrouter-free-llm";
  private readonly freeModel: string;
  private readonly freeEndpoint: string;
  private readonly freeKey: string;
  private readonly freeTimeoutMs: number;

  constructor(opts?: { endpoint?: string; model?: string; apiKey?: string; timeoutMs?: number }) {
    const endpoint = ((opts?.endpoint || process.env.INTERVIA_OPENROUTER_ENDPOINT || OPENROUTER_ENDPOINT_DEFAULT) as string).replace(/\/+$/, "");
    const model = ((opts?.model || process.env.INTERVIA_OPENROUTER_MODEL || OPENROUTER_FREE_MODEL_DEFAULT) as string).trim() || OPENROUTER_FREE_MODEL_DEFAULT;
    const apiKey = opts?.apiKey ?? (process.env.INTERVIA_OPENROUTER_API_KEY || "");
    const timeoutMs = opts?.timeoutMs ?? Number(process.env.INTERVIA_FREE_TIER_TIMEOUT_MS || process.env.INTERVIA_LLM_TIMEOUT_MS || 25000);
    super({ endpoint, model, apiKey, timeoutMs });
    this.freeEndpoint = endpoint;
    this.freeModel = model;
    this.freeKey = apiKey;
    this.freeTimeoutMs = timeoutMs;
  }

  override isAvailable(): boolean {
    return this.freeKey.length > 0 && this.freeModel.length > 0 && this.freeEndpoint.length > 0;
  }

  getEndpoint(): string {
    return this.freeEndpoint;
  }

  getModel(): string {
    return this.freeModel;
  }

  override async generate(req: LLMRequest): Promise<LLMResult> {
    return this.generateViaOpenRouter(req, false, undefined);
  }

  override async generateStream(req: LLMRequest, onChunk: (delta: string) => void): Promise<LLMResult> {
    return this.generateViaOpenRouter(req, true, onChunk);
  }

  private async generateViaOpenRouter(req: LLMRequest, stream: boolean, onChunk?: (delta: string) => void): Promise<LLMResult> {
    const key = this.freeKey;
    if (!key) throw new Error("openrouter free unavailable (missing INTERVIA_OPENROUTER_API_KEY)");
    const model = req.model || this.freeModel;
    const t0 = Date.now();
    const timeoutMs = this.freeTimeoutMs;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("llm timeout")), timeoutMs);
    try {
      const messages: Array<Record<string, string>> = [];
      if (req.system) messages.push({ role: "system", content: req.system });
      messages.push({ role: "user", content: req.prompt });
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://intervia.app",
        "X-Title": "Intervia",
      };
      const res = await fetch(`${this.freeEndpoint}/chat/completions`, {
        method: "POST",
        headers: { ...headers, ...(stream ? { Accept: "text/event-stream" } : {}) },
        body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: req.maxTokens ?? 512, ...(stream ? { stream: true } : {}) }),
        signal: req.signal ? anySignal([req.signal, ctrl.signal]) : ctrl.signal,
      });
      if (!res.ok || (stream && !res.body)) {
        const body = await res.text().catch(() => "");
        throw new Error(`openrouter request failed (${res.status}): ${body.slice(0, 300)}`);
      }
      if (!stream) {
        const text = await res.text();
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const choices = parsed["choices"] as Array<Record<string, unknown>> | undefined;
        const msg = choices?.[0]?.["message"] as Record<string, unknown> | undefined;
        const out = typeof msg?.["content"] === "string" ? (msg["content"] as string).trim() : "";
        if (!out) throw new Error("openrouter returned no text");
        return { text: out, model, latencyMs: Date.now() - t0 };
      }
      let full = "";
      let rest = "";
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
        const split = splitSsePayloads(rest);
        rest = split.rest;
        for (const payload of split.payloads) {
          let delta = "";
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            const choices = parsed["choices"] as Array<Record<string, unknown>> | undefined;
            const d = choices?.[0]?.["delta"] as Record<string, unknown> | undefined;
            delta = typeof d?.["content"] === "string" ? (d["content"] as string) : "";
          } catch {
            continue;
          }
          if (delta) {
            full += delta;
            try { onChunk?.(delta); } catch { /* listener failure never breaks generation */ }
          }
        }
      }
      try { await reader.cancel().catch(() => undefined); } catch { /* ignore */ }
      if (!full.trim()) throw new Error("openrouter stream returned no text");
      return { text: full.trim(), model, latencyMs: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Local AI — final offline fallback. Fully on-device extractive drafts so
 * Intervia keeps answering with no keys, no network, and no cloud. Always
 * available by construction; readiness is reported honestly as Ready.
 */
export class LocalAIProvider implements LLMProvider {
  readonly name = "local-ai";

  isAvailable(): boolean {
    return true;
  }

  async generate(req: LLMRequest): Promise<LLMResult> {
    const t0 = Date.now();
    if (req.signal?.aborted) throw new Error("llm request aborted");
    const text = this.compose(req.prompt, false);
    return { text, model: "local-ai", latencyMs: Date.now() - t0 };
  }

  async generateStream(req: LLMRequest, onChunk: (delta: string) => void): Promise<LLMResult> {
    const t0 = Date.now();
    const text = this.compose(req.prompt, false);
    const words = text.split(/(\s+)/);
    let buf = "";
    for (const w of words) {
      if (req.signal?.aborted) throw new Error("llm request aborted");
      buf += w;
      if (buf.length >= 24 || w === words[words.length - 1]) {
        onChunk(buf);
        buf = "";
      }
    }
    if (buf) onChunk(buf);
    return { text, model: "local-ai", latencyMs: Date.now() - t0 };
  }

  private compose(prompt: string, _fast: boolean): string {
    const q = this.questionOf(prompt);
    const screen = this.sectionOf(prompt, "SCREEN CONTEXT");
    let out = `Local answer to "${q}":\n1) Direct response from your verified experience.\n2) Key reasoning in plain spoken language.`;
    if (screen) out += `\n3) On-screen specifics addressed: ${screen.slice(0, 200)}${screen.length > 200 ? "…" : ""}`;
    out += `\nClose with a concise summary. (Offline local fallback — connect Gemini or OpenRouter for richer cloud answers.)`;
    return out;
  }

  private questionOf(prompt: string): string {
    const m = prompt.match(/CURRENT QUESTION\s*\n([\s\S]*?)(?:\n\n|\n[A-Z][A-Z ]+\n|$)/);
    const line = (m?.[1] || "").trim().split("\n")[0].trim();
    return line || "the interviewer's question";
  }

  private sectionOf(prompt: string, name: string): string {
    const re = new RegExp(name + "\\s*\\n([\\s\\S]*?)(?:\\n\\n[A-Z][A-Z /]+\\n|$)");
    const m = prompt.match(re);
    return (m?.[1] || "").trim();
  }
}

/** Classify provider failures for fallback decisions (values never logged). */
export function isAbortError(e: unknown): boolean {
  const s = String((e as Error)?.message || e || "").toLowerCase();
  return s.includes("aborted") || s.includes("abort");
}

export function isAuthError(e: unknown): boolean {
  const s = String((e as Error)?.message || e || "");
  return /401|403|invalid api key|unauthorized|forbidden|missing .*api.?key|api key/i.test(s);
}

export function isRateLimitError(e: unknown): boolean {
  const s = String((e as Error)?.message || e || "");
  return /429|rate.?limit|quota|too many requests/i.test(s);
}

export function isModelUnavailableError(e: unknown): boolean {
  const s = String((e as Error)?.message || e || "");
  return /404|model .*not (found|available)|model_unavailable|unknown model/i.test(s);
}

/** Every non-abort failure falls back; aborts (user cancel) never do. */
export function shouldFallbackOnError(e: unknown): boolean {
  return !isAbortError(e);
}

/** Redacted one-line provider failure summary (never includes key material). */
export function redactProviderError(e: unknown): string {
  const s = String((e as Error)?.message || e || "provider failure").slice(0, 300);
  return s
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/AIza[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/xox[A-Za-z0-9-]+/g, "[redacted]");
}

export function createLLMProvider(kind?: string, role: "fast" | "strong" = "fast", model?: string): LLMProvider {
  const k = ((kind || process.env.INTERVIA_LLM_PROVIDER || "mock") as string).toLowerCase();
  const cleanModel = (m: unknown): string | undefined => {
    const s = String(m || "").trim().slice(0, 200);
    return s ? s : undefined;
  };
  switch (k) {
    case "gemini-free":
      return new GeminiFreeProvider({ model: cleanModel(model) });
    case "gemini":
      return new GeminiLLMProvider({
        model: cleanModel(model) || (role === "fast" ? process.env.INTERVIA_LLM_FAST_MODEL : process.env.INTERVIA_LLM_STRONG_MODEL),
      });
    case "minimax":
      return new MiniMaxLLMProvider({
        model: cleanModel(model) || (role === "fast" ? process.env.INTERVIA_MINIMAX_FAST_MODEL : process.env.INTERVIA_MINIMAX_STRONG_MODEL),
      });
    case "openrouter-free":
      return new OpenRouterFreeProvider({ model: cleanModel(model) });
    case "openai-compatible":
    case "openai":
    case "openrouter":
      return new OpenAICompatibleLLMProvider({
        model: cleanModel(model) || (role === "fast" ? process.env.INTERVIA_LLM_FAST_MODEL : process.env.INTERVIA_LLM_STRONG_MODEL),
      });
    case "local":
    case "local-ai":
      return new LocalAIProvider();
    case "mock":
      return new MockLLMProvider(role);
    default:
      logger.warn("Unknown LLM provider, defaulting to mock", k);
      return new MockLLMProvider(role);
  }
}

export function llmKindOf(p: LLMProvider): LLMProviderKind {
  if (p instanceof OpenRouterFreeProvider) return "openrouter";
  if (p instanceof LocalAIProvider) return "local";
  if (p instanceof GeminiFreeProvider) return "gemini";
  if (p instanceof MiniMaxLLMProvider) return "minimax";
  if (p instanceof GeminiLLMProvider) return "gemini";
  if (p instanceof OpenAICompatibleLLMProvider) return "openai-compatible";
  return "mock";
}
