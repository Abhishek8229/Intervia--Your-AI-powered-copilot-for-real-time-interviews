/**
 * ProviderConfig — user-facing LLM/STT/vision configuration (product Setup UI).
 *
 * Non-secret configuration (provider names, models, vision mode) lives in
 * `provider-config.json` next to the other local stores. API keys live in a
 * SEPARATE local-only `provider-keys.json` so they can never leak through
 * diagnostics exports, logs, or status payloads (every outward surface is
 * presence-only: `keysPresent: { gemini: true }`, never values).
 *
 * Stored keys fill process.env gaps at boot (explicit environment always
 * wins). Nothing here ever leaves the machine.
 */

import { JsonFileStorage } from "../candidates/stores";
import { OPENROUTER_FREE_MODEL_DEFAULT, PRIMARY_GEMINI_MODEL_DEFAULT } from "./FreeTierConfig";

export type LlmProviderName = "mock" | "gemini" | "minimax" | "openai-compatible" | "openai" | "openrouter" | "gemini-free" | "openrouter-free" | "local" | "local-ai";
export type SttProviderName = "whisper-server" | "groq";
export type VisionModeName = "local" | "remote" | "disabled";

const LLM_NAMES: LlmProviderName[] = ["mock", "gemini", "minimax", "openai-compatible", "openai", "openrouter", "gemini-free", "openrouter-free", "local", "local-ai"];
const STT_NAMES: SttProviderName[] = ["whisper-server", "groq"];
const VISION_NAMES: VisionModeName[] = ["local", "remote", "disabled"];

export interface ProviderConfigState {
  fastProvider: string;
  fastModel: string;
  strongProvider: string;
  strongModel: string;
  sttProvider: string;
  visionMode: VisionModeName;
  /** 3-tier FREE answer configuration (normal Setup UI). */
  geminiModel: string;
  openRouterModel: string;
  localEnabled: boolean;
}

export interface ProviderKeys {
  gemini?: string;
  minimax?: string;
  groq?: string;
  openaiKey?: string;
  openaiEndpoint?: string;
  openrouter?: string;
}

const CONFIG_FILE = "provider-config.json";
const KEYS_FILE = "provider-keys.json";

function cleanModel(m: unknown): string {
  return String(m || "").trim().slice(0, 200);
}

function cleanLlm(p: unknown, fallback: string): string {
  const v = String(p || "").trim().toLowerCase();
  return (LLM_NAMES as string[]).includes(v) ? v : fallback;
}

function cleanStt(p: unknown): SttProviderName {
  const v = String(p || "").trim().toLowerCase();
  return (STT_NAMES as string[]).includes(v) ? (v as SttProviderName) : "whisper-server";
}

function cleanVision(p: unknown): VisionModeName {
  const v = String(p || "").trim().toLowerCase();
  return (VISION_NAMES as string[]).includes(v) ? (v as VisionModeName) : "local";
}

function cleanBool(p: unknown, fallback: boolean): boolean {
  if (p === undefined || p === null || p === "") return fallback;
  if (typeof p === "boolean") return p;
  const v = String(p).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

function cleanFreeModel(p: unknown, fallback: string): string {
  const s = cleanModel(p);
  return s || fallback;
}

export function sanitizeProviderConfig(raw: unknown): ProviderConfigState {
  const o = (raw || {}) as Record<string, unknown>;
  const fastProvider = cleanLlm(o.fastProvider, "mock");
  const fastModel = cleanModel(o.fastModel);
  const strongProvider = cleanLlm(o.strongProvider, "mock");
  const strongModel = cleanModel(o.strongModel);
  // 3-tier fields with safe migration from legacy gemini/openrouter settings.
  // Explicit new fields win; otherwise inherit a legacy model when that
  // legacy provider already pointed at the same cloud; else use the free default.
  let geminiModel = cleanModel((o as Record<string, unknown>).geminiModel);
  if (!geminiModel) {
    if (fastProvider === "gemini" || fastProvider === "gemini-free") geminiModel = fastModel;
    else if (strongProvider === "gemini" || strongProvider === "gemini-free") geminiModel = strongModel;
  }
  if (!geminiModel) {
    geminiModel =
      cleanModel(process.env.INTERVIA_GEMINI_MODEL) ||
      cleanModel(process.env.INTERVIA_GEMINI_FREE_MODEL) ||
      PRIMARY_GEMINI_MODEL_DEFAULT;
  }
  let openRouterModel = cleanModel((o as Record<string, unknown>).openRouterModel);
  if (!openRouterModel) {
    const legacyOpen = (v: string): boolean => v === "openrouter" || v === "openrouter-free" || v === "openai" || v === "openai-compatible";
    if (legacyOpen(fastProvider) && fastModel) openRouterModel = fastModel;
    else if (legacyOpen(strongProvider) && strongModel) openRouterModel = strongModel;
  }
  if (!openRouterModel) {
    openRouterModel = cleanModel(process.env.INTERVIA_OPENROUTER_MODEL) || OPENROUTER_FREE_MODEL_DEFAULT;
  }
  const localRaw = (o as Record<string, unknown>).localEnabled;
  const localEnabled = cleanBool(localRaw, true);
  return {
    fastProvider,
    fastModel,
    strongProvider,
    strongModel,
    sttProvider: cleanStt(o.sttProvider),
    visionMode: cleanVision(o.visionMode),
    geminiModel: cleanFreeModel(geminiModel, PRIMARY_GEMINI_MODEL_DEFAULT),
    openRouterModel: cleanFreeModel(openRouterModel, OPENROUTER_FREE_MODEL_DEFAULT),
    localEnabled,
  };
}

export function sanitizeProviderKeys(raw: unknown): ProviderKeys {
  const o = (raw || {}) as Record<string, unknown>;
  const pick = (v: unknown): string | undefined => {
    const s = String(v || "").trim().slice(0, 500);
    return s ? s : undefined;
  };
  const out: ProviderKeys = {};
  const gemini = pick(o.gemini);
  const minimax = pick(o.minimax);
  const groq = pick(o.groq);
  const openaiKey = pick(o.openaiKey);
  const openaiEndpoint = pick(o.openaiEndpoint);
  const openrouter = pick(o.openrouter ?? (o as Record<string, unknown>).openRouter ?? (o as Record<string, unknown>).openrouterKey);
  if (gemini) out.gemini = gemini;
  if (minimax) out.minimax = minimax;
  if (groq) out.groq = groq;
  if (openaiKey) out.openaiKey = openaiKey;
  if (openaiEndpoint) out.openaiEndpoint = openaiEndpoint;
  if (openrouter) out.openrouter = openrouter;
  return out;
}

export function loadProviderConfig(storage: JsonFileStorage): ProviderConfigState {
  try {
    return sanitizeProviderConfig(storage.read<unknown>(CONFIG_FILE, null));
  } catch {
    return sanitizeProviderConfig(null);
  }
}

export function saveProviderConfig(storage: JsonFileStorage, cfg: unknown): ProviderConfigState {
  const clean = sanitizeProviderConfig(cfg);
  storage.write(CONFIG_FILE, clean);
  return clean;
}

export function loadProviderKeys(storage: JsonFileStorage): ProviderKeys {
  try {
    return sanitizeProviderKeys(storage.read<unknown>(KEYS_FILE, null));
  } catch {
    return {};
  }
}

export function saveProviderKeys(storage: JsonFileStorage, keys: unknown): { saved: Array<"gemini" | "minimax" | "groq" | "openai" | "openrouter"> } {
  // Merge: blank UI fields must KEEP the previously saved key (there is no
  // key-removal UI; values are never sent back to the renderer).
  const clean = sanitizeProviderKeys(keys);
  const merged: ProviderKeys = { ...loadProviderKeys(storage), ...clean };
  storage.write(KEYS_FILE, merged);
  applyKeysToEnv(merged);
  // Newly entered keys are explicit user intent: they override values that
  // an earlier boot may have copied into the environment (gap-fill only
  // applies to keys the user did NOT just type).
  try {
    if (clean.gemini) process.env.INTERVIA_GEMINI_API_KEY = clean.gemini;
    if (clean.minimax) process.env.INTERVIA_MINIMAX_API_KEY = clean.minimax;
    if (clean.groq) process.env.INTERVIA_GROQ_API_KEY = clean.groq;
    if (clean.openaiKey) process.env.INTERVIA_LLM_API_KEY = clean.openaiKey;
    if (clean.openaiEndpoint) process.env.INTERVIA_LLM_ENDPOINT = clean.openaiEndpoint;
    if (clean.openrouter) process.env.INTERVIA_OPENROUTER_API_KEY = clean.openrouter;
  } catch {
    // ignore
  }
  const saved: Array<"gemini" | "minimax" | "groq" | "openai" | "openrouter"> = [];
  if (clean.gemini) saved.push("gemini");
  if (clean.minimax) saved.push("minimax");
  if (clean.groq) saved.push("groq");
  if (clean.openaiKey) saved.push("openai");
  if (clean.openrouter) saved.push("openrouter");
  return { saved };
}

/** Presence-only key report (safe for UI/diagnostics). */
export function keysPresent(keys: ProviderKeys): Record<"gemini" | "minimax" | "groq" | "openai" | "openrouter", boolean> {
  return {
    gemini: !!(keys.gemini || process.env.INTERVIA_GEMINI_API_KEY || process.env.INTERVIA_LLM_API_KEY),
    minimax: !!(keys.minimax || process.env.INTERVIA_MINIMAX_API_KEY),
    groq: !!(keys.groq || process.env.INTERVIA_GROQ_API_KEY),
    openai: !!(keys.openaiKey || process.env.INTERVIA_LLM_API_KEY),
    openrouter: !!(keys.openrouter || process.env.INTERVIA_OPENROUTER_API_KEY),
  };
}

/**
 * Fill process.env gaps from stored keys. Explicit environment always wins
 * (never overwritten). No logging of values — callers must only log presence.
 */
export function applyKeysToEnv(keys: ProviderKeys): void {
  try {
    const setIfUnset = (name: string, value: string | undefined): void => {
      if (value && !process.env[name]) process.env[name] = value;
    };
    setIfUnset("INTERVIA_GEMINI_API_KEY", keys.gemini);
    setIfUnset("INTERVIA_MINIMAX_API_KEY", keys.minimax);
    setIfUnset("INTERVIA_GROQ_API_KEY", keys.groq);
    setIfUnset("INTERVIA_LLM_API_KEY", keys.openaiKey);
    setIfUnset("INTERVIA_LLM_ENDPOINT", keys.openaiEndpoint);
    setIfUnset("INTERVIA_OPENROUTER_API_KEY", keys.openrouter);
  } catch {
    // env application never breaks boot
  }
}

/** Effective free-tier models (explicit config wins, else env, else default). */
export function effectiveGeminiModel(cfg: ProviderConfigState): string {
  return cleanFreeModel(cfg.geminiModel, PRIMARY_GEMINI_MODEL_DEFAULT);
}

export function effectiveOpenRouterModel(cfg: ProviderConfigState): string {
  return cleanFreeModel(cfg.openRouterModel, OPENROUTER_FREE_MODEL_DEFAULT);
}
