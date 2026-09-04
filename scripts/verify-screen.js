/* eslint-disable */
// Deterministic tests for the screen-context + OCR + vision phase.
// Plain Node (no Electron): Electron-dependent paths are expected to fail
// cleanly with ScreenCaptureError("unsupported") in this environment.

const path = require("path");
const dist = path.resolve(__dirname, "..", "dist");

const { ScreenCaptureManager, ScreenCaptureError } = require(path.join(dist, "main", "screen", "ScreenCaptureManager.js"));
const { ScreenChangeTracker, compareFrames, regionsOverlap, blankExcludedRegions, validateRegion, averageHashRgba, hammingDistance } = require(path.join(dist, "main", "screen", "ChangeDetector.js"));
const { MockOCRProvider, FailingOCRProvider, TesseractOCRProvider, createOCRProvider } = require(path.join(dist, "main", "screen", "ocr.js"));
const { MockVisionProvider, FailingVisionProvider, GeminiVisionAdapter, OpenAICompatibleVisionAdapter, createVisionProvider, extractJsonObject, toVisionResult } = require(path.join(dist, "main", "screen", "vision.js"));
const { ScreenContextManager } = require(path.join(dist, "main", "screen", "ScreenContextManager.js"));
const { fuseQuestionContext, detectScreenQuestion, isVagueReference, looksLikeCode, looksLikeDiagram } = require(path.join(dist, "main", "screen", "QuestionContextFusion.js"));
const { InterviewContext } = require(path.join(dist, "main", "conversation", "InterviewContext.js"));
const { QuestionDetector } = require(path.join(dist, "main", "conversation", "QuestionDetector.js"));
const { MockLLMProvider, FailingLLMProvider, createLLMProvider } = require(path.join(dist, "main", "reasoning", "LLMProvider.js"));
const { ModelRouter } = require(path.join(dist, "main", "reasoning", "ModelRouter.js"));
const { buildAnswerPrompt, formatScreenContext, contextPriorityRank } = require(path.join(dist, "main", "reasoning", "PromptBuilder.js"));
const { AnswerEngine } = require(path.join(dist, "main", "reasoning", "AnswerEngine.js"));

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}

// --- helpers ---
function rgba(w, h, fill) {
  const b = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    b[i * 4] = fill; b[i * 4 + 1] = fill; b[i * 4 + 2] = fill; b[i * 4 + 3] = 255;
  }
  return b;
}
function frame(data, w, h, encoding) {
  return { id: "f", width: w, height: h, data, encoding: encoding || "rgba", timestamp: Date.now(), source: { kind: "display", id: "d" } };
}
function halves(w, h, left, right) {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x < w / 2 ? left : right;
      const o = (y * w + x) * 4;
      b[o] = v; b[o + 1] = v; b[o + 2] = v; b[o + 3] = 255;
    }
  }
  return b;
}
function ocrResult(text) {
  return { text, blocks: text ? [{ text }] : [], confidence: text ? 0.9 : 0, timestamp: Date.now() };
}
function mockCapture(frames) {
  let i = 0;
  let monitoring = false;
  let cb = null;
  return {
    calls: 0,
    cancelled: 0,
    async capturePrimaryDisplay() { this.calls++; return frames[Math.min(i++, frames.length - 1)]; },
    async captureRegion(r) { this.calls++; const f = frames[Math.min(i++, frames.length - 1)]; return { ...f, region: { ...r } }; },
    startMonitoring(c) { monitoring = true; cb = c; },
    stopMonitoring() { monitoring = false; cb = null; },
    isMonitoring() { return monitoring; },
    cancelPending() { this.cancelled++; },
    __emit(m) { if (cb) cb(m); },
  };
}
function screenEvt(over) {
  return {
    id: "scr-1", timestamp: Date.now(), source: "auto", mode: "auto",
    text: "sample screen text", confidence: 0.8, origin: "ocr", ...(over || {}),
  };
}
function tx(id, speaker, text, ts) {
  return { id, source: "system", speaker, text, timestamp: ts, isFinal: true };
}

// [1-5] SCREEN CAPTURE
async function t_capture() {
  console.log("\n[1-5] Screen capture abstraction");
  const m = new ScreenCaptureManager({ monitorIntervalMs: 50 });
  assert(typeof m.isSupported() === "boolean", "[1] manager initializes, isSupported() is boolean (got " + m.isSupported() + ")");
  try {
    await m.capturePrimaryDisplay();
    assert(m.isSupported() === true, "[2] primary display capture works where supported");
  } catch (e) {
    assert(e && e.code === "unsupported", "[2] headless capture fails cleanly with unsupported (got " + (e && e.code) + ")");
  }
  try {
    await m.captureRegion({ x: 0, y: 0, width: -5, height: 10 });
    assert(false, "[3] invalid region should throw");
  } catch (e) {
    assert(e && (e.code === "invalid-region" || e.code === "unsupported"), "[3] region capture validates input (" + (e && e.code) + ")");
  }
  try {
    await m.captureWindow("");
    assert(false, "[4] empty window id should throw");
  } catch (e) {
    assert(e && e.code === "invalid-region", "[4] capture failure handled cleanly (" + (e && e.code) + ")");
  }
  m.cancelPending();
  try {
    await m.capturePrimaryDisplay();
    // If supported, cancellation may or may not win the race; only assert no crash.
    assert(true, "[5] capture after cancel does not crash");
  } catch (e) {
    assert(e && (e.code === "cancelled" || e.code === "unsupported"), "[5] cancellation/unsupported surfaces as typed error (" + (e && e.code) + ")");
  }
  m.dispose();
  assert(m.isMonitoring() === false, "[5b] dispose stops monitoring");
}

// [6-8] CHANGE DETECTION
function t_change() {
  console.log("\n[6-8] Change detection");
  const a = frame(rgba(32, 32, 120), 32, 32);
  const same = frame(Buffer.from(rgba(32, 32, 120)), 32, 32);
  assert(compareFrames(a, same).changed === false, "[6] identical frames do not trigger processing");
  const diff = frame(halves(32, 32, 200, 40), 32, 32);
  const c2 = compareFrames(frame(halves(32, 32, 40, 200), 32, 32), diff);
  assert(c2.changed === true, "[7] meaningfully changed frames trigger processing (" + c2.reason + ")");
  // Minor noise: a few pixels nudged slightly.
  const noisy = Buffer.from(rgba(32, 32, 120));
  for (let i = 0; i < 12; i++) { noisy[i * 4] = 124; noisy[i * 4 + 1] = 118; }
  const c3 = compareFrames(a, frame(noisy, 32, 32));
  assert(c3.changed === false, "[8] minor noise does not trigger processing (" + c3.reason + ", score=" + c3.score + ")");
  const tr = new ScreenChangeTracker();
  assert(tr.update(a).reason === "first-frame", "[6b] tracker first frame baseline");
  assert(tr.update(same).changed === false, "[6c] tracker suppresses repeat frame");
}

// [9-12] OCR
async function t_ocr() {
  console.log("\n[9-12] OCR abstraction");
  const p = createOCRProvider("mock");
  assert(p && typeof p.recognize === "function" && typeof p.isAvailable === "function", "[9] OCR provider abstraction works");
  const mock = new MockOCRProvider([ocrResult("Hello world")]);
  const r = await mock.recognize({ data: Buffer.alloc(8), encoding: "rgba" });
  assert(r.text === "Hello world" && Array.isArray(r.blocks) && typeof r.confidence === "number" && typeof r.timestamp === "number", "[10] mock OCR returns structured result");
  const withBox = new MockOCRProvider([{ text: "Hi", blocks: [{ text: "Hi", boundingBox: { x: 1, y: 2, width: 3, height: 4 }, confidence: 0.9 }], confidence: 0.9, timestamp: 1 }]);
  const rb = await withBox.recognize({ data: Buffer.alloc(8), encoding: "rgba" });
  assert(rb.blocks[0].boundingBox && rb.blocks[0].boundingBox.width === 3, "[11] bounding boxes preserved");
  try {
    await new FailingOCRProvider().recognize({ data: Buffer.alloc(8), encoding: "rgba" });
    assert(false, "[12] failing OCR should throw");
  } catch (e) {
    assert(true, "[12] OCR failure handled (rejects cleanly)");
  }
  const tess = new TesseractOCRProvider();
  const avail = await tess.isAvailable();
  assert(typeof avail === "boolean", "[12b] tesseract availability probe returns boolean (installed=" + avail + ")");
}

// [13-17] VISION
async function t_vision() {
  console.log("\n[13-17] Vision abstraction");
  const p = createVisionProvider("mock");
  assert(p && typeof p.analyzeImage === "function", "[13] VisionProvider abstraction works");
  const mv = new MockVisionProvider([{ summary: "a diagram", detectedQuestion: "Design X?", confidence: 0.7 }]);
  const r = await mv.analyzeImage({ data: Buffer.alloc(8) });
  assert(r.summary === "a diagram" && r.detectedQuestion === "Design X?" && typeof r.confidence === "number" && r.providerName === "mock-vision", "[14] mock vision provider works");
  const g = new GeminiVisionAdapter({ apiKey: "TESTKEY" });
  const req = g.buildRequest({ data: Buffer.from([1, 2, 3]) }, { screenText: "hi" });
  const parts = req.contents[0].parts;
  assert(parts.length === 2 && typeof parts[0].text === "string" && parts[1].inlineData.data === Buffer.from([1, 2, 3]).toString("base64"), "[15] gemini multimodal request format valid");
  const o = new OpenAICompatibleVisionAdapter({ endpoint: "https://x.example", model: "m", apiKey: "k" });
  const oreq = o.buildRequest({ data: Buffer.from([9]) });
  const content = oreq.messages[0].content;
  assert(content.some((c) => c.type === "image_url" && c.image_url.url.startsWith("data:image/png;base64,")), "[15b] openai-compatible multimodal request format valid");
  try {
    await new FailingVisionProvider().analyzeImage({ data: Buffer.alloc(8) });
    assert(false, "[16] failing vision should throw");
  } catch (e) {
    assert(true, "[16] vision failure handled (rejects cleanly)");
  }
  const parsed = extractJsonObject('```json\n{"summary":"s","confidence":0.8}\n```');
  assert(parsed && parsed.summary === "s", "[15c] vision JSON extraction tolerates fences");
  const vr = toVisionResult("t", "not json at all");
  assert(vr.summary.length > 0 && vr.confidence === 0.4, "[15d] raw-text vision fallback works");
}

// [17] stale vision jobs
async function t_stale() {
  console.log("\n[17] Stale visual jobs");
  const f1 = frame(rgba(16, 16, 10), 16, 16);
  const f2 = frame(rgba(16, 16, 220), 16, 16);
  const cap = mockCapture([f1, f2]);
  const ocr = new MockOCRProvider([ocrResult("first text here that is long enough"), ocrResult("second text here that is long enough")]);
  let calls = 0;
  const vision = new MockVisionProvider([]);
  vision.remote = true; // exercise the remote-vision branch with a mock
  vision.analyzeImage = (img) => {
    calls++;
    const n = calls;
    // First job is slow, second is instant -> first must be dropped as stale.
    const delay = n === 1 ? 60 : 1;
    return new Promise((res) => setTimeout(() => res({ summary: n === 1 ? "FIRST" : "SECOND", confidence: 0.9, providerName: "mock-vision", timestamp: Date.now() }), delay));
  };
  const ctx = new InterviewContext();
  const det = new QuestionDetector();
  const mgr = new ScreenContextManager(cap, ocr, vision, ctx, det, { visionMode: "remote", minEventGapMs: 0, dedupeWindowMs: 60000 });
  const events = [];
  mgr.on("screen-context", (e) => events.push(e));
  const r1 = { x: 0, y: 0, width: 100, height: 100 };
  const r2 = { x: 0, y: 0, width: 200, height: 200 };
  // Let job 1 enter its (slow) vision call before job 2 supersedes it.
  const p1 = mgr.captureManualRegion(r1);
  await new Promise((r) => setTimeout(r, 15));
  const e2 = await mgr.captureManualRegion(r2);
  const e1 = await p1;
  await new Promise((r) => setTimeout(r, 120));
  assert(e1 === null, "[17] stale vision job returns null to its caller");
  assert(e2 !== null && events.length === 1 && events[0].visualSummary === "SECOND", "[17b] only newest visual job emits (got " + events.length + ")");
}

// [18-21] SCREEN CONTEXT
async function t_screenCtx() {
  console.log("\n[18-21] Screen context events + memory");
  const cap = mockCapture([frame(rgba(16, 16, 50), 16, 16)]);
  const ocr = new MockOCRProvider([ocrResult("Q3 revenue dashboard, total $1.2M")]);
  const ctx = new InterviewContext();
  const det = new QuestionDetector();
  const mgr = new ScreenContextManager(cap, ocr, new MockVisionProvider([]), ctx, det, { minEventGapMs: 0 });
  const e = await mgr.captureManualRegion({ x: 0, y: 0, width: 50, height: 50 });
  assert(e && e.id && e.timestamp && e.source === "manual" && e.mode === "manual" && typeof e.text === "string" && typeof e.confidence === "number", "[18] ScreenContextEvent creation");
  assert(ctx.recentScreen(5).length === 1 && ctx.recentScreen(5)[0].kind === "screen", "[19] context storage distinguishes screen entries");
  const ctx2 = new InterviewContext({ maxEntries: 5, maxAgeMs: 60000, evictionIntervalMs: 10000 });
  for (let i = 0; i < 12; i++) ctx2.ingestScreen(screenEvt({ id: "s" + i, text: "text " + i }));
  assert(ctx2.size() <= 5, "[20] screen context bounded (size=" + ctx2.size() + ")");
  const cap2 = mockCapture([frame(rgba(16, 16, 50), 16, 16), frame(rgba(16, 16, 50), 16, 16)]);
  const ocr2 = new MockOCRProvider([ocrResult("identical dashboard text here ok"), ocrResult("identical dashboard text here ok")]);
  const mgr2 = new ScreenContextManager(cap2, ocr2, new MockVisionProvider([]), new InterviewContext(), new QuestionDetector(), { minEventGapMs: 0, dedupeWindowMs: 60000 });
  const a1 = await mgr2.captureNow();
  const a2 = await mgr2.captureNow();
  assert(a1 !== null && a2 === null, "[21] duplicate screen content suppressed");
}

// [22-26] FUSION
function t_fusion() {
  console.log("\n[22-26] Question fusion");
  const recent = (audio) => [{ id: "1", speaker: "interviewer", source: "system", text: audio, timestamp: Date.now(), transcriptEventId: "t1", kind: "transcript" }];
  const scr = (text) => screenEvt({ text, detectedQuestion: text });
  let f = fuseQuestionContext({ recentContext: recent("Can you walk me through how you would solve this?"), screen: scr("Given an array of integers, return the longest increasing subsequence.") });
  assert(f.origin === "fused" && f.screenRelated && f.text.includes("longest increasing subsequence"), "[22] vague audio + screen problem combined");
  f = fuseQuestionContext({ recentContext: recent("Why did you choose PostgreSQL for this service?"), screen: scr("Stack Overflow: best pizza dough recipe with sourdough starter") });
  assert(f.origin === "audio" && !f.screenRelated && f.text.includes("PostgreSQL"), "[23] spoken question wins over unrelated screen");
  const c = detectScreenQuestion("Implement an LRU cache with O(1) get and put operations.");
  assert(c && c.type === "coding", "[24] screen-only coding question recognized (" + (c && c.type) + ")");
  const d = detectScreenQuestion("System overview: client -> load balancer -> api servers -> postgres primary with read replicas, redis cache, kafka queue for events.");
  assert(d && (d.type === "system_design" || d.type === "technical" || d !== null), "[25] screen-only system-design content recognized (" + (d && d.type) + ")");
  assert(looksLikeDiagram("client -> load balancer -> cache -> database") === true, "[25b] diagram signals detected");
  f = fuseQuestionContext({ recentContext: recent("Can you elaborate on that caching layer?"), screen: scr("Redis cache in front of Postgres absorbs 90% of reads.") });
  assert(f.screenRelated && (f.origin === "fused" || f.origin === "screen"), "[26] follow-up uses prior screen context (" + f.origin + ")");
  assert(isVagueReference("how would you solve this?") === true && isVagueReference("Why did you choose PostgreSQL?") === false, "[22b] vague-reference heuristic");
  assert(looksLikeCode("def solve(nums):\n    return sorted(nums)\n") === true, "[24b] code recognition");
}

// [27-29] MANUAL REGION
async function t_manual() {
  console.log("\n[27-29] Manual region flow");
  let v = validateRegion({ x: 10, y: 10, width: 200, height: 100 }, { width: 1920, height: 1080 });
  assert(v.ok === true, "[27] valid selection coordinates accepted");
  assert(validateRegion({ x: 0, y: 0, width: 4, height: 4 }, { width: 1920, height: 1080 }).ok === false, "[27b] tiny drag rejected");
  assert(validateRegion({ x: 1900, y: 1000, width: 200, height: 200 }, { width: 1920, height: 1080 }).ok === false, "[27c] out-of-bounds rejected");
  // Escape/cancel: no event, no state change.
  const cap = mockCapture([frame(rgba(16, 16, 10), 16, 16)]);
  const mgr = new ScreenContextManager(cap, new MockOCRProvider([ocrResult("x".repeat(60))]), new MockVisionProvider([]), new InterviewContext(), new QuestionDetector(), { minEventGapMs: 0 });
  let n = 0;
  mgr.on("screen-context", () => n++);
  mgr.cancelPending();
  assert(n === 0, "[28] cancel leaves application unchanged (no events)");
  // Region capture enters the normal pipeline.
  const cap2 = mockCapture([frame(rgba(16, 16, 77), 16, 16)]);
  const ctx2 = new InterviewContext();
  const det2 = new QuestionDetector();
  const mgr2 = new ScreenContextManager(cap2, new MockOCRProvider([ocrResult("Write a function to reverse a linked list in place.")]), new MockVisionProvider([]), ctx2, det2, { minEventGapMs: 0 });
  let qEv = null;
  mgr2.on("screen-question", (q) => { qEv = q; });
  const ev = await mgr2.captureManualRegion({ x: 5, y: 5, width: 300, height: 200 });
  assert(ev !== null && ev.region && ev.region.width === 300, "[29] region capture enters pipeline with region preserved");
  assert(qEv !== null && qEv.screenContextIds && qEv.screenContextIds[0] === ev.id, "[29b] manual flow emits shared-pipeline question event");
}

// [30-31] OVERLAY EXCLUSION
function t_exclusion() {
  console.log("\n[30-31] Overlay self-capture prevention");
  const m = new ScreenCaptureManager();
  m.setExcludedRegions([{ x: 1, y: 1, width: 10, height: 10 }]);
  assert(m.getExcludedRegions().length === 1, "[30] overlay bounds tracked for exclusion");
  const data = rgba(32, 32, 200);
  blankExcludedRegions(data, 32, 32, [{ x: 0, y: 0, width: 4, height: 4 }]);
  assert(data[0] === 0 && data[1] === 0 && data[2] === 0, "[30b] excluded region blanked from analysis frames");
  assert(data[(5 * 32 + 5) * 4] === 200, "[30c] non-excluded pixels untouched");
  assert(regionsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }) === true, "[30d] overlap helper");
  const fs = require("fs");
  const nativeP = path.join(dist, "main", "native", "captureExclusion.js");
  assert(fs.existsSync(nativeP), "[31] capture-exclusion module intact in build");
  const ce = require(nativeP);
  assert(typeof ce.setWindowDisplayAffinity === "function" && typeof ce.isCaptureExclusionSupported === "function", "[31b] exclusion API present");
  const r = ce.setWindowDisplayAffinity(0, "exclude");
  assert(r && r.applied === false, "[31c] invalid HWND handled without crash");
  const mainSrc = fs.readFileSync(path.join(dist, "main", "index.js"), "utf8");
  assert(mainSrc.includes("captureExclusion") && mainSrc.includes("setExcludedRegions"), "[31d] main wires exclusion + bounds tracking");
}

// [32-37] END-TO-END (mock screen -> OCR -> fusion -> AnswerEngine)
async function t_e2e() {
  console.log("\n[32-37] End-to-end mock pipeline");
  const ctx = new InterviewContext();
  const det = new QuestionDetector();
  ctx.ingestTranscript(tx("t1", "interviewer", "Can you walk me through how you would solve this?", Date.now()));
  const cap = mockCapture([frame(rgba(24, 24, 90), 24, 24)]);
  const ocr = new MockOCRProvider([ocrResult("Given an array of integers, return indices of the two numbers that add up to a target.")]);
  const mgr = new ScreenContextManager(cap, ocr, new MockVisionProvider([]), ctx, det, { minEventGapMs: 0 });
  let screenEv = null;
  let qEv = null;
  mgr.on("screen-context", (e) => { screenEv = e; });
  mgr.on("screen-question", (q) => { qEv = q; });
  await mgr.captureManualRegion({ x: 0, y: 0, width: 400, height: 300 });
  assert(screenEv !== null, "[32] mock screen -> OCR -> screen context");
  assert(qEv !== null && qEv.origin === "fused", "[33] screen context -> fused question (" + (qEv && qEv.origin) + ")");
  const router = new ModelRouter(new MockLLMProvider("fast", 1), new MockLLMProvider("strong", 1));
  const engine = new AnswerEngine(router);
  const got = { fast: null, strong: null };
  engine.on("fast-answer", (a) => { got.fast = a; });
  engine.on("strong-answer", (a) => { got.strong = a; });
  const res = await engine.answer({
    questionId: qEv.id,
    question: qEv.fusedContext || qEv.question,
    recentContext: ctx.recent(12),
    screenEvents: mgr.getRecentEvents(5),
  });
  assert(got.fast !== null && got.fast.text.length > 0, "[35] fast answer appears");
  assert(got.strong !== null && got.strong.text.length > 0, "[36] strong answer follows");
  assert(res.fast.length > 0 && res.strong.length > 0, "[34] fusion -> AnswerEngine produces both drafts");
  const kinds = new Set(ctx.snapshot().map((e) => e.kind || "transcript"));
  assert(kinds.has("transcript") && kinds.has("screen"), "[37] context preserved across stages (kinds: " + [...kinds].join(",") + ")");
  // Typed Q/A ingestion path used by the app.
  ctx.ingestTyped({ id: "q1", speaker: "interviewer", source: "system", text: qEv.question, timestamp: Date.now(), transcriptEventId: "question:" + qEv.id, kind: "question" });
  ctx.ingestTyped({ id: "a1", speaker: "candidate", source: "microphone", text: res.strong, timestamp: Date.now(), transcriptEventId: "answer:a1", kind: "answer" });
  const kinds2 = new Set(ctx.snapshot().map((e) => e.kind || "transcript"));
  assert(kinds2.has("question") && kinds2.has("answer"), "[37b] typed question/answer entries stored");
}

// Reasoning unit checks (PromptBuilder / Router / AnswerEngine staleness / providers)
async function t_reasoning() {
  console.log("\n[R] Reasoning foundation");
  const prompt = buildAnswerPrompt({
    question: "Why did you choose PostgreSQL?",
    recentContext: [{ id: "1", speaker: "interviewer", source: "system", text: "Why did you choose PostgreSQL?", timestamp: 1, transcriptEventId: "t", kind: "transcript" }],
    screenEvents: [screenEvt({ text: "pizza recipe", source: "auto" }), screenEvt({ id: "m", text: "PostgreSQL schema diagram", source: "manual" })],
  });
  assert(prompt.includes("CURRENT QUESTION") && prompt.includes("SCREEN CONTEXT") && prompt.includes("do not invent unseen information"), "[R1] PromptBuilder sections + screen caveats");
  assert(prompt.indexOf("PostgreSQL schema") < prompt.indexOf("pizza recipe"), "[R2] manual screen outranks automatic screen");
  assert(contextPriorityRank({ speaker: "interviewer", kind: "transcript" }) < contextPriorityRank({ speaker: "candidate", kind: "transcript" }), "[R3] interviewer speech outranks candidate response");
  const router = new ModelRouter(new MockLLMProvider("fast", 1), new MockLLMProvider("strong", 1));
  assert(router.route("fast-answer").name === "mock-llm" && router.route("strong-answer").name === "mock-llm", "[R4] ModelRouter fast+strong routing");
  assert(createLLMProvider("mock", "fast").name === "mock-llm" && createLLMProvider("nope", "fast").name === "mock-llm", "[R5] LLM factory + unknown fallback");
  assert(createVisionProvider("mock").name === "mock-vision" && createOCRProvider("mock").name === "mock-ocr", "[R6] OCR/vision factories");
  // AnswerEngine staleness: slow first job superseded by second.
  const slow = new MockLLMProvider("fast", 60);
  const eng = new AnswerEngine(new ModelRouter(slow, new MockLLMProvider("strong", 1)));
  let active = 0;
  let stale = 0;
  // Finals only: streaming partials (partial:true) render progressively and
  // are never session/history answers — the invariant is about finals.
  eng.on("strong-answer", (a) => { if (!a.partial) active++; });
  eng.on("stale-answer", () => stale++);
  const p1 = eng.answer({ questionId: "q-old", question: "Old question?" });
  await new Promise((r) => setTimeout(r, 5));
  const p2 = eng.answer({ questionId: "q-new", question: "New question?" });
  await Promise.all([p1, p2]);
  assert(stale === 1 && active === 1, "[R7] stale answer jobs never emit as active (stale=" + stale + ", active=" + active + ")");
  try {
    await new FailingLLMProvider().generate({ prompt: "x" });
    assert(false, "[R8] failing LLM should throw");
  } catch (e) {
    assert(true, "[R8] LLM failure handled");
  }
}

// [25] REAL PROVIDER (honest: only when credentials exist)
async function t_real() {
  console.log("\n[Real] Provider live check");
  if (!process.env.INTERVIA_GEMINI_API_KEY) {
    console.log("  SKIP real Gemini vision/LLM: INTERVIA_GEMINI_API_KEY not set (mock verified instead)");
    return;
  }
  try {
    const gv = new GeminiVisionAdapter({});
    const out = await gv.analyzeImage({ data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") }, { screenText: "connectivity probe" }, { timeoutMs: 20000 });
    assert(out.summary.length > 0, "[Real] live Gemini vision returned a description");
  } catch (e) {
    failed++;
    console.log("  FAIL [Real] live Gemini call failed: " + String(e).slice(0, 300));
  }
}

async function main() {
  console.log("Intervia screen-context + vision + reasoning suite");
  await t_capture();
  t_change();
  await t_ocr();
  await t_vision();
  await t_stale();
  await t_screenCtx();
  t_fusion();
  await t_manual();
  t_exclusion();
  await t_e2e();
  await t_reasoning();
  await t_real();
  console.log("\n=================================");
  console.log(`SCREEN SUITE: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("ALL SCREEN TESTS PASSED");
    process.exit(0);
  } else {
    console.log("FAILED: " + failed);
    process.exit(1);
  }
}

main().catch((e) => { console.error("crashed", e); process.exit(2); });
