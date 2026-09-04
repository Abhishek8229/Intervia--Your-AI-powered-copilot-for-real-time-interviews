import { contextBridge, ipcRenderer } from "electron";

export interface InterviaContextEntry {
  id: string;
  speaker: "candidate" | "interviewer" | "unknown";
  source: "microphone" | "system";
  text: string;
  timestamp: number;
  transcriptEventId: string;
}

export interface InterviaQuestionEvent {
  id: string;
  question: string;
  speaker: "candidate" | "interviewer" | "unknown";
  source: "microphone" | "system";
  type: string;
  confidence: number;
  timestamp: number;
  transcriptEventId: string;
  recentContext: InterviaContextEntry[];
}

contextBridge.exposeInMainWorld("intervia", {
  getStatus: () => ipcRenderer.invoke("intervia:status:get"),
  onStatus: (cb: (s: any) => void) => {
    const handler = (_e: unknown, s: any) => cb(s);
    ipcRenderer.on("intervia:status:update", handler);
    return () => ipcRenderer.removeListener("intervia:status:update", handler);
  },
  onTranscript: (cb: (t: any) => void) => {
    const handler = (_e: unknown, t: any) => cb(t);
    ipcRenderer.on("intervia:transcript:event", handler);
    return () => ipcRenderer.removeListener("intervia:transcript:event", handler);
  },
  onContext: (cb: (e: InterviaContextEntry) => void) => {
    const handler = (_e: unknown, entry: InterviaContextEntry) => cb(entry);
    ipcRenderer.on("intervia:context:event", handler);
    return () => ipcRenderer.removeListener("intervia:context:event", handler);
  },
  onQuestion: (cb: (q: InterviaQuestionEvent) => void) => {
    const handler = (_e: unknown, q: InterviaQuestionEvent) => cb(q);
    ipcRenderer.on("intervia:question:event", handler);
    return () => ipcRenderer.removeListener("intervia:question:event", handler);
  },
  getContextSnapshot: () => ipcRenderer.invoke("intervia:context:snapshot"),
  clearContext: () => ipcRenderer.invoke("intervia:context:clear"),
  resetQuestionDedup: () => ipcRenderer.invoke("intervia:question:reset-dedup"),
  toggleCapture: () => ipcRenderer.invoke("intervia:capture:toggle"),
  startCapture: () => ipcRenderer.invoke("intervia:capture:start"),
  stopCapture: () => ipcRenderer.invoke("intervia:capture:stop"),
  hideOverlay: () => ipcRenderer.send("intervia:overlay:hide"),
  quitApp: () => ipcRenderer.invoke("intervia:app:quit"),
  onAnswer: (cb: (a: any) => void) => {
    const handler = (_e: unknown, a: any) => cb(a);
    ipcRenderer.on("intervia:answer:event", handler);
    return () => ipcRenderer.removeListener("intervia:answer:event", handler);
  },
  onScreen: (cb: (e: any) => void) => {
    const handler = (_e: unknown, entry: any) => cb(entry);
    ipcRenderer.on("intervia:screen:event", handler);
    return () => ipcRenderer.removeListener("intervia:screen:event", handler);
  },
  screenStart: () => ipcRenderer.invoke("intervia:screen:start"),
  screenStop: () => ipcRenderer.invoke("intervia:screen:stop"),
  screenCaptureNow: () => ipcRenderer.invoke("intervia:screen:capture-now"),
  screenSelectRegion: () => ipcRenderer.invoke("intervia:screen:select-region"),
  getScreenSnapshot: () => ipcRenderer.invoke("intervia:screen:snapshot"),
  submitQuestion: (text: string) => ipcRenderer.invoke("intervia:question:submit", text),
  // Region-selector window side.
  regionSelected: (region: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send("intervia:screen:region-selected", region),
  selectCancelled: () => ipcRenderer.send("intervia:screen:select-cancelled"),
  onAnswerError: (cb: (e: any) => void) => {
    const handler = (_e: unknown, err: any) => cb(err);
    ipcRenderer.on("intervia:answer:error", handler);
    ipcRenderer.send("intervia:answer:error-subscribe");
    return () => ipcRenderer.removeListener("intervia:answer:error", handler);
  },
  openSettings: () => ipcRenderer.invoke("intervia:settings:open"),
  // Settings window APIs (profiles / personas / JD / sessions / providers).
  profilesList: () => ipcRenderer.invoke("intervia:profiles:list"),
  profilesGet: (id: string) => ipcRenderer.invoke("intervia:profiles:get", id),
  profilesSave: (p: any) => ipcRenderer.invoke("intervia:profiles:save", p),
  profilesCreate: (name: string) => ipcRenderer.invoke("intervia:profiles:create", name),
  profilesDelete: (id: string) => ipcRenderer.invoke("intervia:profiles:delete", id),
  profilesSetActive: (id: string) => ipcRenderer.invoke("intervia:profiles:set-active", id),
  profilesPatch: (id: string, patch: any) => ipcRenderer.invoke("intervia:profiles:patch", id, patch),
  profilesSaveEditor: (id: string, patch: any) => ipcRenderer.invoke("intervia:profiles:save-editor", id, patch),
  profilesImport: () => ipcRenderer.invoke("intervia:profiles:import"),
  personasList: () => ipcRenderer.invoke("intervia:personas:list"),
  personasSave: (p: any) => ipcRenderer.invoke("intervia:personas:save", p),
  personasCreate: (name: string) => ipcRenderer.invoke("intervia:personas:create", name),
  personasDelete: (id: string) => ipcRenderer.invoke("intervia:personas:delete", id),
  personasSetActive: (id: string | null) => ipcRenderer.invoke("intervia:personas:set-active", id),
  modeSet: (mode: string) => ipcRenderer.invoke("intervia:mode:set", mode),
  modeGet: () => ipcRenderer.invoke("intervia:mode:get"),
  jdsList: () => ipcRenderer.invoke("intervia:jds:list"),
  jdsGet: (id: string) => ipcRenderer.invoke("intervia:jds:get", id),
  jdsSaveText: (title: string, rawText: string) => ipcRenderer.invoke("intervia:jds:save-text", title, rawText),
  jdsSave: (jd: any) => ipcRenderer.invoke("intervia:jds:save", jd),
  jdsCreate: (title: string) => ipcRenderer.invoke("intervia:jds:create", title),
  jdsDelete: (id: string) => ipcRenderer.invoke("intervia:jds:delete", id),
  jdsSetActive: (id: string | null) => ipcRenderer.invoke("intervia:jds:set-active", id),
  sessionsList: () => ipcRenderer.invoke("intervia:sessions:list"),
  sessionsGet: (id: string) => ipcRenderer.invoke("intervia:sessions:get", id),
  sessionsActive: () => ipcRenderer.invoke("intervia:sessions:active"),
  sessionsClear: (id: string) => ipcRenderer.invoke("intervia:sessions:clear", id),
  sessionsClearAll: () => ipcRenderer.invoke("intervia:sessions:clear-all"),
  providersDiagnose: (probe: boolean) => ipcRenderer.invoke("intervia:providers:diagnose", probe),
  providersGetConfig: () => ipcRenderer.invoke("intervia:providers:get-config"),
  providersSetConfig: (cfg: unknown) => ipcRenderer.invoke("intervia:providers:set-config", cfg),
  diagnosticsOpen: () => ipcRenderer.invoke("intervia:diagnostics:open"),
  diagnosticsRunSystem: () => ipcRenderer.invoke("intervia:diagnostics:run-system"),
  diagnosticsTestMic: () => ipcRenderer.invoke("intervia:diagnostics:test-mic"),
  diagnosticsTestSysAudio: () => ipcRenderer.invoke("intervia:diagnostics:test-sys-audio"),
  diagnosticsAudioSources: () => ipcRenderer.invoke("intervia:diagnostics:audio-sources"),
  diagnosticsScreenTrace: () => ipcRenderer.invoke("intervia:diagnostics:test-screen"),
  diagnosticsScreenFrame: () => ipcRenderer.invoke("intervia:diagnostics:screen-frame"),
  diagnosticsScreenSources: () => ipcRenderer.invoke("intervia:diagnostics:screen-sources"),
  diagnosticsRegionReport: () => ipcRenderer.invoke("intervia:diagnostics:region-report"),
  diagnosticsTestPipeline: () => ipcRenderer.invoke("intervia:diagnostics:test-pipeline"),
  diagnosticsTestScreen: () => ipcRenderer.invoke("intervia:diagnostics:test-screen"),
  diagnosticsTestSim: () => ipcRenderer.invoke("intervia:diagnostics:test-sim"),
  diagnosticsStopAudio: () => ipcRenderer.invoke("intervia:diagnostics:stop-audio"),
  diagnosticsAudioLevels: () => ipcRenderer.invoke("intervia:diagnostics:audio-levels"),
  diagnosticsExport: () => ipcRenderer.invoke("intervia:diagnostics:export"),
  // Audio device selection (Setup + Diagnostics windows).
  audioDevicesGet: () => ipcRenderer.invoke("intervia:audio-devices:get"),
  audioDevicesReport: (devices: unknown) => ipcRenderer.send("intervia:audio-devices:report", devices),
  audioDevicesSelectMic: (id: string) => ipcRenderer.invoke("intervia:audio-devices:select-mic", id),
  audioDevicesSelectOutput: (id: string) => ipcRenderer.invoke("intervia:audio-devices:select-output", id),
  audioDevicesReset: (kind: string) => ipcRenderer.invoke("intervia:audio-devices:reset", kind),
  audioDevicesRefresh: () => ipcRenderer.invoke("intervia:audio-devices:refresh"),
  // Output-test tone outcome reporting (Setup Play button -> diagnostics log).
  reportOutputTest: (result: { deviceId: string; routed: string; ok: boolean; error?: string }) =>
    ipcRenderer.invoke("intervia:audio-devices:output-test", result),
  // Live input-level events broadcast by main on the existing
  // "intervia:audio:level" channel (Setup meters + diagnostics). Listen-only.
  onAudioLevel: (cb: (e: { source: string; level: number; db: number; peak: number; chunks: number; timestamp: number }) => void) => {
    const handler = (_e: unknown, evt: { source: string; level: number; db: number; peak: number; chunks: number; timestamp: number }) => {
      try {
        cb(evt);
      } catch {
        // never break the renderer on a listener failure
      }
    };
    ipcRenderer.on("intervia:audio:level", handler);
    return () => ipcRenderer.removeListener("intervia:audio:level", handler);
  },
  enumerateLocalDevices: async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return (devs || [])
        .filter((d) => d.kind === "audioinput" || d.kind === "audiooutput")
        .map((d) => ({
          id: String(d.deviceId || ""),
          label: String(d.label || "").slice(0, 120),
          kind: d.kind === "audiooutput" ? "output" : "input",
          isDefault: String(d.deviceId || "").toLowerCase() === "default",
        }))
        .filter((d) => d.id.length > 0);
    } catch {
      return [];
    }
  },
});