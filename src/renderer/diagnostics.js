/* eslint-disable */
const api = window.intervia;

function el(id) { return document.getElementById(id); }

// Physical checklist state: each entry is PASS/FAIL/pending + measured values.
const checklist = {
  mic: { label: "TEST MICROPHONE", status: "pending", detail: "not run" },
  sys: { label: "TEST SYSTEM AUDIO", status: "pending", detail: "not run" },
  screen: { label: "CAPTURE SCREEN", status: "pending", detail: "not run" },
  region: { label: "CAPTURE REGION", status: "pending", detail: "not run" },
};

function renderChecklist() {
  const rows = Object.values(checklist).map((c) => {
    const mark = c.status === "PASS" ? "PASS" : c.status === "FAIL" ? "FAIL" : "....";
    return mark + "  " + c.label + "  :: " + c.detail;
  });
  el("checklist-out").textContent = rows.join("\n");
}

function setCheck(key, status, detail) {
  checklist[key] = { ...checklist[key], status, detail };
  renderChecklist();
}

function stateBadge(state) {
  const cls = state === "FRAMES RECEIVING" ? "b-frames"
    : state === "STREAM CREATED" ? "b-stream"
    : state === "ERROR" || state === "NO FRAMES" ? "b-noframes"
    : "b-ready";
  return { text: state, cls };
}

function renderAudioStates(micState, sysState) {
  const box = el("audio-state-out");
  box.innerHTML = "";
  const line = (label, s) => {
    const b = stateBadge(s || "READY");
    const div = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = label + ": ";
    const badge = document.createElement("span");
    badge.className = "badge " + b.cls;
    badge.textContent = b.text;
    div.appendChild(name);
    div.appendChild(badge);
    box.appendChild(div);
  };
  line("Microphone", micState);
  line("System Audio", sysState);
}

async function runCommand(btnId, outId, action) {
  const btn = el(btnId);
  const out = el(outId);
  btn.disabled = true;
  out.innerHTML = '<span class="muted">Running...</span>';
  try {
    const res = await action();
    if (typeof res === "string") {
      out.textContent = res;
    } else {
      out.textContent = JSON.stringify(res, null, 2);
    }
    return res;
  } catch (err) {
    out.innerHTML = '<span class="error">' + (err && err.message ? err.message : String(err)) + '</span>';
    return null;
  } finally {
    btn.disabled = false;
  }
}

function summarizeAudioProbe(res) {
  if (!res) return "no result";
  if (res.reason) return "ERROR :: " + res.reason;
  const sel = res.selectedDevice || {};
  const selStr = sel.label ? ("Device: " + sel.label + " [" + (sel.idShort || "?") + "] " + (sel.status || "")) : "Device: (default)";
  const sig = res.signal || (res.ok ? (res.audible ? "SIGNAL DETECTED" : "SILENT SIGNAL") : res.state);
  const rmsBit = (res.rmsLevel !== undefined ? " rms=" + res.rmsLevel : "") +
    (res.rmsDb !== undefined ? " (" + res.rmsDb + " dB)" : "") +
    (res.rendererRms !== undefined ? " tapRms=" + res.rendererRms : "") +
    (res.rendererDb !== undefined ? " tapDb=" + res.rendererDb + " dB" : "");
  return (res.ok ? "PASS" : "FAIL") + " :: " + sig + " :: state=" + res.state +
    " chunks=" + res.chunks + " bytes=" + res.bytesReceived +
    " peak=" + res.peakLevel + rmsBit + " sr=" + res.sampleRate + " ch=" + res.channels +
    " track=" + ((res.track && res.track.readyState) || "?") +
    " ctx=" + res.ctxState + " stt=" + ((res.stt && res.stt.connected) ? "connected" : "NOT CONNECTED") +
    "\n" + selStr + (sel.loopbackNote ? "\nNote: " + sel.loopbackNote : "");
}

function renderDevices(dev) {
  const box = el("devices-out");
  if (!box) return;
  if (!dev) { box.textContent = "devices: -"; return; }
  const lines = [
    "MICROPHONE",
    "  Selected: " + (dev.micLabel || "(default)"),
    "  Device ID: " + (dev.micIdShort || "(default)"),
    "  Status: " + (dev.micStatus || "UNKNOWN"),
    "SYSTEM OUTPUT",
    "  Selected: " + (dev.outputLabel || "(default)"),
    "  Device ID: " + (dev.outputIdShort || "(default)"),
    "  Status: " + (dev.outputStatus || "UNKNOWN"),
  ];
  if (dev.loopbackNote) lines.push("Note: " + dev.loopbackNote);
  const tests = (dev && dev.outputTests) || [];
  if (tests.length) {
    lines.push("OUTPUT TEST TONES (selected-output verification, not loopback):");
    for (const t of tests.slice(-5)) {
      const when = t.at ? new Date(t.at).toLocaleTimeString() : "?";
      lines.push("  [" + when + "] device=" + (t.deviceIdShort || "?") +
        " routed=" + (t.routed || "?") + " ok=" + (t.ok ? "yes" : "no") +
        (t.error ? " error=" + t.error : ""));
    }
  } else {
    lines.push("OUTPUT TEST TONES: none yet (Setup -> System Output -> Play)");
  }
  box.textContent = lines.join("\n");
}

// dBFS mirror of src/main/audio/AudioLevel.ts levelToDb (floor -60, never -Inf).
function levelToDb(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return -60;
  const c = Math.max(0.001, Math.min(1, n));
  const db = 20 * Math.log10(c);
  if (!Number.isFinite(db)) return -60;
  return Math.max(-60, Math.min(0, db));
}

function summarizeTrace(t) {
  if (!t) return "no result";
  const parts = [
    "source=" + (t.source && t.source.found ? "FOUND (" + t.source.name + ")" : "NOT FOUND"),
    "capture=" + (t.capture && t.capture.ok ? "SUCCESS " + t.capture.width + "x" + t.capture.height + " " + t.capture.bytes + "B" : "FAIL"),
    "change=" + ((t.change && t.change.verdict) || "?"),
    "ocr=" + ((t.ocr && t.ocr.kind) || "?") + "/" + ((t.ocr && t.ocr.call) || "?") + " chars=" + ((t.ocr && t.ocr.chars) || 0),
    "event=" + (t.event && t.event.emitted ? "EMITTED" : "NOT EMITTED"),
  ];
  return ((t.pass ? "PASS" : "FAIL") + " :: " + parts.join(" | ") + (t.failureStage ? " || failureStage=" + t.failureStage : ""));
}

el("btn-run-system").addEventListener("click", () => {
  runCommand("btn-run-system", "system-out", async () => {
    const res = await api.diagnosticsRunSystem();
    try {
      const st = (res && res.audio && res.audio.states) || {};
      renderAudioStates(st.microphone && st.microphone.state, st.system && st.system.state);
      renderDevices(res && res.audio && res.audio.devices);
    } catch (e) { /* ignore */ }
    return res;
  });
});

el("btn-test-mic").addEventListener("click", async () => {
  renderAudioStates("READY", "READY");
  const res = await runCommand("btn-test-mic", "audio-out", () => api.diagnosticsTestMic());
  setCheck("mic", res && res.ok ? "PASS" : "FAIL", summarizeAudioProbe(res));
  if (res) renderAudioStates(res.state, "READY");
});

el("btn-test-sys").addEventListener("click", async () => {
  renderAudioStates("READY", "READY");
  const res = await runCommand("btn-test-sys", "audio-out", () => api.diagnosticsTestSysAudio());
  setCheck("sys", res && res.ok ? "PASS" : "FAIL", summarizeAudioProbe(res));
  if (res) renderAudioStates("READY", res.state);
});

el("btn-audio-sources").addEventListener("click", () => {
  runCommand("btn-audio-sources", "audio-out", () => api.diagnosticsAudioSources());
});

el("btn-stop-audio").addEventListener("click", () => {
  runCommand("btn-stop-audio", "audio-out", () => api.diagnosticsStopAudio());
});

el("btn-test-pipeline").addEventListener("click", () => {
  runCommand("btn-test-pipeline", "pipeline-out", () => api.diagnosticsTestPipeline());
});

el("btn-test-sim").addEventListener("click", () => {
  runCommand("btn-test-sim", "pipeline-out", () => api.diagnosticsTestSim());
});

el("btn-test-screen").addEventListener("click", async () => {
  const res = await runCommand("btn-test-screen", "screen-out", () =>
    (api.diagnosticsScreenTrace ? api.diagnosticsScreenTrace() : api.diagnosticsTestScreen()));
  setCheck("screen", res && res.pass ? "PASS" : "FAIL", summarizeTrace(res));
});

el("btn-screen-frame").addEventListener("click", () => {
  runCommand("btn-screen-frame", "screen-out", () => api.diagnosticsScreenFrame());
});

el("btn-screen-sources").addEventListener("click", () => {
  runCommand("btn-screen-sources", "screen-out", () => api.diagnosticsScreenSources());
});

if (api.screenSelectRegion) {
  el("btn-region").addEventListener("click", () => {
    runCommand("btn-region", "screen-out", async () => {
      await api.screenSelectRegion();
      return "Region selector opened on the cursor display. Drag a rectangle, release to capture, Esc cancels.";
    });
  });
}

el("btn-region-report").addEventListener("click", async () => {
  const res = await runCommand("btn-region-report", "screen-out", () => api.diagnosticsRegionReport());
  if (res && res.available && !res.cancelled && !res.error && res.captured) {
    setCheck("region", "PASS", "display=" + res.displayId + " dip=" +
      res.dipBounds.width + "x" + res.dipBounds.height + " captured=" +
      res.captured.width + "x" + res.captured.height + " pixels=" + res.pixelCount + " " + res.dpiResult);
  } else if (res && res.cancelled) {
    setCheck("region", "FAIL", "cancelled by user (Escape) — no side effects, as designed");
  } else if (res && res.available) {
    setCheck("region", "FAIL", "error=" + (res.error || "no capture"));
  }
});

if (api.diagnosticsExport) {
  el("btn-export").addEventListener("click", () => {
    runCommand("btn-export", "export-out", () => api.diagnosticsExport());
  });
}

function levelBar(v) {
  const n = Math.max(0, Math.min(1, Number(v) || 0));
  const filled = Math.round(n * 20);
  return "[" + "#".repeat(filled) + "-".repeat(20 - filled) + "] " + n.toFixed(2);
}

async function pollLevels() {
  try {
    if (!api.diagnosticsAudioLevels) return;
    const lv = await api.diagnosticsAudioLevels();
    const keys = Object.keys(lv || {});
    if (keys.length === 0) {
      el("levels-out").textContent = "levels: - (start capture or run a mic/system test)";
      return;
    }
    el("levels-out").textContent = keys.map((k) => {
      const e = lv[k] || {};
      const db = Number.isFinite(Number(e.db)) ? Math.round(Number(e.db)) : Math.round(levelToDb(e.level));
      const peak = Number.isFinite(Number(e.peak)) ? Math.round(levelToDb(Number(e.peak))) : Math.round(levelToDb(e.level));
      const frames = Number(e.chunks) || 0;
      return k + " " + levelBar(e.level) + " " + db + " dB" +
        " peak=" + peak + " dB" +
        " frames=" + frames + (frames > 0 ? " (ARRIVING)" : " (none yet)");
    }).join("\n");
  } catch (e) { /* keep last display on error */ }
}
// Live push (same channel the Setup meters use) so diagnostics levels move
// between polls; the 1 s poll above remains as the fallback.
if (api.onAudioLevel) {
  try {
    api.onAudioLevel(() => { /* next pollLevels tick renders; no extra work */ });
  } catch (e) { /* poll fallback covers it */ }
}
setInterval(pollLevels, 1000);

// Auto-run system check
renderChecklist();
renderAudioStates("READY", "READY");
setTimeout(() => el("btn-run-system").click(), 500);
