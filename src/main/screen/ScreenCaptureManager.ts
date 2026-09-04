/**
 * Screen capture abstraction (Phases 1-2).
 *
 * - Decoupled from OCR/vision: returns in-memory ScreenFrame objects only.
 * - Frames are kept in memory; nothing is written to disk.
 * - Supports primary-display capture, window capture, region capture, and
 *   interval-based monitoring with lightweight change detection.
 * - Overlay exclusion: the Intervia overlay carries WDA_EXCLUDEFROMCAPTURE at
 *   OS level (see native/captureExclusion), so compliant capture APIs never
 *   include it. On top of that this manager (a) filters Intervia sources out
 *   of window lists and (b) tracks known overlay bounds for region checks.
 *
 * Electron is loaded lazily so this module imports safely in plain Node
 * (tests / headless): all capture methods then fail cleanly with a
 * ScreenCaptureError(code="unsupported") instead of crashing.
 */

import { EventEmitter } from "events";
import { ScreenFrame, ScreenRegion } from "../../common/screen-types";
import { ScreenChangeTracker, FrameComparison } from "./ChangeDetector";
import { logger } from "../logger";

let __frameCounter = 0;
function nextFrameId(): string {
  __frameCounter += 1;
  return `frm-${Date.now().toString(36)}-${__frameCounter.toString(36)}`;
}

export type ScreenCaptureErrorCode =
  | "unsupported"
  | "no-source"
  | "invalid-region"
  | "cancelled"
  | "failed";

export class ScreenCaptureError extends Error {
  code: ScreenCaptureErrorCode;
  constructor(code: ScreenCaptureErrorCode, message: string) {
    super(message);
    this.name = "ScreenCaptureError";
    this.code = code;
  }
}

export interface CaptureSourceInfo {
  id: string;
  name: string;
  kind: "display" | "window";
}

export interface ScreenCaptureManagerOptions {
  monitorIntervalMs?: number;
  downscaleWidth?: number;
  hashThresholdBits?: number;
}

export interface MonitoredFrame {
  frame: ScreenFrame;
  comparison: FrameComparison;
}

export interface DisplayDescriptor {
  id: number;
  /** Bounds in DIP (CSS pixels): origin + size as the OS reports them. */
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  /** Physical pixel size (bounds * scaleFactor). Thumbnails are downscaled from this. */
  physicalSize: { width: number; height: number };
}

export interface DipRegionMapping {
  displayId: number;
  scaleFactor: number;
  /** Region converted to physical pixels on the target display. */
  physical: ScreenRegion;
}

/**
 * Convert a DIP (CSS-pixel) screen-space region to physical pixels on the
 * given display. Windows desktop coordinates differ from screenshot pixels by
 * scaleFactor: NEVER assume 1 CSS pixel = 1 physical pixel.
 */
export function dipToPhysicalRegion(
  dip: ScreenRegion,
  display: { id: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number }
): DipRegionMapping {
  const sf = Number(display.scaleFactor) > 0 ? Number(display.scaleFactor) : 1;
  const physical: ScreenRegion = {
    x: Math.floor((dip.x - display.bounds.x) * sf),
    y: Math.floor((dip.y - display.bounds.y) * sf),
    width: Math.max(1, Math.floor(dip.width * sf)),
    height: Math.max(1, Math.floor(dip.height * sf)),
  };
  return { displayId: display.id, scaleFactor: sf, physical };
}

/** Validate a physical-pixel region against a physical-pixel display size. Pure. */
export function validatePhysicalRegion(
  physical: ScreenRegion,
  physicalSize: { width: number; height: number },
  minSize = 8
): { ok: boolean; reason: string; clamped?: ScreenRegion } {
  if (!Number.isFinite(physical.x) || !Number.isFinite(physical.y) ||
      !Number.isFinite(physical.width) || !Number.isFinite(physical.height)) {
    return { ok: false, reason: "non-numeric-region" };
  }
  if (physical.width < minSize || physical.height < minSize) {
    return { ok: false, reason: "region-too-small" };
  }
  const x = Math.max(0, Math.min(physical.x, physicalSize.width - 1));
  const y = Math.max(0, Math.min(physical.y, physicalSize.height - 1));
  const width = Math.max(1, Math.min(physical.width, physicalSize.width - x));
  const height = Math.max(1, Math.min(physical.height, physicalSize.height - y));
  if (x !== physical.x || y !== physical.y || width !== physical.width || height !== physical.height) {
    return { ok: false, reason: "region-out-of-bounds" };
  }
  return { ok: true, reason: "ok", clamped: { x, y, width, height } };
}

/** Sanitize a capturer source name for diagnostics (no internal details). */
export function sanitizeCaptureSourceName(name: string): string {
  return String(name || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120) || "(unnamed source)";
}

const DEFAULTS = {
  monitorIntervalMs: 2500,
  downscaleWidth: 480,
  hashThresholdBits: 6,
};

function loadElectron(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("electron");
  } catch {
    return null;
  }
}

export class ScreenCaptureManager extends EventEmitter {
  private opts: Required<ScreenCaptureManagerOptions>;
  private tracker = new ScreenChangeTracker();
  private monitorTimer: NodeJS.Timeout | null = null;
  private monitorInFlight = false;
  private cancelled = false;
  private overlayBounds: ScreenRegion[] = [];
  private electronChecked = false;
  private electronAvailable = false;

  constructor(opts?: ScreenCaptureManagerOptions) {
    super();
    this.opts = { ...DEFAULTS, ...(opts || {}) };
    this.tracker = new ScreenChangeTracker({ hashThresholdBits: this.opts.hashThresholdBits });
  }

  /** True when running inside Electron with desktopCapturer available. */
  isSupported(): boolean {
    if (!this.electronChecked) {
      this.electronChecked = true;
      const e = loadElectron();
      this.electronAvailable = !!(e && e.desktopCapturer);
    }
    return this.electronAvailable;
  }

  /** Known Intervia overlay bounds (display pixels) kept out of analysis. */
  setExcludedRegions(regions: ScreenRegion[]): void {
    this.overlayBounds = (regions || []).filter(
      (r) => Number.isFinite(r.x) && Number.isFinite(r.y) && r.width > 0 && r.height > 0
    );
  }

  getExcludedRegions(): ScreenRegion[] {
    return [...this.overlayBounds];
  }

  /** Invalidate in-flight captures (visual job cancellation support). */
  cancelPending(): void {
    this.cancelled = true;
    // Re-arm on next tick so future captures work; in-flight ones throw "cancelled".
    setImmediate(() => {
      this.cancelled = false;
    });
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new ScreenCaptureError("cancelled", "capture cancelled");
  }

  async listSources(): Promise<CaptureSourceInfo[]> {
    const electron = loadElectron();
    if (!electron || !electron.desktopCapturer) {
      throw new ScreenCaptureError("unsupported", "screen capture not supported in this environment");
    }
    try {
      const sources: any[] = await electron.desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 64, height: 64 },
      });
      return sources
        .filter((s) => !/intervia/i.test(s.name || ""))
        .map((s) => ({
          id: String(s.id),
          name: sanitizeCaptureSourceName(String(s.name || s.id)),
          kind: String(s.id).startsWith("window:") ? ("window" as const) : ("display" as const),
        }));
    } catch (e) {
      throw new ScreenCaptureError("failed", "listSources failed: " + String(e));
    }
  }

  /**
   * Physical display descriptors (DIP bounds + scaleFactor + physical size).
   * Headless-safe: returns [] outside Electron.
   */
  getDisplays(): DisplayDescriptor[] {
    try {
      const electron = loadElectron();
      const scr = electron?.screen;
      if (!scr || typeof scr.getAllDisplays !== "function") return [];
      return scr.getAllDisplays().map((d: any) => {
        const bounds = {
          x: Math.floor(Number(d.bounds?.x) || 0),
          y: Math.floor(Number(d.bounds?.y) || 0),
          width: Math.floor(Number(d.bounds?.width) || 0),
          height: Math.floor(Number(d.bounds?.height) || 0),
        };
        const scaleFactor = Number(d.scaleFactor) > 0 ? Number(d.scaleFactor) : 1;
        return {
          id: Number(d.id),
          bounds,
          scaleFactor,
          physicalSize: {
            width: Math.floor(bounds.width * scaleFactor),
            height: Math.floor(bounds.height * scaleFactor),
          },
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Developer diagnostic: capture one frame and report metadata only
   * (resolution + byte size + non-zero-content check). Never logs pixels.
   */
  async captureRawFrame(): Promise<{
    ok: boolean;
    sourceId?: string;
    sourceName?: string;
    width?: number;
    height?: number;
    bytes?: number;
    nonEmpty?: boolean;
    error?: string;
  }> {
    try {
      const frame = await this.capturePrimaryDisplay();
      const bytes = frame.data?.length || 0;
      return {
        ok: bytes > 0 && frame.width > 0 && frame.height > 0,
        sourceId: frame.source?.id,
        sourceName: sanitizeCaptureSourceName(frame.source?.name || ""),
        width: frame.width,
        height: frame.height,
        bytes,
        nonEmpty: bytes > 0 && hasNonZeroByte(frame.data),
      };
    } catch (e) {
      const code = e instanceof ScreenCaptureError ? e.code : "failed";
      return { ok: false, error: `${code}: ${String((e as Error)?.message || e).slice(0, 300)}` };
    }
  }

  async capturePrimaryDisplay(): Promise<ScreenFrame> {
    this.throwIfCancelled();
    const electron = loadElectron();
    if (!electron || !electron.desktopCapturer) {
      throw new ScreenCaptureError("unsupported", "screen capture not supported in this environment");
    }
    try {
      const w = this.opts.downscaleWidth;
      const sources: any[] = await electron.desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: w, height: Math.max(1, Math.round((w * 9) / 16)) },
      });
      this.throwIfCancelled();
      if (!sources || sources.length === 0) {
        throw new ScreenCaptureError("no-source", "no display sources available");
      }
      // Same preference as capturePrimaryDisplay (multi-monitor consistency).
      const src = pickDisplaySource(sources);
      const thumb = src.thumbnail;
      const size = thumb.getSize();
      const png: Buffer = thumb.toPNG();
      this.throwIfCancelled();
      return {
        id: nextFrameId(),
        width: size.width,
        height: size.height,
        data: png,
        encoding: "png",
        timestamp: Date.now(),
        source: { kind: "display", id: String(src.id), name: String(src.name || "") },
      };
    } catch (e) {
      if (e instanceof ScreenCaptureError) throw e;
      throw new ScreenCaptureError("failed", "capturePrimaryDisplay failed: " + String(e));
    }
  }

  async captureWindow(sourceId: string): Promise<ScreenFrame> {
    this.throwIfCancelled();
    if (!sourceId) throw new ScreenCaptureError("invalid-region", "missing window source id");
    const electron = loadElectron();
    if (!electron || !electron.desktopCapturer) {
      throw new ScreenCaptureError("unsupported", "screen capture not supported in this environment");
    }
    try {
      const w = this.opts.downscaleWidth;
      const sources: any[] = await electron.desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: w * 2, height: w },
      });
      this.throwIfCancelled();
      const src = sources.find((s) => String(s.id) === sourceId && !/intervia/i.test(s.name || ""));
      if (!src) throw new ScreenCaptureError("no-source", "window source not found (or is the Intervia overlay)");
      const thumb = src.thumbnail;
      if (thumb.isEmpty()) throw new ScreenCaptureError("no-source", "window thumbnail is empty (minimized?)");
      const size = thumb.getSize();
      const png: Buffer = thumb.toPNG();
      this.throwIfCancelled();
      return {
        id: nextFrameId(),
        width: size.width,
        height: size.height,
        data: png,
        encoding: "png",
        timestamp: Date.now(),
        source: { kind: "window", id: String(src.id), name: String(src.name || "") },
      };
    } catch (e) {
      if (e instanceof ScreenCaptureError) throw e;
      throw new ScreenCaptureError("failed", "captureWindow failed: " + String(e));
    }
  }

  /**
   * Capture a region given in DIP screen coordinates (the coordinate space of
   * the region selector: clientX + window offset). The region is mapped onto
   * the physical pixels of the containing display via its scaleFactor, then
   * scaled onto the downscaled thumbnail before cropping. Never assumes
   * 1 CSS pixel = 1 physical pixel.
   */
  async captureRegion(region: ScreenRegion): Promise<ScreenFrame> {
    this.throwIfCancelled();
    const r = normalizeRegion(region);
    if (!r) throw new ScreenCaptureError("invalid-region", "invalid capture region");
    const electron = loadElectron();
    if (!electron || !electron.desktopCapturer) {
      throw new ScreenCaptureError("unsupported", "screen capture not supported in this environment");
    }
    try {
      const w = Math.max(this.opts.downscaleWidth, Math.ceil(r.width * 2));
      const sources: any[] = await electron.desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: w, height: Math.max(1, Math.round((w * 9) / 16)) },
      });
      this.throwIfCancelled();
      if (!sources || sources.length === 0) {
        throw new ScreenCaptureError("no-source", "no display sources available");
      }
      const src = pickDisplaySource(sources);
      const thumb = src.thumbnail;
      const size = thumb.getSize();
      // Map DIP region -> physical pixels on the containing display, then
      // physical -> thumbnail pixels. Falls back to proportional mapping when
      // display metrics are unavailable (headless/tests).
      const mapping = this.mapDipToThumbnail(r, size);
      const crop = {
        x: Math.max(0, Math.min(mapping.x, size.width - 1)),
        y: Math.max(0, Math.min(mapping.y, size.height - 1)),
        width: Math.max(1, Math.min(mapping.width, size.width - Math.max(0, Math.min(mapping.x, size.width - 1)))),
        height: Math.max(1, Math.min(mapping.height, size.height - Math.max(0, Math.min(mapping.y, size.height - 1)))),
      };
      const cropped = thumb.crop(crop);
      const png: Buffer = cropped.toPNG();
      if (!png || png.length === 0) {
        throw new ScreenCaptureError("failed", "region crop produced zero bytes");
      }
      this.throwIfCancelled();
      return {
        id: nextFrameId(),
        width: crop.width,
        height: crop.height,
        data: png,
        encoding: "png",
        timestamp: Date.now(),
        source: { kind: "display", id: String(src.id), name: String(src.name || "") },
        region: { ...r },
      };
    } catch (e) {
      if (e instanceof ScreenCaptureError) throw e;
      throw new ScreenCaptureError("failed", "captureRegion failed: " + String(e));
    }
  }

  /**
   * MODE A — automatic monitoring. Polls the primary display and emits a
   * "frame" event per tick with a change verdict; unchanged frames can be
   * skipped by the consumer without running OCR/vision.
   */
  startMonitoring(onFrame?: (m: MonitoredFrame) => void): void {
    if (this.monitorTimer) return;
    if (onFrame) this.on("frame", onFrame);
    this.tracker.reset();
    this.monitorTimer = setInterval(() => {
      void this.pollOnce();
    }, this.opts.monitorIntervalMs);
    if (typeof (this.monitorTimer as any).unref === "function") {
      (this.monitorTimer as any).unref();
    }
    logger.info("Screen monitoring started", { intervalMs: this.opts.monitorIntervalMs });
  }

  stopMonitoring(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.monitorInFlight = false;
    this.removeAllListeners("frame");
    logger.info("Screen monitoring stopped");
  }

  isMonitoring(): boolean {
    return this.monitorTimer !== null;
  }

  /**
   * Map a DIP screen-space region onto thumbnail pixels.
   * Finds the display containing the region origin, converts DIP to physical
   * pixels via its scaleFactor, validates against the physical display size,
   * then scales to the thumbnail. Falls back to proportional mapping when
   * display metrics are unavailable (headless/tests).
   */
  private mapDipToThumbnail(
    dip: ScreenRegion,
    thumbSize: { width: number; height: number }
  ): { x: number; y: number; width: number; height: number; displayId: number; scaleFactor: number } {
    const displays = this.getDisplays();
    const cx = dip.x + dip.width / 2;
    const cy = dip.y + dip.height / 2;
    const disp =
      displays.find(
        (d) => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height
      ) || displays[0];
    if (!disp || disp.physicalSize.width <= 0 || disp.physicalSize.height <= 0) {
      // Headless fallback: assume the thumbnail covers the DIP space directly.
      return { x: Math.floor(dip.x), y: Math.floor(dip.y), width: Math.floor(dip.width), height: Math.floor(dip.height), displayId: 0, scaleFactor: 1 };
    }
    const mapping = dipToPhysicalRegion(dip, disp);
    const check = validatePhysicalRegion(mapping.physical, disp.physicalSize);
    const phys = check.ok && check.clamped ? check.clamped : clampPhysical(mapping.physical, disp.physicalSize);
    const scaleX = thumbSize.width / disp.physicalSize.width;
    const scaleY = thumbSize.height / disp.physicalSize.height;
    return {
      x: Math.floor(phys.x * scaleX),
      y: Math.floor(phys.y * scaleY),
      width: Math.max(1, Math.floor(phys.width * scaleX)),
      height: Math.max(1, Math.floor(phys.height * scaleY)),
      displayId: mapping.displayId,
      scaleFactor: mapping.scaleFactor,
    };
  }

  private async pollOnce(): Promise<void> {
    if (this.monitorInFlight) return;
    this.monitorInFlight = true;
    try {
      const frame = await this.capturePrimaryDisplay();
      const comparison = this.tracker.update(frame);
      this.emit("frame", { frame, comparison } as MonitoredFrame);
    } catch (e) {
      // Headless / unsupported environments poll quietly; surface real errors.
      if (e instanceof ScreenCaptureError && (e.code === "unsupported" || e.code === "cancelled")) {
        // no-op
      } else {
        logger.warn("Screen monitor poll failed", String(e));
      }
    } finally {
      this.monitorInFlight = false;
    }
  }

  dispose(): void {
    this.stopMonitoring();
    this.removeAllListeners();
  }
}

/**
 * Deterministic display-source pick shared by capturePrimaryDisplay and
 * captureRegion so both agree on multi-monitor machines. Prefers an explicit
 * primary/Screen-1 source, then any full-screen source, then the first
 * source. NEVER random, NEVER a blind "source 0" without the preference pass.
 */
function pickDisplaySource(sources: any[]): any {
  const picked =
    sources.find((s) => /screen\s*1\b|primary|main|^display\s*1\b/i.test(s.name || "")) ||
    sources.find((s) => /screen|display|entire/i.test(s.name || "")) ||
    sources[0];
  try {
    logger.info("screen source selected", { name: sanitizeCaptureSourceName(String(picked?.name || "")) });
  } catch {
    // ignore
  }
  return picked;
}

function normalizeRegion(r: ScreenRegion): ScreenRegion | null {  if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.width) || !Number.isFinite(r.height)) {
    return null;
  }
  const width = Math.floor(r.width);
  const height = Math.floor(r.height);
  if (width <= 0 || height <= 0) return null;
  return { x: Math.floor(r.x), y: Math.floor(r.y), width, height };
}

/** Clamp a physical region inside a physical display size (never throws). */
function clampPhysical(r: ScreenRegion, size: { width: number; height: number }): ScreenRegion {
  const x = Math.max(0, Math.min(Math.floor(r.x), Math.max(0, size.width - 1)));
  const y = Math.max(0, Math.min(Math.floor(r.y), Math.max(0, size.height - 1)));
  const width = Math.max(1, Math.min(Math.floor(r.width), Math.max(1, size.width - x)));
  const height = Math.max(1, Math.min(Math.floor(r.height), Math.max(1, size.height - y)));
  return { x, y, width, height };
}

/** True when a buffer contains at least one non-zero byte (content check). */
export function hasNonZeroByte(data: Buffer | Uint8Array | undefined | null): boolean {
  if (!data || data.length === 0) return false;
  const step = Math.max(1, Math.floor(data.length / 4096));
  for (let i = 0; i < data.length; i += step) {
    if (data[i] !== 0) return true;
  }
  return false;
}
