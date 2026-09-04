/**
 * FreeFallbackRouter — the single authoritative fallback decision-maker for
 * AI answer generation.
 *
 * Order (always tried fresh per question, never permanently downgraded):
 *   Gemini Free -> OpenRouter Free -> Local AI
 *
 * Behavior:
 * - Unconfigured tiers are skipped without network waits.
 * - First success wins; later tiers are never called unnecessarily.
 * - Invalid key / rate limit / network failure / timeout / malformed
 *   response / streaming interruption / model unavailable all fall back
 *   automatically. Caller aborts are rethrown with no fallback.
 * - Streaming fallback: a tier that fails before emitting anything falls
 *   through to the next tier's stream; a tier that fails mid-stream keeps
 *   the partial text and the next tier completes the remainder.
 * - No paid provider is ever consulted.
 */

import { LLMProvider, LLMRequest, LLMResult, redactProviderError, shouldFallbackOnError } from "./LLMProvider";
import { FreeTierName } from "./FreeTierConfig";
import { logger } from "../logger";

export interface FallbackTier {
  tier: FreeTierName;
  provider: LLMProvider;
}

export interface FreeFallbackRouterOptions {
  tiers: FallbackTier[];
  label?: string;
}

function tierPrefix(tier: FreeTierName, model: string): string {
  return `${tier}:${model}`;
}

export class FreeFallbackRouter implements LLMProvider {
  readonly name: string;
  private tiers: FallbackTier[];
  private lastTier: FreeTierName | null = null;
  private lastModel: string = "";
  private fallbackCount = 0;

  constructor(opts: FreeFallbackRouterOptions) {
    this.tiers = (opts?.tiers || []).filter((t) => t && t.provider);
    this.name = opts?.label || "free-fallback-router";
  }

  /** Replace tiers at runtime (Setup save applies without restart). */
  setTiers(tiers: FallbackTier[]): void {
    const clean = (tiers || []).filter((t) => t && t.provider);
    if (clean.length > 0) this.tiers = clean;
  }

  getLastTier(): FreeTierName | null {
    return this.lastTier;
  }

  getLastModel(): string {
    return this.lastModel;
  }

  getFallbackCount(): number {
    return this.fallbackCount;
  }

  /** Tier readiness for the Setup UI (presence-only, never secrets). */
  tierStatus(): Array<{ tier: FreeTierName; ready: boolean; provider: string }> {
    return this.tiers.map((t) => {
      let ready = false;
      try {
        ready = !!t.provider.isAvailable();
      } catch {
        ready = false;
      }
      return { tier: t.tier, ready, provider: t.provider.name };
    });
  }

  isAvailable(): boolean {
    for (const t of this.tiers) {
      try {
        if (t.provider.isAvailable()) return true;
      } catch {
        // keep checking remaining tiers
      }
    }
    return false;
  }

  private availableTiers(): FallbackTier[] {
    const out: FallbackTier[] = [];
    for (const t of this.tiers) {
      try {
        if (t.provider.isAvailable()) out.push(t);
      } catch (e) {
        logger.warn(`FreeFallbackRouter tier check failed for ${t.tier}`, redactProviderError(e));
      }
    }
    return out;
  }

  async generate(req: LLMRequest): Promise<LLMResult> {
    if (req.signal?.aborted) throw new Error("llm request aborted");
    const candidates = this.availableTiers();
    if (candidates.length === 0) {
      throw new Error("no AI tier available (configure Gemini or OpenRouter, or enable Local AI)");
    }
    let lastError: unknown = null;
    for (let i = 0; i < candidates.length; i++) {
      const t = candidates[i];
      try {
        const r = await t.provider.generate(req);
        const text = (r.text || "").trim();
        if (!text) throw new Error(`${t.tier} returned no text`);
        this.lastTier = t.tier;
        this.lastModel = tierPrefix(t.tier, r.model || t.provider.name);
        if (i > 0) this.fallbackCount += 1;
        return { text, model: this.lastModel, latencyMs: r.latencyMs };
      } catch (e) {
        lastError = e;
        if (req.signal?.aborted || !shouldFallbackOnError(e)) throw e;
        logger.warn(`FreeFallbackRouter ${t.tier} failed, trying next tier`, redactProviderError(e));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("all AI tiers failed");
  }

  async generateStream(req: LLMRequest, onChunk: (delta: string) => void): Promise<LLMResult> {
    if (req.signal?.aborted) throw new Error("llm request aborted");
    const candidates = this.availableTiers();
    if (candidates.length === 0) {
      throw new Error("no AI tier available (configure Gemini or OpenRouter, or enable Local AI)");
    }
    let lastError: unknown = null;
    let accumulated = "";
    const emit = (delta: string): void => {
      if (!delta) return;
      accumulated += delta;
      onChunk(delta);
    };
    for (let i = 0; i < candidates.length; i++) {
      const t = candidates[i];
      const before = accumulated.length;
      try {
        if (typeof t.provider.generateStream === "function") {
          const r = await t.provider.generateStream(req, emit);
          // Some adapters resolve with full text but emit nothing; ensure
          // the overlay still receives the text progressively as one chunk.
          if (accumulated.length === before && (r.text || "").trim()) {
            emit((r.text || "").trim());
          }
          const text = accumulated.trim() || (r.text || "").trim();
          if (!text) throw new Error(`${t.tier} stream returned no text`);
          this.lastTier = t.tier;
          this.lastModel = tierPrefix(t.tier, r.model || t.provider.name);
          if (i > 0) this.fallbackCount += 1;
          return { text, model: this.lastModel, latencyMs: r.latencyMs };
        }
        const r = await t.provider.generate(req);
        const fresh = (r.text || "").trim();
        if (!fresh) throw new Error(`${t.tier} returned no text`);
        // Non-streaming tier after a partial: append only the unseen suffix
        // when the texts overlap, otherwise append the whole completion.
        if (before > 0) {
          emit(fresh.startsWith(accumulated) ? fresh.slice(accumulated.length) || "" : `\n${fresh}`);
          const text = accumulated.trim();
          this.lastTier = t.tier;
          this.lastModel = tierPrefix(t.tier, r.model || t.provider.name);
          if (i > 0) this.fallbackCount += 1;
          return { text, model: this.lastModel, latencyMs: r.latencyMs };
        }
        emit(fresh);
        this.lastTier = t.tier;
        this.lastModel = tierPrefix(t.tier, r.model || t.provider.name);
        if (i > 0) this.fallbackCount += 1;
        return { text: fresh, model: this.lastModel, latencyMs: r.latencyMs };
      } catch (e) {
        lastError = e;
        if (req.signal?.aborted || !shouldFallbackOnError(e)) throw e;
        logger.warn(`FreeFallbackRouter ${t.tier} stream failed, trying next tier`, redactProviderError(e));
        // Mid-stream failure with partial text already shown: keep the
        // partial and let the next tier complete the remainder.
        continue;
      }
    }
    // Every tier failed but partial text was already shown: keep it rather
    // than surfacing an empty failure to the interview.
    if (accumulated.trim()) {
      const tier = this.lastTier || candidates[candidates.length - 1]?.tier || "local";
      return { text: accumulated.trim(), model: tierPrefix(tier, "partial"), latencyMs: 0 };
    }
    throw lastError instanceof Error ? lastError : new Error("all AI tiers failed");
  }
}

/** Build the standard 3-tier stack from concrete providers (order fixed). */
export function buildFreeTiers(gemini: LLMProvider, openRouter: LLMProvider, local: LLMProvider): FallbackTier[] {
  return [
    { tier: "gemini-free", provider: gemini },
    { tier: "openrouter-free", provider: openRouter },
    { tier: "local", provider: local },
  ];
}
