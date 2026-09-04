import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("intervia", {
  sendChunk: (payload: { source: string; buffer: ArrayBuffer; sampleRate: number; channels: number }) =>
    ipcRenderer.send("intervia:audio:chunk", payload),
  sendSourceSampleRate: (sr: number) =>
    ipcRenderer.send("intervia:audio:source-sample-rate", sr),
  sendError: (payload: { source: string; message: string }) =>
    ipcRenderer.send("intervia:audio:error", payload),
  sendLevel: (payload: { source: string; level: number }) =>
    ipcRenderer.send("intervia:audio:level", payload),
  sendStats: (payload: Record<string, unknown>) =>
    ipcRenderer.send("intervia:audio:stats", payload),
  sendDevices: (devices: Array<{ id: string; label: string; kind: string; isDefault?: boolean }>) =>
    ipcRenderer.send("intervia:audio:devices", devices),
  sendDeviceChange: (devices: Array<{ id: string; label: string; kind: string; isDefault?: boolean }>) =>
    ipcRenderer.send("intervia:audio:device-change", devices),
  requestSystemSource: () => ipcRenderer.invoke("intervia:audio:request-system-source"),
  onQueryStats: (cb: () => void) => {
    const handler = (): void => {
      try {
        cb();
      } catch {
        // ignore
      }
    };
    ipcRenderer.on("intervia:audio:query-stats", handler);
    return () => ipcRenderer.removeListener("intervia:audio:query-stats", handler);
  },
});
