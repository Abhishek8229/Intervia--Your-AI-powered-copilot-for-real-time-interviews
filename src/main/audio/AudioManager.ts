import { BrowserWindow, session, ipcMain, desktopCapturer } from "electron";
import * as path from "path";
import { config } from "../config";
import { logger } from "../logger";
import { AudioSource } from "../../common/types";
import { levelToDb, clampLevel, makeLevelEvent } from "./AudioLevel";

export type AudioChunkHandler = (source: AudioSource, pcm: Int16Array, sampleRate: number) => void;

/** Per-source stats pushed by the capture renderer (no raw audio ever). */
export interface RendererSourceStats {
  source: string;
  permission: string;
  deviceLabel: string;
  streamActive: boolean;
  trackReadyState: string;
  trackMuted: boolean | null;
  trackEnabled: boolean | null;
  trackEnded: boolean;
  sampleRate: number;
  channelCount: number;
  chunks: number;
  bytes: number;
  peakRms: number;
  /** RMS of the most recent captured frame (0 when the tap is silent). */
  lastRms: number;
  /** dBFS of the most recent captured frame (floor -60). */
  lastDb: number;
  ctxState: string;
  lastError: string;
  receiving: boolean;
  updatedAt: number;
}

export type AudioProbeState = "READY" | "STREAM CREATED" | "FRAMES RECEIVING" | "NO FRAMES" | "ERROR";

/**
 * Pure classifier shared by the probe and the diagnostics UI.
 * A MediaStream existing is NOT success — only received frames count.
 */
export function classifyAudioProbe(input: {
  streamCreated: boolean;
  rendererChunks: number;
  mainChunks: number;
  trackEnded: boolean;
  lastError: string;
}): { state: AudioProbeState; receiving: boolean } {
  const frames = input.rendererChunks + input.mainChunks;
  // An ended device is ERROR even if frames arrived earlier: present-tense
  // "RECEIVING" would lie about a dead track (unplug must surface).
  if (input.trackEnded) return { state: "ERROR", receiving: false };
  if (frames > 0) return { state: "FRAMES RECEIVING", receiving: true };
  if (input.lastError) return { state: "ERROR", receiving: false };
  if (input.streamCreated) return { state: "STREAM CREATED", receiving: false };
  return { state: "NO FRAMES", receiving: false };
}

/** Sanitized desktop-source descriptor (no internal handles/URLs). */
export interface DesktopSourceDescriptor {
  id: string;
  name: string;
  kind: "display" | "window";
}

/** Deterministic display-source pick shared by audio + diagnostics. */
export function pickSystemSource(sources: Array<{ id: string; name: string }>): { id: string; name: string } | null {
  if (!sources || sources.length === 0) return null;
  const screens = sources.filter((s) => String(s.id || "").startsWith("screen:"));
  const pool = screens.length > 0 ? screens : sources;
  const preferred =
    pool.find((s) => /screen\s*1\b|primary|main|display\s*1\b/i.test(String(s.name || ""))) ||
    pool.find((s) => /screen|display|entire/i.test(String(s.name || ""))) ||
    pool[0];
  return preferred ? { id: String(preferred.id), name: String(preferred.name || preferred.id) } : null;
}

export function sanitizeSourceName(name: string): string {
  return String(name || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120) || "(unnamed source)";
}

interface CaptureWindowState {
  window: BrowserWindow | null;
  started: boolean;
  micEnabled: boolean;
  systemEnabled: boolean;
  handler: AudioChunkHandler | null;
  sourceSampleRate: number;
}

export class AudioManager {
  private state: CaptureWindowState = {
    window: null,
    started: false,
    micEnabled: false,
    systemEnabled: false,
    handler: null,
    sourceSampleRate: 48000,
  };
  /**
   * Last reported per-source input levels (for diagnostics + Setup live
   * meters). Ephemeral scalars only — no raw audio is ever stored here.
   */
  private levels: Partial<
    Record<AudioSource, { level: number; db: number; peak: number; chunks: number; at: number }>
  > = {};
  /** Latest per-source renderer stats (pushed, never polled for audio data). */
  private rendererStats: Partial<Record<AudioSource, RendererSourceStats>> = {};
  private errorHandler: ((source: AudioSource, message: string) => void) | null = null;

  /** Optional sink for capture errors (device lost, permission denied...). */
  setErrorHandler(cb: ((source: AudioSource, message: string) => void) | null): void {
    this.errorHandler = cb;
  }

  /**
   * Optional sink for renderer-enumerated device lists. AudioManager never
   * interprets them — it forwards to the AudioDeviceManager owned by main.
   */
  private deviceListHandler: ((devices: Array<{ id: string; label: string; kind: "input" | "output"; isDefault?: boolean }>, fromDeviceChange: boolean) => void) | null = null;

  setDeviceListHandler(
    cb: ((devices: Array<{ id: string; label: string; kind: "input" | "output"; isDefault?: boolean }>, fromDeviceChange: boolean) => void) | null
  ): void {
    this.deviceListHandler = cb;
  }

  private ipcRegistered = false;
  private permissionsRegistered = false;

  /**
   * Electron denies getUserMedia by default. Without this handler both the
   * microphone and the desktop-loopback system source fail with
   * NotAllowedError on a real machine. Grant audio/media capture only; deny
   * everything else. Grants + denials are logged (type + verdict only).
   */
  private registerMediaPermissions(): void {
    if (this.permissionsRegistered) return;
    this.permissionsRegistered = true;
    try {
      session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details: any) => {
        try {
          const perm = String(permission);
          const mediaType: string = String(details?.mediaType || details?.mediaTypes || "");
          const grant =
            perm === "media" ||
            perm === "microphone" ||
            perm === "audioCapture";
          logger.info("media permission request", { permission: perm, mediaType, granted: grant });
          if (!grant) {
            try {
              this.errorHandler?.("microphone", `permission denied: ${perm}`);
            } catch {
              // ignore
            }
          }
          callback(grant);
        } catch {
          try { callback(false); } catch { /* ignore */ }
        }
      });
      if (typeof (session.defaultSession as any).setPermissionCheckHandler === "function") {
        (session.defaultSession as any).setPermissionCheckHandler(
          (_wc: unknown, permission: string) => {
            const perm = String(permission);
            return perm === "media" || perm === "microphone" || perm === "audioCapture";
          }
        );
      }
    } catch (e) {
      logger.warn("media permission handler setup failed", e);
    }
  }

  start(
    handler: AudioChunkHandler,
    opts: { mic: boolean; system: boolean; micDeviceId?: string | null; systemOutputLabel?: string }
  ): void {
    if (this.state.started) {
      logger.warn("AudioManager already started");
      return;
    }
    this.state.handler = handler;
    this.state.micEnabled = opts.mic;
    this.state.systemEnabled = opts.system;
    this.rendererStats = {};
    this.registerMediaPermissions();

    const win = new BrowserWindow({
      width: 320,
      height: 200,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, "..", "..", "preload", "audio-capture-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    win.removeMenu();

    // For any future getDisplayMedia-based flow: resolve loopback audio plus
    // the actual screen source as video (never `video: false`).
    session.defaultSession.setDisplayMediaRequestHandler(
      (_req, cb) => {
        void (async (): Promise<void> => {
          try {
            const sources = await desktopCapturer.getSources({ types: ["screen"], fetchWindowIcons: false });
            const picked = pickSystemSource(sources.map((s) => ({ id: s.id, name: s.name })));
            const match = picked ? sources.find((s) => s.id === picked.id) : sources[0];
            if (match) {
              cb({ video: match, audio: "loopback" } as any);
            } else {
              cb({} as any);
            }
          } catch (e) {
            logger.warn("display-media source resolve failed", String(e));
            try { cb({} as any); } catch { /* ignore */ }
          }
        })();
      },
      { useSystemPicker: false }
    );

    const indexHtml = path.join(__dirname, "..", "..", "renderer", "audio-capture.html");
    // Honor mic/system flags: the renderer used to always start both sources.
    // The selected mic deviceId (if any) travels as a query param; the
    // selected OUTPUT label is reporting-only (loopback captures the system
    // mix — see AudioDeviceManager.LOOPBACK_NOTE).
    const query: Record<string, string> = {
      mic: opts.mic ? "1" : "0",
      system: opts.system ? "1" : "0",
    };
    if (opts.micDeviceId) query.micDevice = String(opts.micDeviceId).slice(0, 512);
    if (opts.systemOutputLabel) query.sysOutput = String(opts.systemOutputLabel).slice(0, 120);
    win.loadFile(indexHtml, { query }).catch((e) => logger.error("loadFile failed", e));

    this.state.window = win;
    this.state.started = true;
    this.registerIpc();
    logger.info("AudioManager started", { mic: opts.mic, system: opts.system });
  }

  stop(): void {
    if (!this.state.started) return;
    try {
      this.state.window?.destroy();
    } catch (e) {
      logger.warn("window destroy error", e);
    }
    this.state.window = null;
    this.state.started = false;
    this.state.micEnabled = false;
    this.state.systemEnabled = false;
    this.state.handler = null;
    logger.info("AudioManager stopped");
  }

  isRunning(): boolean {
    return this.state.started;
  }

  /** Ask the hidden capture window to push fresh stats (best-effort). */
  queryRendererStats(): void {
    try {
      this.state.window?.webContents.send("intervia:audio:query-stats");
    } catch {
      // ignore (window may be gone)
    }
  }

  getRendererStats(): Partial<Record<AudioSource, RendererSourceStats>> {
    const out: Partial<Record<AudioSource, RendererSourceStats>> = {};
    for (const k of Object.keys(this.rendererStats) as AudioSource[]) {
      const v = this.rendererStats[k];
      if (v) out[k] = { ...v };
    }
    return out;
  }

  /** Sanitized desktop sources for diagnostics (id + name + kind only). */
  async listDesktopSources(): Promise<DesktopSourceDescriptor[]> {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"], fetchWindowIcons: false });
      return sources.map((s) => ({
        id: String(s.id),
        name: sanitizeSourceName(String(s.name || s.id)),
        kind: String(s.id).startsWith("window:") ? ("window" as const) : ("display" as const),
      }));
    } catch (e) {
      logger.warn("desktopCapturer list failed", String(e));
      return [];
    }
  }

  private registerIpc(): void {
    if (this.ipcRegistered) return;
    ipcMain.on("intervia:audio:chunk", (_evt, payload: {
      source: AudioSource;
      buffer: ArrayBuffer;
      sampleRate: number;
      channels: number;
    }) => {
      const handler = this.state.handler;
      if (!handler) return;
      try {
        const pcm = new Int16Array(payload.buffer);
        handler(payload.source, pcm, payload.sampleRate);
      } catch (e) {
        logger.error("audio chunk handler failed", e);
      }
    });

    ipcMain.on("intervia:audio:source-sample-rate", (_evt, sr: number) => {
      if (Number.isFinite(sr) && sr > 0) {
        this.state.sourceSampleRate = sr;
        logger.info("capture source sample rate", sr);
      }
    });

    ipcMain.on("intervia:audio:devices", (_evt, payload: unknown) => {
      try {
        const list = Array.isArray(payload) ? payload : [];
        const clean = list
          .filter((d) => d && typeof d === "object")
          .map((d: any) => ({
            id: String(d.id || "").slice(0, 512),
            label: String(d.label || "").slice(0, 120),
            kind: d.kind === "output" ? ("output" as const) : ("input" as const),
            isDefault: !!d.isDefault,
          }))
          .filter((d) => d.id.length > 0);
        this.deviceListHandler?.(clean, false);
      } catch (e) {
        logger.warn("audio device list ingest failed", String(e));
      }
    });

    ipcMain.on("intervia:audio:device-change", (_evt, payload: unknown) => {
      try {
        const list = Array.isArray(payload) ? payload : [];
        const clean = list
          .filter((d) => d && typeof d === "object")
          .map((d: any) => ({
            id: String(d.id || "").slice(0, 512),
            label: String(d.label || "").slice(0, 120),
            kind: d.kind === "output" ? ("output" as const) : ("input" as const),
            isDefault: !!d.isDefault,
          }))
          .filter((d) => d.id.length > 0);
        this.deviceListHandler?.(clean, true);
      } catch (e) {
        logger.warn("audio device-change ingest failed", String(e));
      }
    });

    ipcMain.on("intervia:audio:stats", (_evt, payload: Record<string, RendererSourceStats>) => {
      try {
        for (const k of ["microphone", "system"] as AudioSource[]) {
          const s = (payload || {})[k];
          if (s && typeof s === "object") {
            this.rendererStats[k] = {
              source: k,
              permission: String((s as any).permission || "unknown").slice(0, 64),
              deviceLabel: String((s as any).deviceLabel || "").slice(0, 120),
              streamActive: !!(s as any).streamActive,
              trackReadyState: String((s as any).trackReadyState || "none").slice(0, 32),
              trackMuted: (s as any).trackMuted ?? null,
              trackEnabled: (s as any).trackEnabled ?? null,
              trackEnded: !!(s as any).trackEnded,
              sampleRate: Number((s as any).sampleRate) || 0,
              channelCount: Number((s as any).channelCount) || 0,
              chunks: Number((s as any).chunks) || 0,
              bytes: Number((s as any).bytes) || 0,
              peakRms: Number((s as any).peakRms) || 0,
              lastRms: Number((s as any).lastRms) || 0,
              lastDb: Number.isFinite(Number((s as any).lastDb)) ? Number((s as any).lastDb) : -60,
              ctxState: String((s as any).ctxState || "none").slice(0, 32),
              lastError: String((s as any).lastError || "").slice(0, 500),
              receiving: !!(s as any).receiving || (Number((s as any).chunks) || 0) > 0,
              updatedAt: Number((s as any).updatedAt) || Date.now(),
            };
          }
        }
      } catch (e) {
        logger.warn("audio stats ingest failed", String(e));
      }
    });

    ipcMain.on("intervia:audio:error", (_evt, payload: { source: AudioSource; message: string }) => {
      logger.warn("audio capture error", payload);
      try {
        this.errorHandler?.(payload.source, String(payload.message || "unknown audio error"));
      } catch {
        // ignore
      }
    });

    // Capture renderer -> main level reports (existing channel). Main stores
    // the scalar and re-broadcasts an enriched event on the SAME channel to
    // UI renderers (Setup meters, diagnostics) — no duplicate capture
    // stream, no polling loop opening the microphone, no raw audio stored.
    ipcMain.on("intervia:audio:level", (_evt, payload: { source: AudioSource; level: number }) => {
      try {
        const source = payload?.source;
        if (source !== "microphone" && source !== "system") return;
        const prev = this.levels[source];
        const level = clampLevel(payload.level);
        const peak = clampLevel(Math.max(prev?.peak || 0, level));
        const chunks = (prev?.chunks || 0) + 1;
        const at = Date.now();
        this.levels[source] = { level, db: levelToDb(level), peak, chunks, at };
        this.broadcastLevel(source);
      } catch (e) {
        logger.warn("audio level ingest failed", String(e));
      }
    });

    ipcMain.handle("intervia:audio:request-system-source", async () => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen"], fetchWindowIcons: false });
        const picked = pickSystemSource(sources.map((s) => ({ id: s.id, name: s.name })));
        if (picked) {
          logger.info("system-audio source selected", { name: sanitizeSourceName(picked.name) });
          return { id: picked.id, name: sanitizeSourceName(picked.name) };
        }
        return null;
      } catch (e) {
        logger.warn("desktopCapturer failed", e);
        return null;
      }
    });

    this.ipcRegistered = true;
  }

  getSourceSampleRate(): number {
    return this.state.sourceSampleRate;
  }

  /**
   * Re-broadcast the latest level for one source to every UI window on the
   * existing "intervia:audio:level" channel. Best-effort: never throws, and
   * no-ops outside Electron (plain-Node verify scripts).
   */
  private broadcastLevel(source: AudioSource): void {
    try {
      const cur = this.levels[source];
      if (!cur) return;
      const evt = makeLevelEvent(source, cur.level, cur.peak, cur.chunks, cur.at);
      const wins: Array<{ webContents?: { send?: (ch: string, ...a: unknown[]) => void } }> =
        typeof (BrowserWindow as unknown) !== "undefined" && BrowserWindow
          ? (BrowserWindow.getAllWindows() as Array<{
              webContents?: { send?: (ch: string, ...a: unknown[]) => void };
            }>)
          : [];
      for (const w of wins) {
        try {
          w?.webContents?.send?.("intervia:audio:level", evt);
        } catch {
          // per-window failure must not break capture or other windows
        }
      }
    } catch {
      // broadcast is best-effort; level snapshot above is still available
    }
  }

  /**
   * Snapshot of last reported input levels (0..1 + dB + peak) + chunk
   * counters. Shape is backward compatible (level/chunks/at kept).
   */
  getLevels(): Record<string, { level: number; db: number; peak: number; chunks: number; at: number }> {
    const out: Record<string, { level: number; db: number; peak: number; chunks: number; at: number }> = {};
    for (const k of Object.keys(this.levels) as AudioSource[]) {
      const v = this.levels[k];
      if (v) out[k] = { ...v };
    }
    return out;
  }

  resetLevels(): void {
    this.levels = {};
  }
}
