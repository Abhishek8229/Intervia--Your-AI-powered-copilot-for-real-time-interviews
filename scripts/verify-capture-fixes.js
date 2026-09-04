/* eslint-disable */
// Deterministic regression tests for the real-Windows capture fixes.
//
// Covers: stream-created-vs-frames distinction, device-ended/disabled paths,
// invalid/missing sources, zero-byte vs valid frames, pipeline stage tracing,
// DPI conversion, manual region flow, mock OCR/vision with real frame bytes,
// explicit mock/real status labels, provider-unavailable states, redaction.
//
// Plain Node (no Electron): Electron-dependent paths fail cleanly and the
// pure classifiers/converters are exercised directly.

const path = require("path");
const fs = require("fs");
const dist = path.resolve(__dirname, "..", "dist");

const { classifyAudioProbe, pickSystemSource, sanitizeSourceName } = require(path.join(dist, "main", "audio", "AudioManager.js"));
const { ScreenCaptureManager, dipToPhysicalRegion, validatePhysicalRegion, sanitizeCaptureSourceName, hasNonZeroByte } = require(path.join(dist, "main", "screen", "ScreenCaptureManager.js"));
const { validateRegion } = require(path.join(dist, "main", "screen", "ChangeDetector.js"));
const { MockOCRProvider, FailingOCRProvider, TesseractOCRProvider } = require(path.join(dist, "main", "screen", "ocr.js"));
const { MockVisionProvider, FailingVisionProvider } = require(path.join(dist, "main", "screen", "vision.js"));
const { ScreenContextManager, ocrKindLabel } = require(path.join(dist, "main", "screen", "ScreenContextManager.js"));
const { InterviewContext } = require(path.join(dist, "main", "conversation", "InterviewContext.js"));
const { QuestionDetector } = require(path.join(dist, "main", "conversation", "QuestionDetector.js"));
const { providerModeLabel, stripSecrets } = require(path.join(dist, "main", "reasoning", "diagnostics.js"));

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}

function pngFrame(w, h, bytes, name) {
  const data = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) data[i] = (i * 31 + 7) % 251 + 1; // non-zero content
  return { id: "f-test", width: w, height: h, data, encoding: "png", timestamp: Date.now(), source: { kind: "display", id: "screen:1:0", name: name || "Screen 1" } };
}
function mockCapture(frames) {
  let i = 0;
  let monitoring = false;
  return {
    async capturePrimaryDisplay() { return frames[Math.min(i++, frames.length - 1)]; },
    async captureRegion(r) { const f = frames[Math.min(i++, frames.length - 1)]; return { ...f, region: { ...r } }; },
    startMonitoring() { monitoring = true; },
    stopMonitoring() { monitoring = false; },
    isMonitoring() { return monitoring; },
    cancelPending() {},
  };
}
function ocrResult(text) {
  return { text, blocks: text ? [{ text }] : [], confidence: text ? 0.9 : 0, timestamp: Date.now() };
}

// [1] stream created without frames is NOT success
function t1() {
  console.log("\n[1] Stream creation without frames");
  const c = classifyAudioProbe({ streamCreated: true, rendererChunks: 0, mainChunks: 0, trackEnded: false, lastError: "" });
  assert(c.state === "STREAM CREATED" && c.receiving === false, "stream-without-frames classifies STREAM CREATED, receiving=false (got " + c.state + ")");
}

// [2] stream receiving frames counts as success + renderer carries the real fixes
function t2() {
  console.log("\n[2] Stream receiving frames");
  const c = classifyAudioProbe({ streamCreated: true, rendererChunks: 120, mainChunks: 118, trackEnded: false, lastError: "" });
  assert(c.state === "FRAMES RECEIVING" && c.receiving === true, "frames classify FRAMES RECEIVING, receiving=true");
  const cap = fs.readFileSync(path.join(dist, "renderer", "audio-capture.js"), "utf8");
  assert(cap.includes("ctx.resume()") || cap.includes(".resume()"), "renderer resumes suspended AudioContext (hidden-window fix)");
  assert(cap.includes("chromeMediaSource") && cap.includes("maxWidth"), "renderer requests desktop video+audio together (loopback fix)");
  assert(cap.includes("no audio track"), "renderer reports missing-audio-track explicitly");
}

// [3] device-ended event
function t3() {
  console.log("\n[3] Device-ended event");
  const c = classifyAudioProbe({ streamCreated: true, rendererChunks: 40, mainChunks: 0, trackEnded: true, lastError: "" });
  assert(c.state === "ERROR" && c.receiving === false, "ended track with no main frames classifies ERROR (got " + c.state + ")");
  const cap = fs.readFileSync(path.join(dist, "renderer", "audio-capture.js"), "utf8");
  assert(cap.includes("device-ended") && cap.includes("devicechange"), "renderer watches ended + devicechange");
}

// [4] microphone disabled (permission denied, never started)
function t4() {
  console.log("\n[4] Microphone disabled");
  const denied = classifyAudioProbe({ streamCreated: false, rendererChunks: 0, mainChunks: 0, trackEnded: false, lastError: "NotAllowedError: Permission denied" });
  assert(denied.state === "ERROR", "denied mic classifies ERROR, never READY (got " + denied.state + ")");
  const silent = classifyAudioProbe({ streamCreated: false, rendererChunks: 0, mainChunks: 0, trackEnded: false, lastError: "" });
  assert(silent.state === "NO FRAMES", "never-started mic is NO FRAMES, never READY-misleading");
}

// [5] system audio disabled
function t5() {
  console.log("\n[5] System audio disabled");
  const c = classifyAudioProbe({ streamCreated: false, rendererChunks: 0, mainChunks: 0, trackEnded: false, lastError: "no system source available" });
  assert(c.state === "ERROR" && c.receiving === false, "missing loopback source classifies ERROR");
}

// [6] invalid source id
function t6() {
  console.log("\n[6] Invalid source id");
  assert(pickSystemSource([]) === null, "empty source list -> null (no blind source 0)");
  assert(pickSystemSource(null) === null, "null source list -> null");
}

// [7] no desktop source
function t7() {
  console.log("\n[7] No desktop source");
  const picked = pickSystemSource([{ id: "window:1:0", name: "Some Window" }]);
  assert(picked && picked.id === "window:1:0", "window-only fallback is explicit, deterministic (got " + (picked && picked.id) + ")");
  const pref = pickSystemSource([
    { id: "screen:2:0", name: "Screen 2" },
    { id: "screen:1:0", name: "Screen 1" },
  ]);
  assert(pref && pref.id === "screen:1:0", "multi-monitor pick prefers Screen 1 deterministically (got " + (pref && pref.id) + ")");
}

// [8] capture frame with zero bytes
async function t8() {
  console.log("\n[8] Zero-byte frame");
  const empty = { id: "f0", width: 480, height: 270, data: Buffer.alloc(0), encoding: "png", timestamp: Date.now(), source: { kind: "display", id: "screen:1:0", name: "Screen 1" } };
  assert(hasNonZeroByte(empty.data) === false, "zero-byte frame detected as empty");
  const cap = mockCapture([empty]);
  const mgr = new ScreenContextManager(cap, new MockOCRProvider(), new MockVisionProvider([]), new InterviewContext(), new QuestionDetector(), { minEventGapMs: 0 });
  const trace = await mgr.runDiagnosticTrace();
  assert(trace.capture.ok === false && trace.capture.bytes === 0, "trace reports capture failure honestly (ok=false, 0 bytes)");
  assert(trace.pass === false && trace.failureStage !== null, "trace marks pass=false with failureStage=" + trace.failureStage);
  assert(trace.event.emitted === false, "no ScreenContextEvent on empty frame");
}

// [9] valid captured frame end to end
async function t9() {
  console.log("\n[9] Valid captured frame");
  const f = pngFrame(480, 270, 4096);
  assert(hasNonZeroByte(f.data) === true, "valid frame has non-zero content");
  const cap = mockCapture([f]);
  const mgr = new ScreenContextManager(cap, new MockOCRProvider(), new MockVisionProvider([]), new InterviewContext(), new QuestionDetector(), { minEventGapMs: 0 });
  let emitted = null;
  mgr.on("screen-context", (e) => { emitted = e; });
  const trace = await mgr.runDiagnosticTrace();
  assert(trace.source.found === true, "trace: source FOUND");
  assert(trace.capture.ok === true && trace.capture.width === 480 && trace.capture.bytes === 4096, "trace: capture SUCCESS 480x270 4096B");
  assert(trace.event.emitted === true && emitted !== null, "trace: ScreenContextEvent EMITTED");
  assert(trace.pass === true, "trace: pass=true on valid frame");
}

// [10] screen pipeline stage diagnostics shape
async function t10() {
  console.log("\n[10] Pipeline stage diagnostics");
  const cap = mockCapture([pngFrame(480, 270, 2048)]);
  const mgr = new ScreenContextManager(cap, new MockOCRProvider(), new MockVisionProvider([]), new InterviewContext(), new QuestionDetector(), { minEventGapMs: 0 });
  const t = await mgr.runDiagnosticTrace();
  const stages = ["source", "capture", "change", "ocr", "vision", "event"];
  assert(stages.every((k) => t[k] !== undefined), "trace has all stages (source/capture/change/ocr/vision/event)");
  assert(t.ocr.provider === "mock-ocr" && t.ocr.call === "EXECUTED", "trace: OCR provider + call recorded");
  assert(typeof t.failureStage === "string" || t.failureStage === null, "trace: failureStage exact-or-null");
  assert(t.change.verdict === "CHANGED" && t.change.reason === "first-frame", "trace: first frame CHANGED/first-frame");
  const t2 = await mgr.runDiagnosticTrace();
  assert(t2.change.verdict === "UNCHANGED", "trace: identical repeat frame UNCHANGED (got " + t2.change.verdict + ")");
}

// [11] DPI coordinate conversion (physical machine: 2048x1152 @1.25)
function t11() {
  console.log("\n[11] DPI coordinate conversion");
  const disp = { id: 1, bounds: { x: 0, y: 0, width: 1638, height: 922 }, scaleFactor: 1.25 };
  const m = dipToPhysicalRegion({ x: 0, y: 0, width: 800, height: 600 }, disp);
  assert(m.physical.width === 1000 && m.physical.height === 750, "800x600 DIP @1.25 -> 1000x750 physical (got " + m.physical.width + "x" + m.physical.height + ")");
  const m2 = dipToPhysicalRegion({ x: 100, y: 50, width: 200, height: 100 }, disp);
  assert(m2.physical.x === 125 && m2.physical.y === 62, "origin scales by 1.25 (got " + m2.physical.x + "," + m2.physical.y + ")");
  const ok = validatePhysicalRegion(m.physical, { width: 2048, height: 1152 });
  assert(ok.ok === true, "converted region validates against 2048x1152 physical");
  const bad = validatePhysicalRegion({ x: 2000, y: 1100, width: 500, height: 500 }, { width: 2048, height: 1152 });
  assert(bad.ok === false && bad.reason === "region-out-of-bounds", "out-of-bounds physical region rejected");
}

// [12] manual region selection flow
async function t12() {
  console.log("\n[12] Manual region selection");
  const v = validateRegion({ x: 10, y: 10, width: 200, height: 100 }, { width: 1638, height: 922 });
  assert(v.ok === true, "valid DIP selection accepted");
  const cap = mockCapture([pngFrame(480, 270, 1024)]);
  const mgr = new ScreenContextManager(cap, new MockOCRProvider([ocrResult("Write a function to reverse a linked list in place.")]), new MockVisionProvider([]), new InterviewContext(), new QuestionDetector(), { minEventGapMs: 0 });
  const ev = await mgr.captureManualRegion({ x: 5, y: 5, width: 300, height: 200 });
  assert(ev !== null && ev.region && ev.region.width === 300, "region preserved through pipeline");
  assert(mgr.lastFrameInfo && mgr.lastFrameInfo.bytes === 1024, "frame metadata recorded for region report");
}

// [13] screen context emission
async function t13() {
  console.log("\n[13] Screen context emission");
  const cap = mockCapture([pngFrame(480, 270, 1024)]);
  const ctx = new InterviewContext();
  const mgr = new ScreenContextManager(cap, new MockOCRProvider([ocrResult("Q3 revenue dashboard, total $1.2M")]), new MockVisionProvider([]), ctx, new QuestionDetector(), { minEventGapMs: 0 });
  let got = null;
  mgr.on("screen-context", (e) => { got = e; });
  const ev = await mgr.captureManualRegion({ x: 0, y: 0, width: 50, height: 50 });
  assert(got !== null && got.id === (ev && ev.id), "screen-context emitted with matching id");
  assert(ctx.recentScreen(5).length === 1, "event stored in interview context");
}

// [14] mock OCR with real frame input
async function t14() {
  console.log("\n[14] Mock OCR with real frame input");
  const mock = new MockOCRProvider();
  const f = pngFrame(480, 270, 5000);
  const r = await mock.recognize({ data: f.data, encoding: "png", width: f.width, height: f.height });
  assert(r.text.includes("[mock-ocr") && r.text.includes("480x270") && r.text.includes("5000"), "mock OCR labels frame honestly with dims+bytes (" + r.text.slice(0, 60) + "…)");
  assert(mock.lastInputBytes === 5000, "frame bytes provably reached the adapter");
  const r2 = await mock.recognize({ data: Buffer.alloc(0), encoding: "png" });
  assert(!r2.text, "zero-byte input still yields no text (no fake success)");
}

// [15] mock vision with real frame input
async function t15() {
  console.log("\n[15] Mock vision with real frame input");
  const mv = new MockVisionProvider([]);
  const out = await mv.analyzeImage({ data: pngFrame(100, 100, 512).data });
  assert(out.providerName === "mock-vision" && out.summary.length > 0, "mock vision returns labeled summary");
  assert(mv.lastImageBytes === 512, "image bytes provably reached the adapter");
  let threw = false;
  try { await mv.analyzeImage({ data: Buffer.alloc(0) }); } catch (e) { threw = true; }
  assert(threw === true, "empty image fails explicitly instead of fake success");
  let threw2 = false;
  try { await new FailingVisionProvider().analyzeImage({ data: Buffer.alloc(8) }); } catch (e) { threw2 = true; }
  assert(threw2 === true, "failing vision rejects cleanly");
}

// [16] explicit mock/real status
function t16() {
  console.log("\n[16] Explicit mock/real status");
  assert(providerModeLabel("mock-llm", "m") === "MOCK (m)", "mock labeled MOCK");
  assert(providerModeLabel("gemini-llm", "gemini-2.0-flash").startsWith("REAL GEMINI"), "gemini labeled REAL GEMINI");
  assert(providerModeLabel("minimax-llm", "MiniMax-M2").startsWith("REAL MINIMAX"), "minimax labeled REAL MINIMAX");
  assert(providerModeLabel("", "") === "NOT CONFIGURED", "empty provider is NOT CONFIGURED");
  assert(ocrKindLabel("mock-ocr", true) === "MOCK OCR", "mock OCR labeled");
  assert(ocrKindLabel("tesseract", true) === "REAL OCR", "tesseract labeled REAL");
  assert(ocrKindLabel("mock-ocr", false) === "UNAVAILABLE", "unavailable OCR explicit");
}

// [17] provider-unavailable state
async function t17() {
  console.log("\n[17] Provider-unavailable state");
  const tess = new TesseractOCRProvider();
  const avail = await tess.isAvailable();
  assert(typeof avail === "boolean", "tesseract probe returns boolean (installed=" + avail + ")");
  const cap = mockCapture([pngFrame(480, 270, 1024)]);
  const mgr = new ScreenContextManager(cap, new FailingOCRProvider(), new MockVisionProvider([]), new InterviewContext(), new QuestionDetector(), { minEventGapMs: 0 });
  const failures = [];
  mgr.on("screen-failure", (f) => { failures.push(f); });
  const ev = await mgr.captureManualRegion({ x: 0, y: 0, width: 10, height: 10 });
  assert(ev === null, "failing OCR yields no event (no fake success)");
  assert(failures.some((f) => f && f.stage === "ocr"), "OCR failure enters screen-failure channel with stage=ocr");
}

// [18] diagnostics secret redaction
function t18() {
  console.log("\n[18] Diagnostics secret redaction");
  const payload = {
    source: "system",
    device: "Speakers",
    config: { apiKey: "sk-live-SECRETABC123", endpoint: "https://x" },
    headers: { Authorization: "Bearer MM-SECRET999" },
    note: "AIzaSECRETKEYDATA1234567890",
  };
  const s = JSON.stringify(stripSecrets(payload));
  assert(!s.includes("SECRETABC123") && !s.includes("SECRET999") && !s.includes("AIzaSECRETKEYDATA"), "keys/tokens redacted from diagnostics payload");
  assert(s.includes("Speakers") && s.includes("system"), "non-secret diagnostics preserved");
  assert(sanitizeSourceName("Screen 1\ninjected") === "Screen 1 injected", "source names sanitized");
}

async function main() {
  console.log("Intervia real-capture fix suite (stream-vs-frames, screen trace, DPI, labels)");
  t1(); t2(); t3(); t4(); t5(); t6(); t7();
  await t8(); await t9(); await t10();
  t11(); await t12(); await t13(); await t14(); await t15();
  t16(); await t17(); t18();
  console.log("\n=================================");
  console.log(`CAPTURE-FIX SUITE: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log("ALL CAPTURE-FIX TESTS PASSED"); process.exit(0); }
  else { console.log("FAILED: " + failed); process.exit(1); }
}

main().catch((e) => { console.error("crashed", e); process.exit(2); });
