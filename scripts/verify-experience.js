/* eslint-disable */
// Targeted interview-experience suite: fresh-start state, spoken prompt
// shaping, speaker guards. Deterministic, no keys, no network.
const path = require("path");
const dist = path.resolve(__dirname, "..", "dist");

const { ScreenContextManager } = require(path.join(dist, "main", "screen", "ScreenContextManager.js"));
const { MockOCRProvider } = require(path.join(dist, "main", "screen", "ocr.js"));
const { MockVisionProvider } = require(path.join(dist, "main", "screen", "vision.js"));
const { InterviewContext } = require(path.join(dist, "main", "conversation", "InterviewContext.js"));
const { QuestionDetector } = require(path.join(dist, "main", "conversation", "QuestionDetector.js"));
const PB = require(path.join(dist, "main", "reasoning", "PromptBuilder.js"));

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
function ocrResult(text) {
  return { text, blocks: text ? [{ text }] : [], confidence: text ? 0.9 : 0, timestamp: Date.now() };
}

async function main() {
  console.log("Intervia interview-experience suite");

  // [1] Fresh-start reset: identical screen content emits again after reset.
  {
    const cap = {
      async capturePrimaryDisplay() { return { id: "f", width: 16, height: 16, data: rgba(16, 16, 50), encoding: "rgba", timestamp: Date.now(), source: { kind: "display", id: "d" } }; },
      async captureRegion(r) { const f = await this.capturePrimaryDisplay(); return { ...f, region: { ...r } }; },
      startMonitoring() {}, stopMonitoring() {}, isMonitoring() { return false; }, cancelPending() {},
    };
    const text = "Tell me about a time you showed leadership under a tight deadline?";
    const m = new ScreenContextManager(cap, new MockOCRProvider([ocrResult(text), ocrResult(text)]), new MockVisionProvider([]), new InterviewContext(), new QuestionDetector(), { minEventGapMs: 0, dedupeWindowMs: 60000 });
    const first = await m.captureNow();
    const suppressed = await m.captureNow();
    assert(first !== null && suppressed === null, "repeat screen suppressed within an interview");
    m.resetHistory();
    const afterReset = await m.captureNow();
    assert(afterReset !== null, "resetHistory clears dedup for a fresh interview");
    assert(typeof m.resetHistory === "function" && m.getRecentEvents(10).length === 1, "recent screen events cleared on reset");
  }

  // [2] Speaker guard: candidate finals never become questions.
  {
    const det = new QuestionDetector();
    let emitted = 0;
    det.on("question", () => emitted++);
    const r = det.handle({ id: "t1", text: "Tell me about your experience with React?", isFinal: true, source: "microphone", speaker: "candidate", timestamp: Date.now(), confidence: 1 }, []);
    assert(r === null && emitted === 0, "candidate speech never triggers an answer");
    const partial = det.handle({ id: "t2", text: "What is Kubernetes?", isFinal: false, source: "system", speaker: "interviewer", timestamp: Date.now(), confidence: 1 }, []);
    assert(partial === null && emitted === 0, "partial transcripts never trigger an answer");
  }

  // [3] Spoken style: first-person, no assistant preamble.
  {
    const p = PB.buildAnswerPrompt({ question: "Tell me about yourself.", recentContext: [], screenEvents: [], candidateMode: "real" });
    assert(/Speak as 'I'/.test(p), "first-person spoken guidance present");
    for (const banned of ["As an AI language model", "Based on your resume", "According to the provided context", "comprehensive answer"]) {
      assert(!p.includes(banned), "no assistant preamble: " + JSON.stringify(banned));
    }
    assert(/4-8 spoken sentences/.test(p), "medium length contract intact");
  }

  // [4] Per-type shaping: coding + system-design practical, general neutral.
  {
    const coding = PB.buildAnswerPrompt({ question: "Implement LRU.", questionType: "coding", recentContext: [], screenEvents: [] });
    assert(/approach/i.test(coding) && /complexity/i.test(coding), "coding shaping: approach + complexity");
    const design = PB.buildAnswerPrompt({ question: "Design X.", questionType: "system_design", recentContext: [], screenEvents: [] });
    assert(/trade-?offs/i.test(design), "system-design shaping: trade-offs");
    const general = PB.buildAnswerPrompt({ question: "Why this role?", questionType: "general", recentContext: [], screenEvents: [] });
    assert(/exact question asked/.test(general), "general shaping stays neutral");
    const short = PB.buildAnswerPrompt({ question: "Q?", recentContext: [], screenEvents: [], answerLength: "short" });
    assert(/2-4 spoken sentences/.test(short), "short length contract intact");
  }

  console.log("\n=================================");
  console.log(`EXPERIENCE SUITE: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log("ALL EXPERIENCE TESTS PASSED"); process.exit(0); }
  else { console.log("FAILED: " + failed); process.exit(1); }
}

main().catch((e) => { console.error("crashed", e); process.exit(2); });
