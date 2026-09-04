/* eslint-disable */
// Validation-phase tests: fixes for real-machine reliability.
// - TranscriptionManager utterance-stable ids (partial/final merge, no dupes)
// - Dispatch epoch (no zombie transcripts after stop/restart)
// - Groq configured-model passthrough (fixture HTTP server)
// - Diagnostics export redaction (no secrets leak)
// - ScreenContextManager OCR swap + backend names
// - Static wiring checks for preload/renderer additions (headless-honest:
//   these assert the code paths exist, not that Electron renders them).

const path = require("path");
const fs = require("fs");
const http = require("http");
const dist = path.resolve(__dirname, "..", "dist");

const { TranscriptionManager } = require(path.join(dist, "main", "transcription", "TranscriptionManager.js"));
const { GroqWhisperProvider, buildMultipart } = require(path.join(dist, "main", "transcription", "providers", "GroqWhisperProvider.js"));
const { buildDiagnosticsExport, stripSecrets } = require(path.join(dist, "main", "reasoning", "diagnostics.js"));
const { ScreenContextManager } = require(path.join(dist, "main", "screen", "ScreenContextManager.js"));
const { MockOCRProvider, TesseractOCRProvider, createOCRProvider } = require(path.join(dist, "main", "screen", "ocr.js"));
const { MockVisionProvider } = require(path.join(dist, "main", "screen", "vision.js"));
const { InterviewContext } = require(path.join(dist, "main", "conversation", "InterviewContext.js"));
const { QuestionDetector } = require(path.join(dist, "main", "conversation", "QuestionDetector.js"));

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}

function loud(ms, freq) {
  const n = Math.floor((16000 * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * (freq || 440) * i) / 16000) * 0.4 * 32767);
  return out;
}
function quiet(ms) {
  return new Int16Array(Math.floor((16000 * ms) / 1000));
}
function deferredProvider() {
  const pending = [];
  return {
    provider: {
      name: "deferred",
      init: async () => {},
      shutdown: async () => {},
      transcribe: (req) => new Promise((res) => pending.push(() => res({ text: "hello world", isFinal: !req.partial, confidence: 0.9 }))),
    },
    pending,
  };
}

// [V1-V3] utterance-stable ids: partials + final of one segment share an id;
// the next segment gets a new id (InterviewContext can then merge, not dupe).
async function t_utteranceIds() {
  console.log("\n[V1-V3] Utterance-stable transcript ids");
  const mgr = new TranscriptionManager();
  await mgr.init();
  mgr.start();
  const events = [];
  mgr.on("transcript", (e) => events.push(e));
  mgr.feed("microphone", loud(2500)); // >= 2s threshold -> partial (mock: loud -> text)
  await new Promise((r) => setTimeout(r, 300));
  mgr.feed("microphone", loud(600)); // trailing speech stays buffered
  await new Promise((r) => setTimeout(r, 100));
  for (let i = 0; i < 10; i++) {
    mgr.feed("microphone", quiet(100));
    await new Promise((r) => setTimeout(r, 85));
  }
  await new Promise((r) => setTimeout(r, 1200));
  const finals = events.filter((e) => e.isFinal);
  const partials = events.filter((e) => !e.isFinal);
  assert(partials.length >= 1, "[V1] partial emitted, got " + partials.length);
  assert(finals.length >= 1, "[V2] final emitted after speech end, got " + finals.length);
  const ids = new Set(events.map((e) => e.id));
  assert(ids.size === 1, "[V3] partials + final share one utterance id (ids=" + ids.size + ")");
  const firstId = events[0].id;
  // Second utterance gets a fresh id.
  const mark = events.length;
  mgr.feed("microphone", loud(2500));
  await new Promise((r) => setTimeout(r, 300));
  mgr.feed("microphone", loud(600));
  for (let i = 0; i < 10; i++) {
    mgr.feed("microphone", quiet(100));
    await new Promise((r) => setTimeout(r, 85));
  }
  await new Promise((r) => setTimeout(r, 1200));
  const secondIds = new Set(events.slice(mark).map((e) => e.id));
  assert(!secondIds.has(firstId) && secondIds.size === 1, "[V3b] next utterance gets a new stable id");
  mgr.stop();
}

// [V4-V5] epoch: in-flight provider calls from before stop() never emit;
// manager keeps working after restart.
async function t_epoch() {
  console.log("\n[V4-V5] Dispatch epoch (zombie protection)");
  const { provider, pending } = deferredProvider();
  const mgr = new TranscriptionManager(provider);
  await mgr.init();
  mgr.start();
  const events = [];
  mgr.on("transcript", (e) => events.push(e));
  mgr.feed("microphone", loud(2500)); // partial dispatched, provider pending
  await new Promise((r) => setTimeout(r, 200));
  assert(pending.length >= 1, "[V4a] provider call in flight, pending=" + pending.length);
  mgr.stop(); // bumps epoch; buffer was drained by the partial -> no stop-flush
  pending.splice(0).forEach((fn) => fn()); // resolve everything late
  await new Promise((r) => setTimeout(r, 300));
  assert(events.length === 0, "[V4] pre-stop in-flight result dropped after stop (events=" + events.length + ")");
  mgr.start();
  mgr.feed("microphone", loud(2500));
  await new Promise((r) => setTimeout(r, 1100)); // past partial throttle + timer paths
  pending.splice(0).forEach((fn) => fn());
  await new Promise((r) => setTimeout(r, 300));
  assert(events.length >= 1, "[V5] manager works normally after restart (events=" + events.length + ")");
  mgr.stop();
}

// [V6] Groq sends the configured model (not a hardcoded one).
async function t_groqModel() {
  console.log("\n[V6] Groq model passthrough");
  let captured = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      captured = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "hola mundo", language: "es" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const g = new GroqWhisperProvider({ apiKey: "test-key", endpoint: `http://127.0.0.1:${port}`, model: "whisper-large-v3-turbo", timeoutMs: 8000 });
  await g.init();
  const out = await g.transcribe({ pcm: loud(300), sampleRate: 16000, partial: false });
  assert(out.text === "hola mundo", "[V6a] groq transcription round-trips");
  assert(captured && captured.includes("whisper-large-v3-turbo"), "[V6] configured model sent in multipart body");
  server.close();
  const built = buildMultipart(Buffer.from([1, 2, 3]), "a.wav", "custom-model-x");
  assert(built.body.toString("utf8").includes("custom-model-x"), "[V6b] multipart builder honors model");
}

// [V7-V9] diagnostics export redaction.
function t_redaction() {
  console.log("\n[V7-V9] Diagnostics export redaction");
  const nasty = {
    apiKey: "sk-test-SECRETABC123",
    nested: { token: "gsk_live_SECRETXYZ789", ok: 1 },
    headers: { Authorization: "Bearer MM-SECRET999" },
    note: "AIzaSECRETKEYDATA1234567890",
  };
  const stripped = stripSecrets(nasty);
  const s = JSON.stringify(stripped);
  assert(!s.includes("SECRETABC123") && !s.includes("SECRETXYZ789") && !s.includes("SECRET999") && !s.includes("AIzaSECRETKEYDATA"), "[V7] secrets stripped (keys, tokens, bearer)");
  assert(s.includes("[redacted]"), "[V7b] redaction marker present");
  const doc = buildDiagnosticsExport({
    appVersion: "1.0.0", electron: "32", node: "22", platform: "win32", release: "10", arch: "x64",
    exportedAt: 1, providers: [{ provider: "fast:mock-llm", model: "m", configured: true, reachable: true, streaming: "unsupported" }],
    transcription: { providerName: "whisper-server", status: "ready" },
    audio: { microphone: { level: 0.5, chunks: 10, at: 2 } },
    screen: { monitoring: false, ocr: "mock-ocr", tesseractInstalled: false, vision: "mock-vision", visionMode: "local" },
    session: { status: "none", questions: 0, answers: 0, avgFastMs: 0, avgStrongMs: 0 },
    candidate: { profileName: "Jane", mode: "real" },
    errors: [{ at: 3, source: "audio:microphone", message: "NotAllowedError: Permission denied" }],
    configNames: { sttProvider: "whisper-server", fastProvider: "sk-test-SECRETABC123" },
  });
  assert(!doc.includes("SECRETABC123"), "[V8] export builder redacts even config-name leaks");
  const parsed = JSON.parse(doc);
  assert(parsed.appVersion === "1.0.0" && parsed.transcription.providerName === "whisper-server" && parsed.errors.length === 1, "[V9] export keeps versions, statuses, errors");
}

// [V10-V11] OCR backend swap + names.
async function t_ocrSwap() {
  console.log("\n[V10-V11] OCR backend management");
  const cap = {
    async capturePrimaryDisplay() { throw new Error("nope"); },
    async captureRegion() { throw new Error("nope"); },
    startMonitoring() {}, stopMonitoring() {}, isMonitoring() { return false; }, cancelPending() {},
  };
  const mgr = new ScreenContextManager(cap, new MockOCRProvider(), new MockVisionProvider([]), new InterviewContext(), new QuestionDetector(), {});
  assert(mgr.getOcrName() === "mock-ocr" && mgr.getVisionName() === "mock-vision", "[V10] backend names reported");
  mgr.setOcrProvider(new TesseractOCRProvider());
  assert(mgr.getOcrName() === "tesseract", "[V11] OCR backend swappable at runtime (tesseract auto-upgrade path)");
  assert(createOCRProvider("tesseract").name === "tesseract", "[V11b] tesseract factory");
}

// [V12-V15] static wiring checks (headless-honest: existence of code paths).
function t_wiring() {
  console.log("\n[V12-V15] Static wiring checks");
  const preload = fs.readFileSync(path.join(dist, "preload", "overlay-preload.js"), "utf8");
  assert(preload.includes("diagnosticsExport") && preload.includes("diagnosticsAudioLevels"), "[V12] preload exposes export + audio levels");
  const audioPreload = fs.readFileSync(path.join(dist, "preload", "audio-capture-preload.js"), "utf8");
  assert(audioPreload.includes("sendLevel"), "[V12b] audio preload exposes level reporting");
  const cap = fs.readFileSync(path.join(dist, "renderer", "audio-capture.js"), "utf8");
  assert(cap.includes("URLSearchParams") && cap.includes("device-ended") && cap.includes("sendLevel"), "[V13] capture renderer: flags + device-end + levels");
  const diag = fs.readFileSync(path.join(dist, "renderer", "diagnostics.js"), "utf8");
  assert(diag.includes("diagnosticsExport") && diag.includes("levels-out"), "[V14] diagnostics UI: export + level meter");
  const main = fs.readFileSync(path.join(dist, "main", "index.js"), "utf8");
  const audioMgr = fs.readFileSync(path.join(dist, "main", "audio", "AudioManager.js"), "utf8");
  assert(audioMgr.includes("setPermissionRequestHandler") && main.includes("intervia:overlay:hide") && main.includes("getDisplayNearestPoint"), "[V15] main: media permission + overlay-hide + cursor-display selector");
}

async function main() {
  console.log("Intervia validation-phase suite (real-machine reliability fixes)");
  await t_utteranceIds();
  await t_epoch();
  await t_groqModel();
  t_redaction();
  await t_ocrSwap();
  t_wiring();
  console.log("\n=================================");
  console.log(`VALIDATION SUITE: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("ALL VALIDATION TESTS PASSED");
    process.exit(0);
  } else {
    console.log("FAILED: " + failed);
    process.exit(1);
  }
}

main().catch((e) => { console.error("crashed", e); process.exit(2); });
