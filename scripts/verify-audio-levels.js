/* eslint-disable */
// Deterministic tests for the REAL audio level calculation.
//
// The previous meter failure mode was: chunks > 0, bytes > 0, live tracks,
// running AudioContext — but peak/rms/level all exactly 0. These tests pin:
//   (a) the DSP math (audio-dsp.js, required as the exact shipped file),
//   (b) the capture-graph wiring (tap before the mute gain, static proof),
//   (c) the end-to-end chain samples -> stats -> IPC payload -> meter value,
//   (d) the no-cheat contract (no random/fake levels anywhere).
//
// Plain Node. No microphone, no speakers, no randomness.

const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
// Require the EXACT shipped renderer file (not a copy): audio-dsp.js is
// plain JS with a module.exports guard so Node can load it directly.
const Dsp = require(path.join(root, "src", "renderer", "audio-dsp.js"));
const { makeLevelEvent, levelToDb } = require(path.join(dist, "main", "audio", "AudioLevel.js"));

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function approx(a, b, tol) {
  return Math.abs(a - b) <= tol;
}
function sine(n, amp, freq, sr) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr) * amp;
  return out;
}
function square(n, amp) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = i % 2 === 0 ? amp : -amp;
  return out;
}
function readSrc(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

// [1] all-zero samples -> floor.
function t1() {
  console.log("\n[1] All-zero samples -> -60 dB floor");
  const s = Dsp.computeFrameStats(new Float32Array(4000));
  assert(s.rms === 0 && s.peak === 0 && s.db === -60, "zeros give rms=0 peak=0 db=-60");
}

// [2] very quiet samples -> low negative dB.
function t2() {
  console.log("\n[2] Very quiet samples -> low negative dB");
  const s = Dsp.computeFrameStats(sine(4800, 0.01, 440, 48000));
  assert(s.db < -30 && s.db > -60, "0.01 sine lands low (" + s.db.toFixed(1) + " dB)");
  assert(approx(s.rms, 0.01 / Math.SQRT2, 0.002), "rms matches A/sqrt(2) (got " + s.rms.toFixed(4) + ")");
}

// [3] normal amplitude -> sensible dB.
function t3() {
  console.log("\n[3] Normal amplitude -> sensible dB");
  const s = Dsp.computeFrameStats(sine(4800, 0.2, 440, 48000));
  assert(s.db > -25 && s.db < -10, "0.2 sine is speech-like (" + s.db.toFixed(1) + " dB)");
}

// [4] loud samples -> higher dB.
function t4() {
  console.log("\n[4] Loud samples -> higher dB");
  const s = Dsp.computeFrameStats(sine(4800, 0.8, 440, 48000));
  assert(s.db > -10 && s.db <= 0, "0.8 sine is loud (" + s.db.toFixed(1) + " dB)");
}

// [5] full-scale samples -> ~0 dB.
function t5() {
  console.log("\n[5] Full-scale samples -> ~0 dB");
  const s = Dsp.computeFrameStats(square(4000, 1.0));
  assert(s.rms === 1 && s.peak === 1 && s.db === 0, "full-scale square gives 0 dB (got " + s.db + ")");
}

// [6] negative samples handled correctly.
function t6() {
  console.log("\n[6] Negative samples handled");
  const neg = new Float32Array([ -0.5, -0.25, -1, -0.1 ]);
  const pos = new Float32Array([ 0.5, 0.25, 1, 0.1 ]);
  const a = Dsp.computeFrameStats(neg);
  const b = Dsp.computeFrameStats(pos);
  assert(a.rms === b.rms && a.peak === b.peak && a.db === b.db, "sign-symmetric result");
  assert(a.peak === 1 && Number.isFinite(a.db), "negative peak detected, dB finite");
}

// [7] stereo handled correctly.
function t7() {
  console.log("\n[7] Stereo downmix handled");
  const L = new Float32Array([0.5, 0.5, 0.5]);
  const R = new Float32Array([-0.5, -0.5, -0.5]);
  const cancelled = Dsp.downmixToMono([L, R]);
  assert(cancelled.every((v) => v === 0), "opposite-phase stereo averages to silence (honest, not an error)");
  const same = Dsp.downmixToMono([L, L]);
  assert(same.every((v) => v === 0.5), "dual-mono preserved");
  const stereoStats = Dsp.computeFrameStats(Dsp.downmixToMono([sine(100, 0.4, 440, 48000), sine(100, 0.4, 440, 48000)]));
  assert(stereoStats.db > -20 && stereoStats.db < -5, "stereo speech-like content measures sensibly");
}

// [8] empty buffer -> safe result, no NaN.
function t8() {
  console.log("\n[8] Empty buffer safe");
  const s = Dsp.computeFrameStats(new Float32Array(0));
  assert(s.rms === 0 && s.peak === 0 && s.db === -60, "empty frame maps to floor");
  assert(Number.isFinite(s.rms) && Number.isFinite(s.peak) && Number.isFinite(s.db), "all finite");
  const m = Dsp.downmixToMono([]);
  assert(m.length === 0, "empty channel list -> empty mono");
}

// [9] NaN/Infinity input -> safe handling.
function t9() {
  console.log("\n[9] NaN/Infinity input safe");
  const s = Dsp.computeFrameStats(new Float32Array([NaN, Infinity, -Infinity, 0.5]));
  assert(Number.isFinite(s.rms) && Number.isFinite(s.peak) && Number.isFinite(s.db), "garbage samples stay finite");
  assert(s.db > -60, "one real sample still registers (got " + s.db.toFixed(1) + " dB)");
  const all = Dsp.computeFrameStats(new Float32Array([NaN, Infinity, -Infinity]));
  assert(all.rms === 0 && all.db === -60, "all-garbage frame maps to floor");
}

// [10] rapidly changing amplitude -> meter follows it.
function t10() {
  console.log("\n[10] Amplitude tracking (quiet -> loud -> quiet)");
  const q = Dsp.computeFrameStats(sine(4000, 0.02, 440, 48000)).db;
  const l = Dsp.computeFrameStats(sine(4000, 0.6, 440, 48000)).db;
  const q2 = Dsp.computeFrameStats(sine(4000, 0.02, 440, 48000)).db;
  assert(q < -30 && l > -12 && q2 < -30, "frames track: " + q.toFixed(0) + " -> " + l.toFixed(0) + " -> " + q2.toFixed(0) + " dB");
  assert(l - q > 15, "loud-vs-quiet separation is large (" + (l - q).toFixed(0) + " dB)");
}

// [11] PCM transport preserves non-zero signal (end of the renderer path).
function t11() {
  console.log("\n[11] Int16 transport preserves signal");
  const pcm = Dsp.floatToInt16PCM(sine(1600, 0.5, 440, 16000));
  assert(Dsp.pcmPeak(pcm) > 0.3, "sine survives float->int16 (peak " + Dsp.pcmPeak(pcm).toFixed(2) + ")");
  assert(Dsp.pcmPeak(new Int16Array(1600)) === 0, "digital silence stays zero (no phantom signal)");
  const edge = Dsp.floatToInt16PCM(new Float32Array([1, -1, 0, 2, -2]));
  assert(edge[0] === 32767 && edge[1] === -32768 && edge[2] === 0 && edge[3] === 32767 && edge[4] === -32768,
    "clipping conversion exact (1->32767, -1->-32768, clamp outside)");
}

// [12] END-TO-END: samples -> stats -> IPC payload -> meter value.
// Simulates a 48 kHz STEREO capture frame (the exact failing configuration:
// channels=2, sr=48000) and runs the production chain.
function t12() {
  console.log("\n[12] End-to-end: nonzero audio -> nonzero level -> moving meter");
  for (const amp of [0.02, 0.2, 0.7]) {
    const captured = [sine(4096, amp, 440, 48000), sine(4096, amp, 440, 48000)]; // stereo device frame
    const mono = Dsp.downmixToMono(captured);
    const frame = Dsp.resampleLinear(mono, 48000, 16000);
    const stats = Dsp.computeFrameStats(frame);
    const level = Math.max(0, Math.min(1, stats.rms * 3)); // capture renderer's exact scaling
    const evt = makeLevelEvent("microphone", level, level, 1, Date.now()); // main's exact enrichment
    const meterDb = levelToDb(evt.level); // Setup meter's exact display math
    assert(evt.level > 0 && evt.db > -60 && meterDb > -60,
      "amp=" + amp + " -> level=" + evt.level.toFixed(3) + " db=" + evt.db.toFixed(1) + " meter=" + meterDb.toFixed(0) + " dB (meter MOVES)");
  }
  const silent = Dsp.computeFrameStats(Dsp.downmixToMono([new Float32Array(4096), new Float32Array(4096)]));
  const silentEvt = makeLevelEvent("system", Math.max(0, Math.min(1, silent.rms * 3)), 0, 1, Date.now());
  assert(silentEvt.level === 0 && silentEvt.db === -60, "true silence still reads -60 dB (no phantom movement)");
}

// [13] Capture-graph order: tap BEFORE the mute gain (the actual root cause).
function t13() {
  console.log("\n[13] Capture graph taps raw source (root-cause regression lock)");
  const cap = readSrc("src/renderer/audio-capture.js");
  assert(cap.includes("sourceNode.connect(this.processor)"), "source feeds the processor directly");
  assert(cap.includes("this.processor.connect(this.mute)"), "processor feeds the mute gain");
  assert(cap.includes("this.mute.connect(ctx.destination)"), "mute gain feeds the speakers (silence out)");
  assert(!cap.includes("sourceNode.connect(this.gain)"), "NO zero-gain between source and processor (the old bug)");
  assert(!/this\.gain\.gain\.value\s*=\s*0/.test(cap), "old pre-tap mute gain is gone");
  const html = readSrc("src/renderer/audio-capture.html");
  const dspIdx = html.indexOf("audio-dsp.js");
  const capIdx = html.indexOf("audio-capture.js");
  assert(dspIdx !== -1 && capIdx !== -1 && dspIdx < capIdx, "audio-dsp.js loads before audio-capture.js");
  const distCap = fs.readFileSync(path.join(dist, "renderer", "audio-capture.js"), "utf8");
  assert(distCap.includes("sourceNode.connect(this.processor)"), "built renderer contains the fixed graph");
}

// [14] Probe + main distinguish SIGNAL vs SILENCE (no stream-exists PASS).
function t14() {
  console.log("\n[14] Probe reports SIGNAL DETECTED vs SILENT SIGNAL");
  const main = fs.readFileSync(path.join(dist, "main", "index.js"), "utf8");
  assert(main.includes("SIGNAL DETECTED") && main.includes("SILENT SIGNAL"), "probe classifies signal, not just frames");
  assert(main.includes("sumSq") && main.includes("rmsLevel"), "probe computes true RMS over all samples");
  const mgr = fs.readFileSync(path.join(dist, "main", "audio", "AudioManager.js"), "utf8");
  assert(mgr.includes("lastRms") && mgr.includes("lastDb"), "per-frame tap stats flow to diagnostics");
  const diag = fs.readFileSync(path.join(dist, "renderer", "diagnostics.js"), "utf8");
  assert(diag.includes("SIGNAL DETECTED"), "diagnostics surfaces the signal classification");
}

// [15] No-cheat contract: nothing random, nothing hardcoded, no fake movement.
function t15() {
  console.log("\n[15] No-cheat contract");
  for (const f of ["src/renderer/audio-dsp.js", "src/renderer/audio-capture.js", "src/renderer/settings.js", "src/main/audio/AudioLevel.ts"]) {
    const src = readSrc(f);
    assert(!src.includes("Math.random"), f + " contains no Math.random");
  }
  const settings = readSrc("src/renderer/settings.js");
  assert(!settings.includes("getUserMedia"), "Setup still opens no stream (levels come from the pipeline)");
  assert(!/-30 dB/.test(settings.replace(/-60 dB/g, "")), "no hardcoded fake dB in Setup");
  const dsp = readSrc("src/renderer/audio-dsp.js");
  assert(!/fetch|XMLHttpRequest|localStorage|writeFile/.test(dsp), "DSP has no network/storage side channels (privacy)");
}

// [16] Setup monitor: meters live while Setup is open, idle or not.
function t16() {
  console.log("\n[16] Setup monitor lifecycle (meters move without an interview)");
  const main = fs.readFileSync(path.join(dist, "main", "index.js"), "utf8");
  assert(main.includes("startMonitor") && main.includes("stopMonitor"), "monitor start/stop exist");
  assert(main.includes("maybeResumeMonitor"), "monitor resume helper exists");
  assert(main.includes("dev-null"), "monitor drops audio frames (levels-only, nothing fed anywhere)");
  const feeds = (main.match(/transcriptionManager\.feed/g) || []).length;
  assert(feeds === 1, "exactly one transcription feed (real capture only; monitor feeds nothing) — got " + feeds);
  assert(main.includes("getEffectiveMicDeviceId"), "monitor follows the selected microphone");
  const openIdx = main.indexOf("openSettingsWindow() {");
  assert(openIdx !== -1 && main.slice(openIdx, openIdx + 4000).includes("startMonitor"), "opening Setup starts the monitor");
  assert(main.includes("stopMonitor();") , "close/quit paths stop the monitor");
  const capIdx = main.indexOf("startCapture() {");
  assert(capIdx !== -1 && main.slice(capIdx, capIdx + 500).includes("stopMonitor"), "interview capture preempts the monitor first");
  assert(main.includes("hadMonitor"), "diagnostic probes pause + resume the monitor (never refuse because of it)");
  assert(main.includes("monitorActive") && main.includes("audioManager.isRunning"), "monitor yields whenever capture owns the window");
}

// [17] Mic reselection moves the meter to the CURRENT device.
function t17() {
  console.log("\n[17] Mic reselection restarts the monitor on the new device");
  const main = fs.readFileSync(path.join(dist, "main", "index.js"), "utf8");
  const selIdx = main.indexOf("intervia:audio-devices:select-mic");
  const selBlock = main.slice(selIdx, selIdx + 2500);
  assert(selBlock.includes("stopMonitor") && selBlock.includes("maybeResumeMonitor"), "select-mic restarts the live monitor");
  assert(!main.slice(main.indexOf("intervia:audio-devices:select-output"), main.indexOf("intervia:audio-devices:select-output") + 1200).includes("stopMonitor"),
    "output reselection needs no restart (loopback honesty preserved)");
}

async function main() {
  console.log("Intervia audio level-calculation suite (DSP + end-to-end)");
  t1(); t2(); t3(); t4(); t5(); t6(); t7(); t8(); t9(); t10();
  t11(); t12(); t13(); t14(); t15(); t16(); t17();
  console.log("\n=================================");
  console.log(`LEVEL SUITE: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log("ALL LEVEL TESTS PASSED"); process.exit(0); }
  else { console.log("FAILED: " + failed); process.exit(1); }
}

main().catch((e) => { console.error("crashed", e); process.exit(2); });
