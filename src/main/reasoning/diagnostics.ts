/**
 * Lightweight provider diagnostics (Phase 24). Reports per provider:
 * provider, model, configured (key/model present), reachable (lightweight
 * probe when configured), streaming support. Never exposes secrets.
 */

import { LLMProvider } from "./LLMProvider";

export interface ProviderDiagnostic {
  provider: string;
  model: string;
  /** Credentials/model configured (no network call). */
  configured: boolean;
  /** Lightweight reachability probe result (false when unconfigured). */
  reachable: boolean;
  streaming: "supported" | "unsupported" | "unknown";
  note?: string;
}

export interface DiagnosableProvider extends LLMProvider {
  getEndpoint?(): string;
  getModel?(): string;
}

/** Describe without probing (no network). Secrets never included. */
export function describeProvider(provider: LLMProvider, model?: string): ProviderDiagnostic {
  let configured = false;
  try {
    configured = provider.isAvailable() as boolean;
  } catch {
    configured = false;
  }
  return {
    provider: provider.name,
    model: model || "",
    configured,
    reachable: false,
    streaming: typeof provider.generateStream === "function" ? "supported" : (provider.name.startsWith("mock") ? "unsupported" : "unknown"),
    note: configured ? undefined : "not configured (missing key/endpoint/model)",
  };
}

/**
 * Diagnose a set of providers. When `probe` is true, configured remote
 * providers get one lightweight HTTP probe each (bounded timeout).
 * Default is no network (probe=false) for deterministic offline use.
 */
export async function diagnoseProviders(
  providers: Array<{ provider: LLMProvider; model?: string; role: string }>,
  opts?: { probe?: boolean; timeoutMs?: number }
): Promise<ProviderDiagnostic[]> {
  const out: ProviderDiagnostic[] = [];
  for (const p of providers) {
    const d = describeProvider(p.provider, p.model);
    if (opts?.probe && d.configured && !p.provider.name.startsWith("mock")) {
      d.reachable = await probeLlm(p.provider, opts.timeoutMs ?? 8000);
      d.note = d.reachable ? "probe ok" : "probe failed (network/endpoint/key?)";
    } else if (p.provider.name.startsWith("mock")) {
      d.reachable = true;
      d.note = "local mock (offline)";
    }
    out.push({ ...d, provider: `${p.role}:${d.provider}` });
  }
  return out;
}

async function probeLlm(provider: LLMProvider, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Minimal generation probe; providers throw quickly on bad transport.
    await provider.generate({ prompt: "Reply with: ok", maxTokens: 8, signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Redacted diagnostics export (physical-validation support).
// Contains versions, provider/config NAMES, subsystem states, error messages,
// and timing aggregates. NEVER: API keys, raw audio, screenshots, resume
// text, or interview content.
// ---------------------------------------------------------------------------

export interface DiagnosticsExportInput {
  appVersion: string;
  electron?: string;
  node?: string;
  platform: string;
  release: string;
  arch: string;
  exportedAt: number;
  providers: ProviderDiagnostic[];
  transcription: { providerName: string; status: string };
  audio: Record<string, { level: number; chunks: number; at: number }>;
  screen: { monitoring: boolean; ocr: string; tesseractInstalled: boolean; vision: string; visionMode: string };
  session: { status: string; questions: number; answers: number; avgFastMs: number; avgStrongMs: number };
  candidate: { profileName?: string; mode: string; jobTitle?: string };
  errors: Array<{ at: number; source: string; message: string }>;
  configNames: Record<string, string>;
}

const SECRET_KEYS = /(api[_-]?key|apikey|token|secret|password|auth|bearer|session[_-]?key)/i;

export function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(k)) {
        out[k] = typeof v === "string" && v.length > 0 ? "[redacted]" : v;
      } else if (typeof v === "string" && /^(sk-|gsk_|xox|AIza|MM-)[A-Za-z0-9_-]{6,}/.test(v)) {
        out[k] = "[redacted]";
      } else {
        out[k] = stripSecrets(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** Honest one-line mode label for the diagnostics UI (never claims mock is real). */
export function providerModeLabel(providerName: string, model?: string): string {
  const n = String(providerName || "").toLowerCase();
  const m = model ? ` (${model})` : "";
  if (n.includes("mock")) return `MOCK${m}`;
  if (n.includes("local-ai") || n === "local" || n.includes("free-fallback")) return `LOCAL${m}`;
  if (n.includes("openrouter-free") || n.includes("openrouter")) return `REAL OPENROUTER-FREE${m}`;
  if (n.includes("gemini-free") || n.includes("gemini")) return `REAL GEMINI${m}`;
  if (n.includes("minimax")) return `REAL MINIMAX${m}`;
  if (n.includes("groq")) return `REAL GROQ${m}`;
  if (n.includes("whisper")) return `REAL WHISPER${m}`;
  if (n.includes("openai")) return `REAL OPENAI-COMPATIBLE${m}`;
  if (!n || n === "unknown" || n === "none") return "NOT CONFIGURED";
  return `REAL ${String(providerName).toUpperCase()}${m}`;
}
/** Build the export document; always runs stripSecrets as a final guard. */
export function buildDiagnosticsExport(input: DiagnosticsExportInput): string {
  const doc = {
    kind: "intervia-diagnostics",
    ...input,
    notes: "Keys, audio, screenshots, resume text, and interview content are never included.",
  };
  return JSON.stringify(stripSecrets(doc), null, 2);
}
