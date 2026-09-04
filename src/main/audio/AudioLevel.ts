/**
 * AudioLevel — canonical audio-level math shared by the main process,
 * diagnostics, and (by mirrored formula, see settings.js) the Setup UI.
 *
 * - Levels are normalized 0..1 (0 = silence, 1 = full scale).
 * - dB values are dBFS clamped to [DB_FLOOR_DB, 0].
 * - Silence / zero / NaN / Infinity NEVER produce -Infinity or NaN:
 *   they map to DB_FLOOR_DB (-60 dB).
 *
 * No raw audio is stored here — only ephemeral scalar levels.
 * This module is pure (no Electron imports) so plain-Node verify
 * scripts can require the compiled output directly.
 */

import { AudioSource } from "../../common/types";

export const DB_FLOOR_DB = -60;
export const DB_CEIL_DB = 0;

/** Reference amplitude that maps exactly to DB_FLOOR_DB (20*log10(0.001) = -60). */
const FLOOR_AMPLITUDE = 0.001;

/** Clamp any value into 0..1; non-finite input maps to 0 (silence). */
export function clampLevel(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Convert a normalized level (0..1) to dBFS in [DB_FLOOR_DB, DB_CEIL_DB].
 * Logarithmic curve: silence -> -60 dB, full scale -> 0 dB.
 * Never returns -Infinity or NaN for any input.
 */
export function levelToDb(level: unknown): number {
  const n = Number(level);
  if (!Number.isFinite(n) || n <= 0) return DB_FLOOR_DB;
  const clamped = Math.max(FLOOR_AMPLITUDE, Math.min(1, n));
  const db = 20 * Math.log10(clamped);
  if (!Number.isFinite(db)) return DB_FLOOR_DB;
  return Math.max(DB_FLOOR_DB, Math.min(DB_CEIL_DB, db));
}

/** Alias kept for readability at call sites dealing with raw RMS. */
export function rmsToDb(rms: unknown): number {
  return levelToDb(rms);
}

/** Format a dB value for compact UI display, e.g. "-18 dB". Always finite. */
export function formatDb(db: unknown): string {
  const n = Number(db);
  const safe = Number.isFinite(n)
    ? Math.max(DB_FLOOR_DB, Math.min(DB_CEIL_DB, Math.round(n)))
    : DB_FLOOR_DB;
  return `${safe} dB`;
}

/**
 * Ephemeral per-source level event broadcast from main to UI renderers
 * over the EXISTING "intervia:audio:level" channel (capture renderer sends
 * { source, level } up; main re-broadcasts this enriched event down).
 * Distinguishes the meter source explicitly ("microphone" | "system").
 */
export interface AudioLevelEvent {
  source: AudioSource;
  /** Normalized input level 0..1. */
  level: number;
  /** dBFS in [-60, 0]; never -Infinity/NaN. */
  db: number;
  /** Peak normalized level observed since the last resetLevels(). */
  peak: number;
  /** Consecutive level reports seen for this source (frames-arriving proxy). */
  chunks: number;
  timestamp: number;
}

export function makeLevelEvent(
  source: AudioSource,
  level: number,
  peak: number,
  chunks: number,
  timestamp?: number
): AudioLevelEvent {
  const lv = clampLevel(level);
  const pk = clampLevel(Math.max(peak, lv));
  return {
    source,
    level: lv,
    db: levelToDb(lv),
    peak: pk,
    chunks: Math.max(0, Math.floor(Number(chunks) || 0)),
    timestamp: Number(timestamp) > 0 ? Number(timestamp) : Date.now(),
  };
}

/** Validate an inbound level event (renderer/main boundary guard). */
export function isValidLevelEvent(e: unknown): e is AudioLevelEvent {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  if (o.source !== "microphone" && o.source !== "system") return false;
  return Number.isFinite(Number(o.level)) && Number.isFinite(Number(o.db));
}
