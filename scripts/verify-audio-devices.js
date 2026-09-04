/* eslint-disable */
// Deterministic tests for user-selectable audio devices (AudioDeviceManager
// + AudioManager/renderer integration). Plain Node (no Electron): device
// enumeration is injected, capture integration is verified via the resolved
// configuration + static wiring of the built renderer/main files.

const path = require("path");
const fs = require("fs");
const dist = path.resolve(__dirname, "..", "dist");

const {
  AudioDeviceManager,
  DEFAULT_DEVICE_ID,
  LOOPBACK_NOTE,
  shortDeviceId,
  sanitizeDeviceId,
  displayLabel,
} = require(path.join(dist, "main", "audio", "AudioDeviceManager.js"));
const { classifyAudioProbe } = require(path.join(dist, "main", "audio", "AudioManager.js"));

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
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
  { id: "mic-hyperx-001", label: "HyperX Cloud II Microphone", kind: "input" },
  { id: "mic-usb-002", label: "USB Microphone", kind: "input" },
];
const OUTPUTS = [
  { id: "default", label: "", kind: "output", isDefault: true },
  { id: "out-headphones-001", label: "Headphones (USB DAC)", kind: "output" },
  { id: "out-hdmi-002", label: "HDMI Audio", kind: "output" },
];

function mgrWithDevices(store) {
  const m = new AudioDeviceManager(store || memStore());
  m.updateDeviceList([...INPUTS, ...OUTPUTS]);
  return m;
}

// [1] input device enumeration
function t1() {
  console.log("\n[1] Input device enumeration");
  const m = mgrWithDevices();
  const ins = m.listInputDevices();
  assert(ins.length === 3, "3 inputs enumerated (got " + ins.length + ")");
  assert(ins.some((d) => d.label === "HyperX Cloud II Microphone"), "human-readable input label present");
  assert(m.getState().enumerated === true, "enumerated flag set after list merge");
}

// [2] output device enumeration
function t2() {
  console.log("\n[2] Output device enumeration");
  const m = mgrWithDevices();
  const outs = m.listOutputDevices();
  assert(outs.length === 3, "3 outputs enumerated (got " + outs.length + ")");
  assert(outs.some((d) => d.label === "Headphones (USB DAC)"), "headphones output listed");
  assert(outs.some((d) => d.label === "HDMI Audio"), "HDMI output listed");
}

// [3] default input detection
function t3() {
  console.log("\n[3] Default input detection");
  const m = mgrWithDevices();
  const def = m.getDefaultInput();
  assert(def && def.isDefault === true, "default input detected via flag");
  const m2 = new AudioDeviceManager(memStore());
  m2.updateDeviceList([{ id: "a", label: "Only Mic", kind: "input" }]);
  assert(m2.getDefaultInput() && m2.getDefaultInput().id === "a", "falls back to first input when no flag");
}

// [4] default output detection
function t4() {
  console.log("\n[4] Default output detection");
  const m = mgrWithDevices();
  const def = m.getDefaultOutput();
  assert(def && def.isDefault === true, "default output detected via flag");
}

// [5] selected input persistence
function t5() {
  console.log("\n[5] Selected input persistence");
  const store = memStore();
  const m = mgrWithDevices(store);
  const res = m.selectInputDevice("mic-hyperx-001");
  assert(res.ok === true, "valid mic selection accepted");
  assert(store._saved().selectedMicrophoneId === "mic-hyperx-001", "selectedMicrophoneId persisted");
  const m2 = new AudioDeviceManager(store);
  assert(m2.getSelectedMicId() === "mic-hyperx-001", "selection survives restart (reload from store)");
  assert(m2.getEffectiveMicDeviceId() === "mic-hyperx-001", "effective deviceId resolves for getUserMedia");
}

// [6] selected output persistence
function t6() {
  console.log("\n[6] Selected output persistence");
  const store = memStore();
  const m = mgrWithDevices(store);
  const res = m.selectOutputDevice("out-headphones-001");
  assert(res.ok === true, "valid output selection accepted");
  assert(store._saved().selectedOutputDeviceId === "out-headphones-001", "selectedOutputDeviceId persisted");
  const m2 = new AudioDeviceManager(store);
  assert(m2.getSelectedOutputId() === "out-headphones-001", "output selection survives restart");
}

// [7] unavailable selected device
function t7() {
  console.log("\n[7] Unavailable selected device");
  const m = mgrWithDevices();
  m.selectInputDevice("mic-usb-002");
  m.selectOutputDevice("out-hdmi-002");
  const res = m.handleDeviceChange([
    { id: "default", label: "", kind: "input", isDefault: true },
    { id: "mic-hyperx-001", label: "HyperX Cloud II Microphone", kind: "input" },
    { id: "default", label: "", kind: "output", isDefault: true },
  ]);
  assert(res.micInvalidated === true && res.outputInvalidated === true, "vanished selections flagged invalidated");
  const st = m.getState();
  assert(st.micStatus === "UNAVAILABLE" && st.micLabel === "DEVICE UNAVAILABLE", "mic shows DEVICE UNAVAILABLE (got " + st.micStatus + ")");
  assert(st.outputStatus === "UNAVAILABLE", "output shows UNAVAILABLE");
  assert(m.getSelectedMicId() === "mic-usb-002", "selection kept (return-to-default path available, no silent switch)");
  const back = m.resetToDefault("input");
  assert(back.selectedMicId === DEFAULT_DEVICE_ID && back.micStatus === "AVAILABLE", "return to Default Device restores AVAILABLE");
}

// [8] device refresh
function t8() {
  console.log("\n[8] Device refresh");
  const m = new AudioDeviceManager(memStore());
  const before = m.refreshDevices();
  assert(before.enumerated === false, "pre-enumeration refresh reports enumerated=false");
  m.updateDeviceList(INPUTS);
  const after = m.refreshDevices();
  assert(after.enumerated === true && after.snapshotAt > 0, "post-enumeration refresh reports snapshot");
}

// [9] devicechange handling
function t9() {
  console.log("\n[9] Devicechange handling");
  const m = mgrWithDevices();
  let threw = false;
  try {
    m.handleDeviceChange(undefined);
    m.handleDeviceChange([]);
  } catch (e) { threw = true; }
  assert(threw === false, "devicechange with missing/empty list never crashes");
  const res = m.handleDeviceChange([...INPUTS, ...OUTPUTS, { id: "mic-bt-009", label: "Bluetooth Headset", kind: "input" }]);
  assert(res.micInvalidated === false && m.listInputDevices().length === 4, "new device merged without invalidations");
}

// [10] microphone capture receives selected ID
function t10() {
  console.log("\n[10] Microphone capture receives selected ID");
  const m = mgrWithDevices();
  m.selectInputDevice("mic-hyperx-001");
  assert(m.getEffectiveMicDeviceId() === "mic-hyperx-001", "resolved config carries the selected id");
  m.resetToDefault("input");
  assert(m.getEffectiveMicDeviceId() === null, "default selection resolves to null (default device behavior preserved)");
  const cap = fs.readFileSync(path.join(dist, "renderer", "audio-capture.js"), "utf8");
  assert(cap.includes("micDevice") && cap.includes("deviceId") && cap.includes("exact"), "renderer applies selected deviceId as exact constraint");
  assert(cap.includes("DEVICE UNAVAILABLE"), "renderer reports vanished device explicitly");
  const mgrSrc = fs.readFileSync(path.join(dist, "main", "audio", "AudioManager.js"), "utf8");
  assert(mgrSrc.includes("micDevice"), "AudioManager forwards micDeviceId to the capture window");
}

// [11] system capture receives configured selection where supported (honest loopback)
function t11() {
  console.log("\n[11] System capture + output selection (honest loopback)");
  assert(typeof LOOPBACK_NOTE === "string" && /system mix/i.test(LOOPBACK_NOTE) && /does NOT retarget/i.test(LOOPBACK_NOTE),
    "compatibility note states loopback = system mix, selection does not retarget");
  const cap = fs.readFileSync(path.join(dist, "renderer", "audio-capture.js"), "utf8");
  assert(cap.includes("chromeMediaSource") && cap.includes("desktop"), "loopback still uses supported desktop-capture mechanism");
  const mgrSrc = fs.readFileSync(path.join(dist, "main", "audio", "AudioManager.js"), "utf8");
  assert(mgrSrc.includes("sysOutput"), "selected output label plumbed for reporting (not faked as capture control)");
  const settings = fs.readFileSync(path.join(dist, "renderer", "settings.js"), "utf8");
  assert(settings.includes("loopbackNote") || settings.includes("devices-note"), "Setup UI surfaces the loopback limitation");
}

// [12] invalid device handling
function t12() {
  console.log("\n[12] Invalid device handling");
  const m = mgrWithDevices();
  const r1 = m.selectInputDevice("no-such-mic");
  assert(r1.ok === false && m.getSelectedMicId() === DEFAULT_DEVICE_ID, "unknown mic id rejected, prior selection kept");
  const r2 = m.selectOutputDevice("no-such-output");
  assert(r2.ok === false, "unknown output id rejected");
  const r3 = m.selectInputDevice("");
  assert(r3.ok === true && m.getSelectedMicId() === DEFAULT_DEVICE_ID, "empty id resets to default (no hardcoded ids)");
}

// [13] no-device handling
function t13() {
  console.log("\n[13] No-device handling");
  const m = new AudioDeviceManager(memStore());
  assert(m.listInputDevices().length === 0 && m.getDefaultInput() === null, "empty lists: no inputs, null default");
  assert(m.getState().micStatus === "AVAILABLE", "default selection with no list stays AVAILABLE (default behavior)");
  m.selectInputDevice(DEFAULT_DEVICE_ID);
  const c = classifyAudioProbe({ streamCreated: false, rendererChunks: 0, mainChunks: 0, trackEnded: false, lastError: "" });
  assert(c.state === "NO FRAMES", "no-device probe path stays honest (NO FRAMES, never fake success)");
  assert(shortDeviceId("default") === "(default)", "default id displays as (default)");
  assert(shortDeviceId("mic-hyperx-001-long-identifier-xyz").length < "mic-hyperx-001-long-identifier-xyz".length, "long ids truncated for display");
  assert(sanitizeDeviceId("communications") === DEFAULT_DEVICE_ID, "'communications' pseudo-device normalizes to default");
  assert(displayLabel({ id: "x", label: "", kind: "input", isDefault: false }, 0) === "Microphone 1", "unlabeled devices degrade gracefully");
}

// [14] existing audio behavior preserved
function t14() {
  console.log("\n[14] Existing audio behavior preserved");
  const c1 = classifyAudioProbe({ streamCreated: true, rendererChunks: 0, mainChunks: 0, trackEnded: false, lastError: "" });
  assert(c1.state === "STREAM CREATED", "stream-without-frames still STREAM CREATED");
  const c2 = classifyAudioProbe({ streamCreated: true, rendererChunks: 5, mainChunks: 5, trackEnded: false, lastError: "" });
  assert(c2.state === "FRAMES RECEIVING", "frames still FRAMES RECEIVING");
  const cap = fs.readFileSync(path.join(dist, "renderer", "audio-capture.js"), "utf8");
  assert(cap.includes("URLSearchParams") && cap.includes("device-ended") && cap.includes("sendLevel"), "capture renderer keeps flags + device-end + levels");
  const preload = fs.readFileSync(path.join(dist, "preload", "overlay-preload.js"), "utf8");
  assert(preload.includes("audioDevicesGet") && preload.includes("audioDevicesSelectMic") && preload.includes("enumerateLocalDevices"),
    "preload exposes device selection without extra permissions");
}

async function main() {
  console.log("Intervia audio-device selection suite");
  t1(); t2(); t3(); t4(); t5(); t6(); t7(); t8(); t9(); t10(); t11(); t12(); t13(); t14();
  console.log("\n=================================");
  console.log(`DEVICE SUITE: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log("ALL DEVICE TESTS PASSED"); process.exit(0); }
  else { console.log("FAILED: " + failed); process.exit(1); }
}

main().catch((e) => { console.error("crashed", e); process.exit(2); });
