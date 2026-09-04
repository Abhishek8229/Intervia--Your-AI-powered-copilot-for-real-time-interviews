/**
 * AudioDeviceManager — user-selectable audio devices, kept separate from
 * AudioManager (which only captures). Responsibilities:
 *
 * - listInputDevices() / listOutputDevices()  (from renderer enumeration)
 * - getDefaultInput() / getDefaultOutput()
 * - selectInputDevice(id) / selectOutputDevice(id)  (validated + persisted)
 * - refreshDevices()  (snapshot bookkeeping; enumeration itself is
 *   renderer-side via enumerateDevices — no extra permissions requested)
 * - handleDeviceChange()  (invalidate vanished selections, never crash)
 *
 * Device enumeration MUST happen in a renderer (navigator.mediaDevices).
 * This manager merges reported lists (keeping the best labels seen),
 * validates the persisted selection against them, and hands the resolved
 * configuration to AudioManager, which passes it to the capture renderer.
 *
 * SYSTEM-AUDIO LIMITATION (Electron 32.3.3 / Chromium desktop capture):
 * Windows loopback captures the system desktop mix — there is NO Chromium
 * API to retarget desktop-loopback capture at a specific render/output
 * device. Output-device selection is therefore listed, persisted, and shown
 * in diagnostics, but it does NOT change the loopback source. The UI must
 * say so honestly (see LOOPBACK_NOTE). Do not pretend otherwise.
 */

export type AudioDeviceKind = "input" | "output";

export interface AudioDeviceInfo {
  /** Stable renderer-provided deviceId (opaque; never logged in full). */
  id: string;
  /** Human-readable label, or "" when permission has not revealed labels yet. */
  label: string;
  kind: AudioDeviceKind;
  /** True for the OS "default"/"communications" pseudo-device, if reported. */
  isDefault: boolean;
}

/** Sentinel meaning "Windows/default device" (existing default behavior). */
export const DEFAULT_DEVICE_ID = "default";

export type DeviceAvailability = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";

export interface AudioDeviceState {
  inputs: AudioDeviceInfo[];
  outputs: AudioDeviceInfo[];
  selectedMicId: string;
  selectedOutputId: string;
  micLabel: string;
  outputLabel: string;
  micStatus: DeviceAvailability;
  outputStatus: DeviceAvailability;
  /** True once at least one renderer enumeration has been merged. */
  enumerated: boolean;
  snapshotAt: number;
}

export interface DeviceSelectionPersisted {
  selectedMicrophoneId?: string;
  selectedOutputDeviceId?: string;
}

export interface DeviceSelectionStore {
  load(): DeviceSelectionPersisted;
  save(sel: DeviceSelectionPersisted): void;
}

export const LOOPBACK_NOTE =
  "System-audio loopback captures the Windows desktop mix via Chromium desktop capture. " +
  "Electron 32 does not expose per-output-device loopback targeting, so the selected output " +
  "does NOT retarget capture — it is recorded for diagnostics. Capture = system mix.";

/**
 * Output-test tone report (Setup "Play" button). This verifies that the
 * SELECTED OUTPUT device can receive audio — it is NOT loopback capture and
 * says nothing about which device loopback records from (always the system
 * mix, see LOOPBACK_NOTE). Ephemeral diagnostics metadata only.
 */
export interface OutputTestReport {
  /** Short id of the targeted device ("(default)" for the Windows default). */
  deviceIdShort: string;
  /** How the tone was routed: "selected" | "default" | "default-fallback". */
  routed: string;
  /** True when the tone played to completion without a routing error. */
  ok: boolean;
  /** Controlled error string (e.g. DEVICE UNAVAILABLE), "" on success. */
  error: string;
  at: number;
}

function cleanId(id: unknown): string {
  return String(id || "").trim().slice(0, 512);
}

function cleanLabel(label: unknown): string {
  return String(label || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);
}

/** Truncated device id for UI/diagnostics (ids are opaque, keep them short). */
export function shortDeviceId(id: string): string {
  const s = cleanId(id);
  if (!s || s === DEFAULT_DEVICE_ID) return "(default)";
  if (s.length <= 16) return s;
  return s.slice(0, 8) + "…" + s.slice(-4);
}

export function sanitizeDeviceId(id: unknown): string {
  const s = cleanId(id);
  if (!s) return DEFAULT_DEVICE_ID;
  if (/^(default|communications)$/i.test(s)) return DEFAULT_DEVICE_ID;
  return s;
}

/** Display label with default-device indicator and unlabeled fallback. */
export function displayLabel(d: AudioDeviceInfo, index: number): string {
  const base = d.label || (d.kind === "input" ? `Microphone ${index + 1}` : `Output ${index + 1}`);
  return d.isDefault ? `${base} (default)` : base;
}

function isDefaultId(id: string): boolean {
  return !id || /^(default|communications)$/i.test(id);
}

export class AudioDeviceManager {
  private store: DeviceSelectionStore;
  private inputs: AudioDeviceInfo[] = [];
  private outputs: AudioDeviceInfo[] = [];
  /** Best-known label per device id (labels vanish when permission lapses). */
  private labelCache = new Map<string, string>();
  private selectedMicId = DEFAULT_DEVICE_ID;
  private selectedOutputId = DEFAULT_DEVICE_ID;
  private enumerated = false;
  private snapshotAt = 0;
  private onChange: ((state: AudioDeviceState) => void) | null = null;
  /** Bounded ephemeral history of output-test tone reports (diagnostics only). */
  private outputTests: OutputTestReport[] = [];

  constructor(store: DeviceSelectionStore) {
    this.store = store;
    try {
      const persisted = store.load() || {};
      this.selectedMicId = sanitizeDeviceId(persisted.selectedMicrophoneId);
      this.selectedOutputId = sanitizeDeviceId(persisted.selectedOutputDeviceId);
    } catch {
      this.selectedMicId = DEFAULT_DEVICE_ID;
      this.selectedOutputId = DEFAULT_DEVICE_ID;
    }
  }

  setChangeListener(cb: ((state: AudioDeviceState) => void) | null): void {
    this.onChange = cb;
  }

  private persist(): void {
    try {
      this.store.save({
        selectedMicrophoneId: this.selectedMicId,
        selectedOutputDeviceId: this.selectedOutputId,
      });
    } catch {
      // persistence is best-effort; selection still applies this session
    }
  }

  private emit(): void {
    try {
      this.onChange?.(this.getState());
    } catch {
      // never break capture on a listener failure
    }
  }

  /**
   * Merge a renderer-enumerated list. Keeps the best label seen per id
   * (labels are empty until mic permission has been granted at least once
   * in that renderer session — degrade gracefully, never request extra
   * permission just to list).
   *
   * Pass { replace: true } when the list is a fresh full enumeration
   * (devicechange): vanished ids are dropped so disappearance surfaces as
   * UNAVAILABLE instead of lingering forever.
   */
  updateDeviceList(
    devices: Array<{ id: string; label: string; kind: AudioDeviceKind; isDefault?: boolean }>,
    opts?: { replace?: boolean }
  ): AudioDeviceState {
    const build = (prev: AudioDeviceInfo[], kind: AudioDeviceKind): AudioDeviceInfo[] => {
      for (const d of prev) {
        if (d.label && (!this.labelCache.get(d.id) || (this.labelCache.get(d.id) || "").length < d.label.length)) {
          this.labelCache.set(d.id, d.label);
        }
      }
      if (opts?.replace) {
        const out: AudioDeviceInfo[] = [];
        for (const raw of devices || []) {
          if (!raw || raw.kind !== kind) continue;
          const id = cleanId(raw.id);
          if (!id || out.some((d) => d.id === id)) continue;
          const label = cleanLabel(raw.label) || this.labelCache.get(id) || "";
          if (label) this.labelCache.set(id, label);
          out.push({ id, label, kind, isDefault: !!raw.isDefault });
        }
        return out;
      }
      const byId = new Map<string, AudioDeviceInfo>();
      for (const d of prev) byId.set(d.id, { ...d });
      for (const raw of devices || []) {
        if (!raw || raw.kind !== kind) continue;
        const id = cleanId(raw.id);
        if (!id) continue;
        const label = cleanLabel(raw.label);
        const existing = byId.get(id);
        if (existing) {
          if (label && (!existing.label || existing.label.length < label.length)) existing.label = label;
          if (raw.isDefault) existing.isDefault = true;
        } else {
          byId.set(id, { id, label, kind, isDefault: !!raw.isDefault });
        }
      }
      return [...byId.values()];
    };
    this.inputs = build(this.inputs, "input");
    this.outputs = build(this.outputs, "output");
    this.enumerated = true;
    this.snapshotAt = Date.now();
    this.emit();
    return this.getState();
  }

  listInputDevices(): AudioDeviceInfo[] {
    return this.inputs.map((d) => ({ ...d }));
  }

  listOutputDevices(): AudioDeviceInfo[] {
    return this.outputs.map((d) => ({ ...d }));
  }

  getDefaultInput(): AudioDeviceInfo | null {
    return this.inputs.find((d) => d.isDefault) || this.inputs[0] || null;
  }

  getDefaultOutput(): AudioDeviceInfo | null {
    return this.outputs.find((d) => d.isDefault) || this.outputs[0] || null;
  }

  getSelectedMicId(): string {
    return this.selectedMicId;
  }

  getSelectedOutputId(): string {
    return this.selectedOutputId;
  }

  /** Resolve the effective mic deviceId for getUserMedia (null = default). */
  getEffectiveMicDeviceId(): string | null {
    return isDefaultId(this.selectedMicId) ? null : this.selectedMicId;
  }

  selectInputDevice(id: unknown): { ok: boolean; state: AudioDeviceState; error?: string } {
    const clean = sanitizeDeviceId(id);
    if (!isDefaultId(clean) && this.enumerated && !this.inputs.some((d) => d.id === clean)) {
      return { ok: false, state: this.getState(), error: "unknown microphone device id" };
    }
    this.selectedMicId = clean;
    this.persist();
    const state = this.getState();
    this.emit();
    return { ok: true, state };
  }

  selectOutputDevice(id: unknown): { ok: boolean; state: AudioDeviceState; error?: string } {
    const clean = sanitizeDeviceId(id);
    if (!isDefaultId(clean) && this.enumerated && !this.outputs.some((d) => d.id === clean)) {
      return { ok: false, state: this.getState(), error: "unknown output device id" };
    }
    this.selectedOutputId = clean;
    this.persist();
    const state = this.getState();
    this.emit();
    return { ok: true, state };
  }

  /** Snapshot bookkeeping for an explicit user refresh (enumeration is renderer-side). */
  refreshDevices(): { snapshotAt: number; enumerated: boolean } {
    return { snapshotAt: this.snapshotAt, enumerated: this.enumerated };
  }

  /**
   * Handle a Windows devicechange (with the fresh renderer list when
   * available). Vanished selections are flagged UNAVAILABLE but KEPT (so the
   * UI can show DEVICE UNAVAILABLE with a return-to-default path); capture
   * falls back to default behavior only when explicitly reset. Never throws.
   */
  handleDeviceChange(devices?: Array<{ id: string; label: string; kind: AudioDeviceKind; isDefault?: boolean }>): {
    micInvalidated: boolean;
    outputInvalidated: boolean;
    state: AudioDeviceState;
  } {
    try {
      // A devicechange list is a fresh full enumeration: replace so vanished
      // devices drop out and surface as UNAVAILABLE.
      if (devices) this.updateDeviceList(devices, { replace: true });
    } catch {
      // ignore merge failures; still report current validity below
    }
    const micInvalidated =
      !isDefaultId(this.selectedMicId) && this.enumerated && !this.inputs.some((d) => d.id === this.selectedMicId);
    const outputInvalidated =
      !isDefaultId(this.selectedOutputId) && this.enumerated && !this.outputs.some((d) => d.id === this.selectedOutputId);
    const state = this.getState();
    this.emit();
    return { micInvalidated, outputInvalidated, state };
  }

  /**
   * Record the outcome of a Setup "Play" output-test tone. Never throws;
   * keeps only the last 5 entries. No audio, no device handles stored.
   */
  recordOutputTest(entry: {
    deviceId?: unknown;
    routed?: unknown;
    ok?: unknown;
    error?: unknown;
  }): OutputTestReport {
    const selected = this.getSelectedOutputId();
    const rawId = cleanId(entry?.deviceId) || selected;
    const report: OutputTestReport = {
      deviceIdShort: shortDeviceId(rawId),
      routed: String(entry?.routed || "unknown").slice(0, 32),
      ok: entry?.ok === true,
      error: String(entry?.error || "").slice(0, 300),
      at: Date.now(),
    };
    this.outputTests.push(report);
    while (this.outputTests.length > 5) this.outputTests.shift();
    return { ...report };
  }

  getOutputTests(): OutputTestReport[] {
    return this.outputTests.map((r) => ({ ...r }));
  }

  /** Reset a vanished selection back to the Windows/default device. */
  resetToDefault(kind: AudioDeviceKind): AudioDeviceState {
    if (kind === "input") this.selectedMicId = DEFAULT_DEVICE_ID;
    else this.selectedOutputId = DEFAULT_DEVICE_ID;
    this.persist();
    this.emit();
    return this.getState();
  }

  private statusFor(selectedId: string, list: AudioDeviceInfo[]): { status: DeviceAvailability; label: string } {
    if (isDefaultId(selectedId)) {
      const def = list.find((d) => d.isDefault) || list[0];
      return { status: "AVAILABLE", label: def ? def.label || "(default device)" : "(default device)" };
    }
    if (!this.enumerated) return { status: "UNKNOWN", label: "(not yet enumerated)" };
    const found = list.find((d) => d.id === selectedId);
    if (found) return { status: "AVAILABLE", label: found.label || "(selected device)" };
    return { status: "UNAVAILABLE", label: "DEVICE UNAVAILABLE" };
  }

  getState(): AudioDeviceState {
    const mic = this.statusFor(this.selectedMicId, this.inputs);
    const out = this.statusFor(this.selectedOutputId, this.outputs);
    return {
      inputs: this.listInputDevices(),
      outputs: this.listOutputDevices(),
      selectedMicId: this.selectedMicId,
      selectedOutputId: this.selectedOutputId,
      micLabel: mic.label,
      outputLabel: out.label,
      micStatus: mic.status,
      outputStatus: out.status,
      enumerated: this.enumerated,
      snapshotAt: this.snapshotAt,
    };
  }
}
