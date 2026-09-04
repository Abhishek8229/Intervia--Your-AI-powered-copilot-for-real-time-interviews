/**
 * Lightweight screen change detection (Phase 3).
 *
 * Goal: avoid running OCR/vision on every frame. Frames are compared with a
 * cheap fingerprint first (exact bytes) and — for raw RGBA frames — with a
 * perceptual average-hash so minor noise (cursor blink, clock tick, video
 * compression shimmer) does not trigger expensive processing.
 *
 * This module is intentionally pure (no Electron dependency) so it can be
 * unit-tested deterministically in plain Node.
 */

import { ScreenFrame, ScreenRegion } from "../../common/screen-types";

export interface FrameComparison {
  changed: boolean;
  /** 0 = identical; larger = more different. Meaning depends on `reason`. */
  score: number;
  reason:
    | "first-frame"
    | "exact-match"
    | "dimension-change"
    | "encoding-change"
    | "hash-within-tolerance"
    | "hash-exceeded"
    | "bytes-differ";
}

export interface CompareOptions {
  /** Max Hamming distance (bits) of the 64-bit aHash still treated as noise. */
  hashThresholdBits?: number;
}

const DEFAULT_THRESHOLD_BITS = 6;

/** FNV-1a 32-bit hash over arbitrary bytes. Fast, dependency-free. */
export function fnv1a32(data: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable fingerprint string for a frame (dimensions + encoding + content). */
export function frameFingerprint(frame: Pick<ScreenFrame, "width" | "height" | "encoding" | "data">): string {
  const h = fnv1a32(frame.data);
  return `${frame.width}x${frame.height}:${frame.encoding}:${h.toString(16)}`;
}

/**
 * 64-bit average hash (aHash) over raw RGBA bytes.
 * Downsamples to 8x8 grayscale by area-averaging, then sets a bit per cell
 * above the mean. Returns the hash as a bigint for exact Hamming math.
 */
export function averageHashRgba(data: Uint8Array, width: number, height: number): bigint {
  const cells = new Float64Array(64);
  const cw = Math.max(1, width / 8);
  const ch = Math.max(1, height / 8);
  let total = 0;
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      const x0 = Math.floor(cx * cw);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((cx + 1) * cw)));
      const y0 = Math.floor(cy * ch);
      const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((cy + 1) * ch)));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * width + x) * 4;
          if (o + 2 >= data.length) continue;
          // Rec. 601 luma from RGBA.
          sum += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
          n++;
        }
      }
      const mean = n > 0 ? sum / n : 0;
      cells[cy * 8 + cx] = mean;
      total += mean;
    }
  }
  const globalMean = total / 64;
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if (cells[i] > globalMean) hash |= 1n << BigInt(i);
  }
  return hash;
}

/** Hamming distance between two 64-bit hashes. */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x !== 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export function compareFrames(
  prev: Pick<ScreenFrame, "width" | "height" | "encoding" | "data"> | null,
  curr: Pick<ScreenFrame, "width" | "height" | "encoding" | "data">,
  opts?: CompareOptions
): FrameComparison {
  if (!prev) return { changed: true, score: 64, reason: "first-frame" };
  if (prev.width !== curr.width || prev.height !== curr.height) {
    return { changed: true, score: 64, reason: "dimension-change" };
  }
  if (prev.encoding !== curr.encoding) {
    return { changed: true, score: 64, reason: "encoding-change" };
  }
  if (byteEqual(prev.data, curr.data)) {
    return { changed: false, score: 0, reason: "exact-match" };
  }
  // Same dimensions, bytes differ: use perceptual hash when we have raw pixels.
  if (curr.encoding === "rgba" && prev.encoding === "rgba") {
    const threshold = opts?.hashThresholdBits ?? DEFAULT_THRESHOLD_BITS;
    const ha = averageHashRgba(prev.data, prev.width, prev.height);
    const hb = averageHashRgba(curr.data, curr.width, curr.height);
    const dist = hammingDistance(ha, hb);
    if (dist <= threshold) {
      return { changed: false, score: dist, reason: "hash-within-tolerance" };
    }
    return { changed: true, score: dist, reason: "hash-exceeded" };
  }
  // Encoded (PNG) frames cannot be perceptually compared without a decoder;
  // differing bytes mean "changed". Captures are downscaled thumbnails so this
  // stays cheap, and dedup downstream still suppresses identical OCR text.
  return { changed: true, score: 1, reason: "bytes-differ" };
}

function byteEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Stateful tracker: feed frames, get changed/unchanged decisions. */
export class ScreenChangeTracker {
  private last: Pick<ScreenFrame, "width" | "height" | "encoding" | "data"> | null = null;
  private thresholdBits: number;

  constructor(opts?: CompareOptions) {
    this.thresholdBits = opts?.hashThresholdBits ?? DEFAULT_THRESHOLD_BITS;
  }

  update(frame: Pick<ScreenFrame, "width" | "height" | "encoding" | "data">): FrameComparison {
    const cmp = compareFrames(this.last, frame, { hashThresholdBits: this.thresholdBits });
    this.last = frame;
    return cmp;
  }

  reset(): void {
    this.last = null;
  }

  hasBaseline(): boolean {
    return this.last !== null;
  }
}

// ---------------------------------------------------------------------------
// Overlay-exclusion helpers (privacy rule: the Intervia overlay must never
// become screen-context input).
// Primary mechanism is OS-level: the overlay window carries
// WDA_EXCLUDEFROMCAPTURE, so compliant capture APIs never include its pixels.
// These helpers are belt-and-braces for the RGBA path and region validation.
// ---------------------------------------------------------------------------

export function regionsOverlap(a: ScreenRegion, b: ScreenRegion): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Zero-out (blacken) excluded rectangles inside a raw RGBA frame, in place.
 * Used when overlay bounds are known and the capture path could not exclude
 * the window at OS level.
 */
export function blankExcludedRegions(
  data: Uint8Array,
  width: number,
  height: number,
  excluded: ScreenRegion[]
): void {
  for (const r of excluded) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(width, Math.ceil(r.x + r.width));
    const y1 = Math.min(height, Math.ceil(r.y + r.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * width + x) * 4;
        if (o + 3 >= data.length) continue;
        data[o] = 0;
        data[o + 1] = 0;
        data[o + 2] = 0;
        data[o + 3] = 255;
      }
    }
  }
}

/** Validate a manually selected region against screen bounds. Pure. */
export function validateRegion(
  region: ScreenRegion,
  bounds: { width: number; height: number },
  minSize = 8
): { ok: boolean; reason: string; normalized?: ScreenRegion } {
  const x = Math.floor(region.x);
  const y = Math.floor(region.y);
  const w = Math.floor(region.width);
  const h = Math.floor(region.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return { ok: false, reason: "non-numeric-region" };
  }
  if (w < minSize || h < minSize) return { ok: false, reason: "region-too-small" };
  if (x < 0 || y < 0 || x + w > bounds.width || y + h > bounds.height) {
    return { ok: false, reason: "region-out-of-bounds" };
  }
  return { ok: true, reason: "ok", normalized: { x, y, width: w, height: h } };
}
