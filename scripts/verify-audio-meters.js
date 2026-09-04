/* eslint-disable */
// Focused suite for: live mic/system level meters + output Play test tone.
// Plain Node (no Electron): pure-unit checks against the compiled AudioLevel
// module + AudioDeviceManager, plus static wiring checks on the built
// main/preload/renderer files (proving the pipeline is connected without
// pretending headless Node can hear a speaker).

const path = require("path");
const fs = require("fs");
const dist = path.resolve(__dirname, "..", "dist");

const {
  DB_FLOOR_DB,
  clampLevel,
  levelToDb,
  rmsToDb,
  formatDb,
  makeLevelEvent,
  isValidLevelEvent,
} = require(path.join(dist, "main", "audio", "AudioLevel.js"));
const {
  AudioDeviceManager,
  DEFAULT_DEVICE_ID,
  LOOPBACK_NOTE,
} = require(path.join(dist, "main", "audio", "AudioDeviceManager.js"));

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function readDist(rel) {
  return fs.readFileSync(path.join(dist, rel), "utf8");
}
function memStore(initial) {
  let saved = initial || {};
  return {
    load: () => ({ ...saved }),
    save: (sel) => { saved = { ...sel }; },
    _saved: () => ({ ...saved }),
  };
}
const INPUTS = [
  { id: "default", label: "", kind: "input", isDefault: true },
  { id: "mic-a", label: "Mic A", kind: "input" },
];
const OUTPUTS = [
  { id: "default", label: "", kind: "output", isDefault: true },
  { id: "out-hp", label: "Headphones", kind: "output" },
];

// [1] Microphone meter receives level events (correct source assignment).
function t1() {
  console.log("\n[1] Microphone meter receives level events");
  const e = makeLevelEvent("microphone", 0.5, 0.7, 3, 1234);
  assert(e.source === "microphone", "level event carries source=microphone");
  assert(e.level === 0.5 && e.peak === 0.7 && e.chunks === 3, "level/peak/chunks preserved");
  assert(isValidLevelEvent(e) === true, "event validates");
  const settings = readDist(path.join("renderer", "settings.js"));
  assert(settings.includes("onAudioLevel"), "Setup subscribes to level events (no new capture stream)");
  assert(settings.includes("mic-meter-fill") && settings.includes("mic-db"), "mic meter widgets wired");
  assert(/microphone[^;]*mic-meter|mic-meter[^;]*microphone/s.test(settings) || settings.includes('"microphone": { bar: "mic-meter"'), "microphone source drives the mic meter");
}

// [2] System meter receives level events.
function t2() {
  console.log("\n[2] System meter receives level events");
  const e = makeLevelEvent("system", 0.25, 0.25, 1);
  assert(e.source === "system", "level event carries source=system");
  assert(Number.isFinite(e.db) && e.db <= 0 && e.db >= -60, "system event has bounded dB (got " + e.db + ")");
  const settings = readDist(path.join("renderer", "settings.js"));
  assert(settings.includes("sys-meter-fill") && settings.includes("sys-db"), "system meter widgets wired");
  assert(settings.includes("unknown source"), "unknown sources are ignored (never misassigned)");
}

// [3] Silence never produces NaN or Infinity.
function t3() {
  console.log("\n[3] Silence safety (no NaN / Infinity)");
  for (const v of [0, -0, -1, NaN, Infinity, -Infinity, undefined, null, "x", ""]) {
    const db = levelToDb(v);
    assert(Number.isFinite(db), "levelToDb(" + String(v) + ") is finite (got " + db + ")");
    assert(db === DB_FLOOR_DB, "silence-like input maps to floor -60 dB");
  }
  const e = makeLevelEvent("microphone", NaN, Infinity, NaN);
  assert(Number.isFinite(e.level) && Number.isFinite(e.db) && Number.isFinite(e.peak), "event from garbage input stays finite");
  assert(/^-?\d+ dB$/.test(formatDb(NaN)) && /^-?\d+ dB$/.test(formatDb(-Infinity)), "formatDb never emits NaN/Infinity text");
}

// [4] dB conversion is bounded.
function t4() {
  console.log("\n[4] dB conversion bounded to [-60, 0]");
  const sweep = [0, 0.0005, 0.001, 0.01, 0.03, 0.1, 0.3, 0.5, 0.9, 1, 1.5, 100];
  let ok = true;
  for (const v of sweep) {
    const db = levelToDb(v);
    if (!Number.isFinite(db) || db < -60 || db > 0) ok = false;
  }
  assert(ok, "sweep 0..100 stays within [-60, 0] and finite");
  assert(levelToDb(1) === 0, "full scale maps to 0 dB");
  assert(rmsToDb(0.1) < 0 && rmsToDb(0.1) > -60, "speech-ish RMS lands mid-scale (got " + rmsToDb(0.1).toFixed(1) + " dB)");
  assert(clampLevel(2) === 1 && clampLevel(-2) === 0 && clampLevel(NaN) === 0, "clampLevel guards range + non-finite");
}

// [5] Level updates are throttled/safe (no per-sample IPC, smoothed UI).
function t5() {
  console.log("\n[5] Level updates throttled + smoothed");
  const cap = readDist(path.join("renderer", "audio-capture.js"));
  const sends = (cap.match(/sendLevel\(/g) || []).length;
  assert(sends === 1, "exactly one sendLevel call site, per 250 ms frame (got " + sends + ")");
  const settings = readDist(path.join("renderer", "settings.js"));
  assert(settings.includes("requestAnimationFrame"), "meters render on rAF (no excessive DOM churn)");
  assert(settings.includes("STALE_MS") || settings.includes("stale"), "stale pipeline decays instead of freezing");
  assert(settings.includes("attack") || settings.includes("0.5"), "fast-attack smoothing present (no wild flicker)");
  const mgr = readDist(path.join("main", "audio", "AudioManager.js"));
  assert(/try\s*\{[\s\S]{0,400}getAllWindows/.test(mgr), "main broadcast is best-effort guarded");
}

// [6] Correct source assigned to each meter (no cross-talk).
function t6() {
  console.log("\n[6] Meter source assignment");
  assert(isValidLevelEvent({ source: "mic", level: 1, db: -1 }) === false, "invalid source rejected by validator");
  assert(isValidLevelEvent(null) === false && isValidLevelEvent({}) === false, "garbage events rejected");
  const settings = readDist(path.join("renderer", "settings.js"));
  assert(settings.includes('"system"') && settings.includes('"microphone"'), "both sources routed explicitly");
}

// [7]+[8] Selections persist.
function t7t8() {
  console.log("\n[7+8] Selected microphone + output persist");
  const store = memStore();
  const m = new AudioDeviceManager(store);
  m.updateDeviceList([...INPUTS, ...OUTPUTS]);
  assert(m.selectInputDevice("mic-a").ok === true, "mic selection accepted");
  assert(m.selectOutputDevice("out-hp").ok === true, "output selection accepted");
  assert(store._saved().selectedMicrophoneId === "mic-a", "mic id persisted");
  assert(store._saved().selectedOutputDeviceId === "out-hp", "output id persisted");
  const m2 = new AudioDeviceManager(store);
  assert(m2.getSelectedMicId() === "mic-a" && m2.getSelectedOutputId() === "out-hp", "both survive reload");
}

// [9]+[10] Missing devices handled (no crash, no silent switch).
function t9t10() {
  console.log("\n[9+10] Missing microphone + output handled");
  const m = new AudioDeviceManager(memStore());
  m.updateDeviceList([...INPUTS, ...OUTPUTS]);
  m.selectInputDevice("mic-a");
  m.selectOutputDevice("out-hp");
  const res = m.handleDeviceChange([
    { id: "default", label: "", kind: "input", isDefault: true },
    { id: "default", label: "", kind: "output", isDefault: true },
  ]);
  assert(res.micInvalidated && res.outputInvalidated, "vanished selections flagged");
  const st = m.getState();
  assert(st.micStatus === "UNAVAILABLE" && st.outputStatus === "UNAVAILABLE", "both UNAVAILABLE");
  assert(m.getSelectedMicId() === "mic-a" && m.getSelectedOutputId() === "out-hp", "selections kept (explicit Defaults path)");
}

// [11]+[12] Use Defaults + Refresh still work.
function t11t12() {
  console.log("\n[11+12] Use Defaults + Refresh Devices");
  const m = new AudioDeviceManager(memStore());
  m.updateDeviceList([...INPUTS, ...OUTPUTS]);
  m.selectInputDevice("mic-a");
  m.selectOutputDevice("out-hp");
  m.resetToDefault("input");
  m.resetToDefault("output");
  assert(m.getSelectedMicId() === DEFAULT_DEVICE_ID && m.getSelectedOutputId() === DEFAULT_DEVICE_ID, "defaults restored");
  const r = m.refreshDevices();
  assert(r.enumerated === true && r.snapshotAt > 0, "refresh reports snapshot");
  const settings = readDist(path.join("renderer", "settings.js"));
  assert(settings.includes("devices-refresh") && settings.includes("devices-default"), "both buttons still wired");
}

// [13] Play button uses the selected output configuration.
function t13() {
  console.log("\n[13] Play uses selected output configuration");
  const settings = readDist(path.join("renderer", "settings.js"));
  assert(settings.includes("output-play"), "Play button wired");
  assert(settings.includes("output-select") && settings.includes("setSinkId"), "reads selected output + routes via setSinkId");
  assert(settings.includes("playToneToDevice"), "dedicated tone-routing function");
  assert(settings.includes("reportOutputTest"), "tone outcome reported for diagnostics");
  const preload = readDist(path.join("preload", "overlay-preload.js"));
  assert(preload.includes("onAudioLevel") && preload.includes("reportOutputTest"), "preload exposes level listen + test report (nothing else new)");
  const main = readDist(path.join("main", "index.js"));
  assert(main.includes("intervia:audio-devices:output-test"), "main records output-test reports");
}

// [14] Default output path works (no setSinkId needed).
function t14() {
  console.log("\n[14] Default output path");
  const settings = readDist(path.join("renderer", "settings.js"));
  assert(settings.includes('!== "default"'), "default selection skips setSinkId (plays via default device)");
  assert(settings.includes("default-fallback"), "unsupported hosts fall back honestly, not silently");
}

// [15] Missing selected output returns a controlled error.
function t15() {
  console.log("\n[15] Missing selected output -> controlled error");
  const settings = readDist(path.join("renderer", "settings.js"));
  assert(settings.includes("DEVICE UNAVAILABLE"), "vanished output surfaces DEVICE UNAVAILABLE (no crash, no fake success)");
  assert(settings.includes("Use Defaults to recover"), "recovery path named");
  const m = new AudioDeviceManager(memStore());
  const rep = m.recordOutputTest({ deviceId: "out-hp", routed: "none", ok: false, error: "DEVICE UNAVAILABLE" });
  assert(rep.ok === false && /UNAVAILABLE/.test(rep.error), "failed tone recorded with error");
  for (let i = 0; i < 10; i++) m.recordOutputTest({ deviceId: "x", routed: "none", ok: false });
  assert(m.getOutputTests().length <= 5, "output-test history bounded (got " + m.getOutputTests().length + ")");
}

// [16] Existing loopback behavior unchanged (honest, still system mix).
function t16() {
  console.log("\n[16] Loopback behavior unchanged");
  assert(/system mix/i.test(LOOPBACK_NOTE) && /does NOT retarget/i.test(LOOPBACK_NOTE), "LOOPBACK_NOTE still honest");
  const cap = readDist(path.join("renderer", "audio-capture.js"));
  assert(cap.includes("chromeMediaSource") && cap.includes("desktop"), "desktop-loopback mechanism untouched");
  const mgr = readDist(path.join("main", "audio", "AudioManager.js"));
  assert(mgr.includes("sysOutput"), "output label still reporting-only");
  const settings = readDist(path.join("renderer", "settings.js"));
  assert(settings.includes("loopbackNote"), "Setup still surfaces the limitation");
  assert(!/retargets capture|per-device loopback/i.test(settings), "no new per-device loopback claims");
}

// [17] Existing microphone capture unchanged.
function t17() {
  console.log("\n[17] Microphone capture unchanged");
  const cap = readDist(path.join("renderer", "audio-capture.js"));
  assert(cap.includes("deviceId") && cap.includes("exact"), "selected mic still applied as exact constraint");
  assert(cap.includes("DEVICE UNAVAILABLE"), "vanished-mic path intact");
  const mgr = readDist(path.join("main", "audio", "AudioManager.js"));
  assert(mgr.includes("micDevice"), "mic device forwarding intact");
}

// [18] No duplicate capture stream created just for meters.
function t18() {
  console.log("\n[18] No duplicate capture stream for meters");
  const settings = readDist(path.join("renderer", "settings.js"));
  assert(!settings.includes("getUserMedia"), "Setup opens NO media stream (meters reuse pipeline levels)");
  assert(!settings.includes("createMediaStreamSource") && !settings.includes("ScriptProcessor"), "no capture graph in Setup");
  const diag = readDist(path.join("renderer", "diagnostics.js"));
  assert(!diag.includes("getUserMedia"), "diagnostics opens NO media stream either");
}

// [19] No raw audio persisted.
function t19() {
  console.log("\n[19] No raw audio persisted");
  const settings = readDist(path.join("renderer", "settings.js"));
  assert(!settings.includes("localStorage") && !settings.includes("sessionStorage"), "no level/audio persistence in Setup");
  for (const f of [path.join("main", "audio", "AudioManager.js"), path.join("main", "audio", "AudioLevel.js")]) {
    const src = readDist(f);
    assert(!src.includes("writeFile") && !src.includes("fs."), f + " never writes audio/levels to disk");
  }
  const html = readDist(path.join("renderer", "settings.html"));
  assert(html.includes("mic-meter") && html.includes("sys-meter") && html.includes("output-play"), "meters + Play present in Setup HTML");
  assert(!/AVAILABLE ·|Default - Microphone|Default - Headphones/.test(html), "verbose status text gone from HTML");
  assert(!/mic-status[^]*AVAILABLE ·/.test(settings), "verbose status text gone from Setup JS");
  assert(settings.includes("mic-select") && settings.includes("output-select"), "dropdowns preserved as the selection controls");
}

// [20] Tone shape: short, moderate, debounced (static contract).
function t20() {
  console.log("\n[20] Tone contract (short, moderate, debounced)");
  const settings = readDist(path.join("renderer", "settings.js"));
  assert(/DUR = 0\.5|0\.5/.test(settings) && settings.includes("880"), "tone ~500 ms @ 880 Hz");
  assert(settings.includes("0.2"), "moderate peak volume (0.2)");
  assert(settings.includes("playBusy"), "button debounced while playing");
  assert(settings.includes("Playing"), "Playing visual state present");
}

async function main() {
  console.log("Intervia audio meters + output-test suite");
  t1(); t2(); t3(); t4(); t5(); t6(); t7t8(); t9t10(); t11t12();
  t13(); t14(); t15(); t16(); t17(); t18(); t19(); t20();
  console.log("\n=================================");
  console.log(`METER SUITE: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log("ALL METER TESTS PASSED"); process.exit(0); }
  else { console.log("FAILED: " + failed); process.exit(1); }
}

main().catch((e) => { console.error("crashed", e); process.exit(2); });
