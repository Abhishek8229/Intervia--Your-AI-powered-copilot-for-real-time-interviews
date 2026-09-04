/* eslint-disable */
// Targeted screen-reading suite: cleaned OCR first, code preservation,
// chrome extraction, gated Gemini vision (no per-frame uploads).
const path = require("path");
const dist = path.resolve(__dirname, "..", "dist");

const { cleanOcrText, isCodeTokenLine, createOCRProvider } = require(path.join(dist, "main", "screen", "ocr.js"));
const { GeminiVisionAdapter, MockVisionProvider, toVisionResult } = require(path.join(dist, "main", "screen", "vision.js"));
const { ScreenContextManager, ocrLooksLossy } = require(path.join(dist, "main", "screen", "ScreenContextManager.js"));
const { classifyScreenContent, extractRelevantScreenContent } = require(path.join(dist, "main", "screen", "QuestionContextFusion.js"));
const { InterviewContext } = require(path.join(dist, "main", "conversation", "InterviewContext.js"));
const { QuestionDetector } = require(path.join(dist, "main", "conversation", "QuestionDetector.js"));

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function rgba(w, h, fill) {
  const b = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { b[i * 4] = fill; b[i * 4 + 1] = fill; b[i * 4 + 2] = fill; b[i * 4 + 3] = 255; }
  return b;
}
function frame(data, w, h) {
  return { id: "f", width: w, height: h, data, encoding: "rgba", timestamp: Date.now(), source: { kind: "display", id: "d" } };
}
function ocrResult(text, confidence) {
  return { text, blocks: text ? [{ text }] : [], confidence: text ? (confidence ?? 0.9) : 0, timestamp: Date.now() };
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
function mgrWith(cap, ocrTexts, vision, opts, confidences) {
  const { MockOCRProvider } = require(path.join(dist, "main", "screen", "ocr.js"));
  const ocr = new MockOCRProvider(ocrTexts.map((t, n) => ocrResult(t, confidences && confidences[n])));
  return new ScreenContextManager(cap, ocr, vision, new InterviewContext(), new QuestionDetector(), { minEventGapMs: 0, ...(opts || {}) });
}

async function main() {
  console.log("Intervia screen-reading suite (local OCR first, gated vision)");

  // [1] Code structure survives cleanup; real noise still drops.
  {
    const raw = ["function solve(nums) {", "    if (a == b) {", "        return a != c;", "    }", "}", "=>", "->", ";", "|", "...", "bcdfghjklmnpqrstvwxyz"].join("\n");
    const out = cleanOcrText(raw);
    for (const keep of ["function solve(nums) {", "if (a == b) {", "return a != c;", "}", "=>", "->", ";"]) {
      assert(out.includes(keep), "code preserved: " + JSON.stringify(keep));
    }
    assert(!out.split("\n").some((l) => l.trim() === "|"), "stray pipe still dropped");
    assert(!out.includes("...") && !out.includes("bcdfghjklmnpqrstvwxyz"), "ellipsis + alpha-soup still dropped");
    assert(isCodeTokenLine("{") && isCodeTokenLine("==") && isCodeTokenLine("=>") && !isCodeTokenLine("|"), "code-token classifier");
  }

  // [2] Chrome extraction keeps the problem, drops the platform UI.
  {
    const screen = ["Welcome to HackerRank", "Candidate: John", "Problem:", "Given an array of integers, return indices of the two numbers that add up to a target.", "Constraints:", "2 <= nums.length <= 10^4", "Submit", "Timer: 12:34", "Next"].join("\n");
    const r = extractRelevantScreenContent(screen);
    assert(r.relevantText.includes("Given an array of integers") && r.relevantText.includes("Constraints"), "problem + constraints kept");
    assert(!r.relevantText.includes("HackerRank") && !r.relevantText.includes("Candidate:") && !r.relevantText.includes("Submit") && !/Timer/.test(r.relevantText) && !/^Next$/m.test(r.relevantText), "platform chrome dropped");
    assert(r.droppedChrome === true && r.contentType === "coding-problem", "chrome flagged + typed coding-problem (got " + r.contentType + ")");
    const behavioral = extractRelevantScreenContent(["Amazon interview", "Round 2", "Tell me about a time you disagreed with a teammate.", "Next", "Timer: 12:34"].join("\n"));
    assert(behavioral.relevantText.includes("disagreed with a teammate") && !behavioral.relevantText.includes("Amazon"), "behavioral question extracted");
    assert(behavioral.contentType === "interview-question", "typed interview-question (got " + behavioral.contentType + ")");
    const chromeOnly = extractRelevantScreenContent("Submit\nNext\nTimer: 01:00");
    assert(chromeOnly.relevantText === "" && chromeOnly.contentType === "irrelevant-ui", "chrome-only screen is irrelevant-ui");
    assert(classifyScreenContent("System overview: client -> load balancer -> api servers -> postgres with read replicas, redis cache.") === "system-design", "diagram-ish text typed system-design");
  }

  // [3] Manager emits CLEANED text (dups joined, hyphen fixed), not raw OCR.
  {
    const cap = mockCapture([frame(rgba(16, 16, 50), 16, 16)]);
    const raw = "How would you design a\nscalable payment\nscalable payment\nsystem?\nTell me about experi-\nence with Postgres";
    const m = mgrWith(cap, [raw], new MockVisionProvider([]), {});
    const e = await m.captureManualRegion({ x: 0, y: 0, width: 50, height: 50 });
    assert(e !== null, "cleaned OCR still emits an event");
    assert(e.text.includes("scalable payment system?") && (e.text.match(/scalable payment/g) || []).length === 1, "duplicate OCR lines collapsed");
    assert(e.text.includes("experience with Postgres"), "hyphen break joined before detection");
  }

  // [4] Vision is gated: local mode never uploads, even for diagrams.
  {
    const cap = mockCapture([frame(rgba(16, 16, 50), 16, 16)]);
    let calls = 0;
    const vision = new MockVisionProvider([]);
    vision.remote = true;
    const orig = vision.analyzeImage.bind(vision);
    vision.analyzeImage = async (img, ctx, opts) => { calls++; return orig(img, ctx, opts); };
    const m = mgrWith(cap, ["client -> load balancer -> api servers -> postgres primary with read replicas"], vision, { visionMode: "local" });
    await m.captureNow();
    assert(calls === 0, "local vision mode performs no remote vision call");
  }

  // [5] Well-extracted code stays local; lossy code may use vision.
  {
    const goodCode = ["function twoSum(nums, target) {", "    const seen = new Map();", "    for (let i = 0; i < nums.length; i++) {", "        if (seen.has(target - nums[i])) {", "            return [seen.get(target - nums[i]), i];", "        }", "        seen.set(nums[i], i);", "    }", "}"].join("\n");
    const cap = mockCapture([frame(rgba(16, 16, 50), 16, 16)]);
    let calls = 0;
    const vision = new MockVisionProvider([]);
    vision.remote = true;
    const orig = vision.analyzeImage.bind(vision);
    vision.analyzeImage = async (img, ctx, opts) => { calls++; return orig(img, ctx, opts); };
    const m = mgrWith(cap, [goodCode], vision, { visionMode: "remote" }, [0.9]);
    await m.captureNow();
    assert(calls === 0, "good OCR code does not trigger vision");
    assert(ocrLooksLossy(goodCode, 0.9) === false, "good code not classified lossy");
    const cap2 = mockCapture([frame(rgba(16, 16, 50), 16, 16)]);
    let calls2 = 0;
    const vision2 = new MockVisionProvider([]);
    vision2.remote = true;
    const orig2 = vision2.analyzeImage.bind(vision2);
    vision2.analyzeImage = async (img, ctx, opts) => { calls2++; return orig2(img, ctx, opts); };
    const m2 = mgrWith(cap2, ["function twoSum(nums, target) {\nconst seen new Map\nloop through nums once"], vision2, { visionMode: "remote" }, [0.1]);
    await m2.captureNow();
    assert(calls2 >= 1, "low-confidence code OCR falls back to vision");
    assert(ocrLooksLossy("plain prose line one\nplain prose line two\nplain prose line three\nplain prose line four", 0.9) === true, "structureless text flagged lossy");
  }

  // [6] Gemini Vision reuses the shared Gemini configuration.
  {
    const keepModel = process.env.INTERVIA_GEMINI_MODEL;
    const keepKey = process.env.INTERVIA_GEMINI_API_KEY;
    delete process.env.INTERVIA_GEMINI_MODEL;
    delete process.env.INTERVIA_VISION_MODEL;
    delete process.env.INTERVIA_GEMINI_API_KEY;
    const dflt = new GeminiVisionAdapter({});
    assert(dflt.model === "gemini-2.5-flash" && dflt.isAvailable() === false, "flash default without key, unavailable honestly");
    process.env.INTERVIA_GEMINI_MODEL = "test-flash-x";
    process.env.INTERVIA_GEMINI_API_KEY = "TESTKEY-1";
    const custom = new GeminiVisionAdapter({});
    assert(custom.model === "test-flash-x" && custom.isAvailable() === true, "shared Gemini model/key reused (no separate key system)");
    if (keepModel === undefined) delete process.env.INTERVIA_GEMINI_MODEL; else process.env.INTERVIA_GEMINI_MODEL = keepModel;
    if (keepKey === undefined) delete process.env.INTERVIA_GEMINI_API_KEY; else process.env.INTERVIA_GEMINI_API_KEY = keepKey;
  }

  // [7] Structured vision output (contentType/needsAnswer/code/diagram).
  {
    const vr = toVisionResult("gemini-vision", JSON.stringify({ summary: "Two-sum solution", visibleText: "code editor", detectedQuestion: "Implement two-sum.", code: { language: "javascript", text: "function twoSum() {}" }, confidence: 0.9 }));
    assert(vr.code && vr.code.text.includes("twoSum") && vr.contentType === "coding-problem" && vr.needsAnswer === true, "code result structured + typed");
    const d = toVisionResult("gemini-vision", JSON.stringify({ summary: "3-tier service diagram", diagramDescription: "client -> api -> postgres", confidence: 0.8 }));
    assert(d.diagramDescription && d.diagramDescription.includes("postgres") && d.contentType === "system-design", "diagram result structured");
    const raw = toVisionResult("t", "not json at all");
    assert(raw.summary.length > 0 && raw.confidence === 0.4 && typeof raw.contentType === "string", "raw-text fallback still structured");
  }

  // [8] Tesseract is the default local OCR path; missing binary is honest.
  {
    const keep = process.env.INTERVIA_OCR_PROVIDER;
    delete process.env.INTERVIA_OCR_PROVIDER;
    const p = createOCRProvider(undefined);
    assert(p.name === "tesseract", "default OCR provider is tesseract (got " + p.name + ")");
    if (keep === undefined) delete process.env.INTERVIA_OCR_PROVIDER; else process.env.INTERVIA_OCR_PROVIDER = keep;
  }

  console.log("\n=================================");
  console.log(`SCREEN-READING SUITE: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log("ALL SCREEN-READING TESTS PASSED"); process.exit(0); }
  else { console.log("FAILED: " + failed); process.exit(1); }
}

main().catch((e) => { console.error("crashed", e); process.exit(2); });
