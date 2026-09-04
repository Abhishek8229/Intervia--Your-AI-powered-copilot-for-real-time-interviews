/**
 * FreeTierConfig — single place for the 3-tier FREE answer-routing constants.
 *
 * MODEL ID IS CONFIGURATION. PROVIDER ROUTING IS PRODUCT LOGIC.
 * The Gemini model id lives here (plus env overrides) so a future model
 * swap never requires rewriting the application.
 *
 * Tier order (authoritative):
 *   1. Gemini Free (primary cloud)
 *   2. OpenRouter Free (backup cloud, free routes only)
 *   3. Local AI (final offline fallback)
 *
 * No paid provider is ever required and no paid model is ever selected
 * silently — the router only uses the free models configured here.
 */

export const PRIMARY_GEMINI_MODEL_DEFAULT = "gemini-2.5-flash";

export const OPENROUTER_FREE_MODEL_DEFAULT = "openrouter/auto";

export const OPENROUTER_ENDPOINT_DEFAULT = "https://openrouter.ai/api/v1";

export const GEMINI_ENDPOINT_DEFAULT = "https://generativelanguage.googleapis.com";

/** Per-tier generation budget (a dead tier falls back quickly, never hangs). */
export const FREE_TIER_TIMEOUT_MS_DEFAULT = 25000;

function cleanId(v: unknown, max = 200): string {
  return String(v || "").trim().slice(0, max);
}

/** Primary Gemini model: explicit config wins, then env, then default. */
export function resolvePrimaryGeminiModel(explicit?: unknown): string {
  const e = cleanId(explicit);
  if (e) return e;
  const env =
    cleanId(process.env.INTERVIA_GEMINI_MODEL) ||
    cleanId(process.env.INTERVIA_GEMINI_FREE_MODEL) ||
    cleanId(process.env.INTERVIA_LLM_FAST_MODEL);
  if (env) return env;
  return PRIMARY_GEMINI_MODEL_DEFAULT;
}

/** OpenRouter free route: explicit config wins, then env, then default. */
export function resolveOpenRouterFreeModel(explicit?: unknown): string {
  const e = cleanId(explicit);
  if (e) return e;
  const env = cleanId(process.env.INTERVIA_OPENROUTER_MODEL);
  if (env) return env;
  return OPENROUTER_FREE_MODEL_DEFAULT;
}

export function resolveOpenRouterEndpoint(explicit?: unknown): string {
  const e = cleanId(explicit);
  if (e) return e.replace(/\/+$/, "");
  const env = cleanId(process.env.INTERVIA_OPENROUTER_ENDPOINT);
  if (env) return env.replace(/\/+$/, "");
  return OPENROUTER_ENDPOINT_DEFAULT;
}

export function resolveFreeTierTimeoutMs(explicit?: unknown): number {
  const n = Number(explicit ?? process.env.INTERVIA_FREE_TIER_TIMEOUT_MS ?? process.env.INTERVIA_LLM_TIMEOUT_MS ?? FREE_TIER_TIMEOUT_MS_DEFAULT);
  return Number.isFinite(n) && n > 1000 && n < 120000 ? Math.floor(n) : FREE_TIER_TIMEOUT_MS_DEFAULT;
}

/** Compact display labels for the overlay / setup UI (no diagnostics noise). */
export function tierDisplayLabel(tier: string): string {
  const t = String(tier || "").toLowerCase();
  if (t.includes("gemini")) return "Gemini";
  if (t.includes("openrouter")) return "OpenRouter Free";
  if (t.includes("local")) return "Local AI";
  return tier || "AI";
}

export const FREE_TIER_ORDER = ["gemini-free", "openrouter-free", "local"] as const;
export type FreeTierName = (typeof FREE_TIER_ORDER)[number];
